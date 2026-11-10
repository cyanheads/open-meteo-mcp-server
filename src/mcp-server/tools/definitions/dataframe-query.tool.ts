/**
 * @fileoverview Tool: openmeteo_dataframe_query — run read-only SQL against a staged canvas.
 * @module mcp-server/tools/definitions/dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { config } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createCounter, escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { getCanvas } from '@/services/canvas-accessor.js';
import { ROW_DATA_CEILING_CHARS, rowsWithinCeiling } from '../row-data-ceiling.js';

/** Rows a call returns when it passes no `limit`, unless the per-call cap is lower. */
const DEFAULT_LIMIT = 25;

/**
 * Most rows one call returns, whatever `limit` asks for. The data query asks the canvas
 * for no more than the page, so a large result is never materialized just to be sliced;
 * the exact total comes from a separate `COUNT(*)` over the caller's SQL.
 */
const MAX_LIMIT = 10_000;

/**
 * The per-call cap: {@link MAX_LIMIT}, or the canvas's own row cap when that is lower,
 * since the canvas refuses a `rowLimit` above it. Read per call and per schema emission,
 * so the advertised maximum and the applied cap come from the same configuration.
 */
function limitCap(): number {
  return Math.min(MAX_LIMIT, config.canvas.defaultRowLimit);
}

/**
 * The `limit` a call gets when it passes none: {@link DEFAULT_LIMIT}, or the cap when
 * that is lower, so the advertised default is never a value the cap rejects or lowers.
 */
function defaultLimit(): number {
  return Math.min(DEFAULT_LIMIT, limitCap());
}

function limitDescription(): string {
  const cap = limitCap().toLocaleString('en-US');
  const bound = getServerConfig().clampLimits
    ? `Default ${defaultLimit()}; a larger value returns at most ${cap} rows and says so.`
    : `Default ${defaultLimit()}, at most ${cap}.`;
  return `Rows to return: the page size. ${bound} Rows come back whole, so a page's size rests on limit and on the columns the SQL selects: from a member-suffixed ensemble table, select only the columns the question needs. A page over ${CEILING_LABEL} fails as result_too_large rather than being cut. A LIMIT in the SQL still applies; the page holds the smaller of the two.`;
}

/** Calls whose `limit` was lowered to the cap. */
const limitClamped = createCounter(
  'openmeteo.dataframe_query.limit_clamped',
  'openmeteo_dataframe_query calls whose limit was lowered to the per-call cap',
  '{calls}',
);

/**
 * Longest the `COUNT(*)` behind an exact `row_count` may run. The count re-executes the
 * caller's SQL in full, where the data query stops after its page of rows, so a result
 * that streams its first rows instantly can take minutes to count. Past this budget the
 * response keeps its rows and reports the lower bound with `count_error: count_timeout`.
 */
const COUNT_BUDGET_MS = 5_000;

/** Paging advice both the notice and the `rows` description carry. */
const PAGE_ORDER =
  'Page under an ORDER BY: without one, DuckDB guarantees no row order between calls.';

/** The response ceiling as the descriptions and the `result_too_large` messages state it. */
const CEILING_LABEL = `${ROW_DATA_CEILING_CHARS.toLocaleString('en-US')} characters of row data`;

/** Recovery for a page whose first row alone is over the ceiling, where a lower limit cannot help. */
const RETURN_LESS_PER_ROW =
  'Return less per row: select fewer columns, shorten long strings with left() or substr(), trim long lists with list_slice(), or aggregate.';

/** Longest message, or string `data` field, of an engine or framework error this tool relays. */
const MAX_ERROR_TEXT_CHARS = 2_000;

/**
 * `text` held to {@link MAX_ERROR_TEXT_CHARS}: as it is when it fits, otherwise its head
 * and a marker naming the cut and the full length, the two together within the bound.
 * The cut never splits a surrogate pair.
 */
function cutErrorText(text: string): string {
  if (text.length <= MAX_ERROR_TEXT_CHARS) return text;
  const marker = ` … (cut to ${MAX_ERROR_TEXT_CHARS.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters)`;
  let end = MAX_ERROR_TEXT_CHARS - marker.length;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end) + marker;
}

/**
 * `err` with its message and each string `data` field held to {@link MAX_ERROR_TEXT_CHARS},
 * keeping its code, `data.reason`, and every other field; `err` itself when nothing is
 * over. A value that is not an `McpError` passes through.
 */
function boundRelayedError(err: unknown): unknown {
  if (!(err instanceof McpError)) return err;
  const isOver = (value: unknown) =>
    typeof value === 'string' && value.length > MAX_ERROR_TEXT_CHARS;
  const fields = Object.entries(err.data ?? {});
  if (!isOver(err.message) && !fields.some(([, value]) => isOver(value))) return err;
  const data =
    err.data &&
    Object.fromEntries(
      fields.map(([key, value]) => [key, typeof value === 'string' ? cutErrorText(value) : value]),
    );
  return new McpError(err.code, cutErrorText(err.message), data, { cause: err });
}

/** The response fields besides `rows`. */
interface QueryMeta {
  canvas_id: string;
  count_error?: string | undefined;
  row_count: number;
  truncated: boolean;
}

/**
 * Line terminators a table row cannot hold, captured so `split()` keeps them: CRLF, CR,
 * LF, and the line and paragraph separators JavaScript-based parsers also break on.
 */
const LINE_TERMINATOR = /(\r\n|[\r\n\p{Zl}\p{Zp}])/u;

/**
 * Render one header or cell for the markdown table in `format()` so a GFM parse reads
 * back the value `structuredContent` carries, and each table row stays one line with
 * the header's column count.
 *
 * A string goes through `escapeMarkdownInline` as it is, one line at a time, which
 * escapes what could parse as syntax (`|` included) and encodes edge whitespace; each
 * line terminator between the lines becomes its numeric character reference. Structs and
 * lists arrive as real objects and arrays from DuckDB's `getRowObjectsJson()` and render
 * as their compact JSON, escaped the same way. Numbers and booleans render bare, as do
 * BIGINT, DATE, and TIMESTAMP, which arrive pre-marshaled as strings. The empty string
 * renders as `""` so it stays distinct from null, which is an empty cell.
 */
function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value === '') return '""';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text
    .split(LINE_TERMINATOR)
    .map((part, i) =>
      i % 2 === 1
        ? [...part].map((ch) => `&#${ch.codePointAt(0)};`).join('')
        : escapeMarkdownInline(part),
    )
    .join('');
}

function tableLine(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function rowLine(headers: readonly string[], row: Record<string, unknown>): string {
  return tableLine(headers.map((h) => renderCell(row[h])));
}

function totalLabel(meta: QueryMeta): string {
  return meta.count_error === undefined ? String(meta.row_count) : `at least ${meta.row_count}`;
}

/**
 * The continuation notice for a page of `shown` rows, or undefined when the page is the
 * whole result. A truncated page is always a full one, so `shown` is also the limit the
 * call applied.
 */
function continuationNotice(meta: QueryMeta, shown: number): string | undefined {
  if (!meta.truncated) return;
  return `_Showing first ${shown} of ${totalLabel(meta)} rows (limit ${shown}). Continue at OFFSET ${shown}: re-issue the SQL with LIMIT / OFFSET, adding ${shown} to any OFFSET it already applies and subtracting it from any LIMIT. ${PAGE_ORDER}_`;
}

/** `content[0].text` for a non-empty result. */
function renderText(
  meta: QueryMeta,
  headers: readonly string[],
  rowLines: readonly string[],
  shown: number,
): string {
  const rows =
    meta.count_error === undefined
      ? totalLabel(meta)
      : `${totalLabel(meta)} (the full result could not be counted: ${meta.count_error})`;
  const lines = [
    '## DataCanvas query result',
    `**Canvas:** \`${meta.canvas_id}\` | **Rows:** ${rows} | **Truncated:** ${meta.truncated}`,
    '',
    tableLine(headers.map(renderCell)),
    tableLine(headers.map(() => '---')),
    ...rowLines,
  ];
  const notice = continuationNotice(meta, shown);
  if (notice) lines.push('', notice);
  return lines.join('\n');
}

export const openmeteoDataframeQueryTool = tool('openmeteo_dataframe_query', {
  description: `Run a read-only SQL SELECT against tables staged on a DataCanvas by openmeteo_get_forecast, openmeteo_get_historical, openmeteo_get_marine, openmeteo_get_air_quality, openmeteo_get_ensemble, openmeteo_get_flood, or openmeteo_get_climate. Pass the canvas_id returned when any of those tools spills (truncated: true), and reference the exact table_name those tools return alongside it. Call openmeteo_dataframe_describe to list staged tables and their columns when you need to discover names. Returns the first limit rows (default ${DEFAULT_LIMIT}, or the per-call row cap when that is lower), each whole, plus row_count — exact, or a lower bound flagged by count_error when counting fails or runs past 5 seconds; page the rest with LIMIT / OFFSET. A page's size rests on limit and the columns selected, so from a member-suffixed ensemble table select the columns the question needs rather than SELECT *. One response carries at most ${CEILING_LABEL} (its rows written as JSON, a character that needs escaping counted at its escaped length), and a page over that fails as result_too_large rather than being cut. An error message relayed from the query engine is cut to ${MAX_ERROR_TEXT_CHARS.toLocaleString('en-US')} characters.`,
  annotations: { readOnlyHint: true },

  errors: [
    {
      reason: 'canvas_not_enabled',
      code: JsonRpcErrorCode.InternalError,
      when: 'CANVAS_PROVIDER_TYPE is not set to duckdb.',
      recovery: 'Set CANVAS_PROVIDER_TYPE=duckdb and restart the server to enable DataCanvas.',
      retryable: false,
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id is unknown or has expired under its 24 h sliding TTL.',
      recovery:
        'Re-run openmeteo_get_forecast, openmeteo_get_historical, openmeteo_get_marine, openmeteo_get_air_quality, openmeteo_get_ensemble, openmeteo_get_flood, or openmeteo_get_climate to stage a fresh canvas, then retry.',
      retryable: false,
    },
    {
      reason: 'system_catalog_access',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL references a system catalog such as information_schema, sqlite_master, pg_catalog, or a duckdb_*() function.',
      recovery:
        'List tables and columns with openmeteo_dataframe_describe instead — system catalogs are blocked so callers cannot enumerate other staged canvases.',
      retryable: false,
    },
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'The SQL references a table that is not staged on this canvas — a mistyped name, or one that expired (24 h sliding TTL) or was dropped.',
      recovery:
        'List the staged tables and columns with openmeteo_dataframe_describe, then reference an existing name — or re-run openmeteo_get_forecast, openmeteo_get_historical, openmeteo_get_marine, openmeteo_get_air_quality, openmeteo_get_ensemble, openmeteo_get_flood, or openmeteo_get_climate to stage a fresh canvas.',
      retryable: false,
    },
    {
      reason: 'result_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: `The page holds more than ${CEILING_LABEL} (its rows written as JSON, a character that needs escaping counted at its escaped length), the most one response carries, and rows are never cut.`,
      recovery:
        'Return less in one call: select fewer columns, shorten long strings with left() or substr(), trim long lists with list_slice(), or aggregate. When the message says how many leading rows fit, set limit to that number instead.',
      retryable: false,
    },
  ],

  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'Canvas ID returned by openmeteo_get_forecast, openmeteo_get_historical, openmeteo_get_marine, openmeteo_get_air_quality, openmeteo_get_ensemble, openmeteo_get_flood, or openmeteo_get_climate when truncated: true.',
    ),
    sql: z
      .string()
      .describe(
        "Read-only SELECT statement. Reference table names from openmeteo_dataframe_describe; in the examples below, replace <table_name> with a staged table and <column> with one of its columns. time is ISO 8601 text — YYYY-MM-DDTHH:MM on hourly rows, YYYY-MM-DD on daily rows — as are daily sunrise and sunset, so date functions need a cast: CAST(time AS TIMESTAMP). WHERE time LIKE '%T%' selects the hourly rows of a table that holds both cadences. Monthly means: `SELECT strftime(CAST(time AS TIMESTAMP), '%Y-%m') AS month, AVG(<column>) AS mean FROM <table_name> GROUP BY month ORDER BY month`. An openmeteo_get_ensemble table carries one column per member (precipitation_member01, precipitation_member02, …) beside the unsuffixed control run; count members per row with `SELECT time, list_count(list_filter([*COLUMNS('^precipitation_member\\d+$')], lambda x: x > 0.5)) AS members_over, list_count([*COLUMNS('^precipitation_member\\d+$')]) AS members_reporting FROM <table_name> ORDER BY time` — the anchored pattern leaves out the control column, and members_reporting is the per-row denominator, since rows past a model's last forecast hour carry no member values. Write lambdas with the lambda x: syntax.",
      ),
    /**
     * Both the advertised `maximum` and the description are getters, read each time the
     * schema is emitted, the default is a function read then and at parse time, and the
     * strict-mode bound is a `.check()` read at parse time — so all four follow the
     * configuration rather than its state at import. A bare
     * `.int()` would advertise `Number.MAX_SAFE_INTEGER` as the maximum; the getter's
     * `undefined` while clamping leaves no maximum at all.
     */
    limit: z
      .number()
      .int()
      .min(1)
      .check((ctx) => {
        const cap = limitCap();
        if (!getServerConfig().clampLimits && ctx.value > cap) {
          ctx.issues.push({
            code: 'too_big',
            origin: 'number',
            maximum: cap,
            inclusive: true,
            input: ctx.value,
          });
        }
      })
      .meta({
        get maximum() {
          return getServerConfig().clampLimits ? undefined : limitCap();
        },
        get description() {
          return limitDescription();
        },
      })
      .default(defaultLimit),
  }),

  output: z.object({
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        `Leading result rows, at most limit, each whole: values are never cut. When row_count exceeds rows.length, continue by re-issuing the SQL with OFFSET <rows.length>, added to any OFFSET it already applies, with any LIMIT reduced by the same amount. ${PAGE_ORDER}`,
      ),
    row_count: z
      .number()
      .describe(
        'Exact number of rows in the full result. When count_error is present, the total could not be counted and this is a lower bound: the rows the query confirmed exist.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when the full result holds more rows than this page, so row_count exceeds rows.length; continue as the rows description says. False when rows is the whole result.',
      ),
    count_error: z
      .string()
      .optional()
      .describe(
        'Present only when counting the full result failed after its rows were read — the failure reason (e.g. sql_execution_error, or count_timeout when counting ran past 5 seconds). The rows are still valid; row_count is then a lower bound.',
      ),
    canvas_id: z.string().describe('Canvas ID that was queried.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present only when limit was above the per-call row cap: names the requested and the applied limit.',
      ),
  },

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail(
        'canvas_not_enabled',
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb and restart.',
      );
    }

    // Rethrow the framework's acquire() NotFound under the tool's own contract —
    // its generic "omit canvas_id" guidance is wrong here (canvas_id is required
    // and this tool never creates canvases).
    const instance = await canvas.acquire(input.canvas_id, ctx).catch((err: unknown) => {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail(
          'canvas_not_found',
          `Canvas "${input.canvas_id}" not found or expired (24 h sliding TTL).`,
          undefined,
          { cause: err },
        );
      }
      throw err;
    });

    /*
     * In strict mode the schema already rejected an over-cap limit; while clamping, one is
     * lowered here, so the canvas is never asked for more rows than it serves.
     */
    const cap = limitCap();
    const rowLimit = Math.min(input.limit, cap);
    if (rowLimit < input.limit) {
      limitClamped.add(1);
      ctx.log.info('Dataframe query limit lowered to the cap', {
        canvas_id: instance.canvasId,
        requested: input.limit,
        applied: rowLimit,
      });
      ctx.enrich.notice(
        `limit ${input.limit} is above the per-call cap of ${cap} rows, so ${rowLimit} was applied. To read more than ${cap} rows, page with LIMIT / OFFSET in the SQL.`,
      );
    }

    const queryOptions = { signal: ctx.signal, denySystemCatalogs: true };
    // Rewrap the framework's query-level errors under this tool's own contracts so
    // the declared recovery hints reach the wire. The framework's system_catalog_access
    // throw carries no recovery of its own, and its missing_table recovery names
    // framework methods (registerTable()/describe()) instead of this server's tools.
    // Every other McpError (invalid_sql, sql_read_only, denied_function, a TTL-expired
    // canvas_not_found, …) passes through with its original code and data.reason.
    // Every message relayed, and each string data field, is held to 2,000 characters.
    const result = await instance
      .query(input.sql, { ...queryOptions, rowLimit })
      .catch((err: unknown) => {
        if (err instanceof McpError && err.data?.reason === 'system_catalog_access') {
          throw ctx.fail('system_catalog_access', cutErrorText(err.message), undefined, {
            cause: err,
          });
        }
        if (err instanceof McpError && err.data?.reason === 'missing_table') {
          const tableName = err.data.tableName;
          const named =
            typeof tableName === 'string' ? `Table "${tableName}"` : 'The referenced table';
          throw ctx.fail(
            'missing_table',
            cutErrorText(
              `${named} is not staged on canvas "${input.canvas_id}". Use the exact table_name returned by openmeteo_get_forecast, openmeteo_get_historical, openmeteo_get_marine, openmeteo_get_air_quality, openmeteo_get_ensemble, openmeteo_get_flood, or openmeteo_get_climate, or call openmeteo_dataframe_describe to list staged tables. It may also have expired (24 h sliding TTL) or been dropped.`,
            ),
            undefined,
            { cause: err },
          );
        }
        throw boundRelayedError(err);
      });

    // Measured before anything else is built from the page: a refused page runs no count
    // and is never serialized.
    const fit = rowsWithinCeiling(result.rows);
    if (fit < result.rows.length) {
      throw fit === 0
        ? ctx.fail(
            'result_too_large',
            `The first row alone holds more than ${CEILING_LABEL}, the most one response carries, and rows are never cut.`,
            { recovery: { hint: RETURN_LESS_PER_ROW } },
          )
        : ctx.fail(
            'result_too_large',
            `This page of ${result.rows.length} rows holds more than ${CEILING_LABEL}, the most one response carries, and rows are never cut; ${fit === 1 ? 'its first row fits' : `its first ${fit} rows fit`}.`,
            {
              recovery: {
                hint: `Set limit to ${fit} or less and page the rest with LIMIT / OFFSET, or select fewer columns.`,
              },
            },
          );
    }

    // A truncated read means more rows exist than the page fetched; count them with
    // the caller's SQL as a subquery, through the same gate. The data query already
    // succeeded, so a count failure (only cancellation excepted) leaves its rows in
    // place and reports the lower bound the read established — rowLimit + 1 rows exist.
    const meta: QueryMeta = {
      canvas_id: instance.canvasId,
      row_count: result.rowCount,
      truncated: result.truncated === true,
    };
    if (meta.truncated) {
      const countSql = `SELECT COUNT(*) AS n FROM (\n${input.sql.replace(/[\s;]+$/, '')}\n)`;
      const countSignal = AbortSignal.any([ctx.signal, AbortSignal.timeout(COUNT_BUDGET_MS)]);
      await instance.query(countSql, { ...queryOptions, signal: countSignal }).then(
        (count) => {
          meta.row_count = Number(count.rows[0]?.n);
        },
        (err: unknown) => {
          if (ctx.signal.aborted) throw boundRelayedError(err);
          meta.row_count = result.rowCount + 1;
          meta.count_error = countSignal.aborted
            ? 'count_timeout'
            : err instanceof McpError && typeof err.data?.reason === 'string'
              ? err.data.reason
              : 'count_failed';
          ctx.log.warning('Dataframe row count failed; reporting a lower bound', {
            canvas_id: instance.canvasId,
            reason: meta.count_error,
          });
        },
      );
    }

    ctx.log.info('Dataframe query executed', {
      canvas_id: instance.canvasId,
      row_count: meta.row_count,
      page_rows: result.rows.length,
    });

    return { rows: result.rows, ...meta };
  },

  format: (result) => {
    const firstRow = result.rows[0];
    if (!firstRow) {
      return [
        {
          type: 'text',
          text: `## DataCanvas query result\n**Canvas:** \`${result.canvas_id}\` | **Rows:** ${result.row_count} | **Truncated:** ${result.truncated}\n\n_No rows returned._`,
        },
      ];
    }
    const headers = Object.keys(firstRow);
    const rowLines = result.rows.map((row) => rowLine(headers, row));
    return [{ type: 'text', text: renderText(result, headers, rowLines, result.rows.length) }];
  },
});
