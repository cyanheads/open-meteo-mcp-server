/**
 * @fileoverview Tool: openmeteo_dataframe_query — run read-only SQL against a staged canvas.
 * @module mcp-server/tools/definitions/dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { INLINE_CHARS } from '@/mcp-server/tools/spill-utils.js';
import { getCanvas } from '@/services/canvas-accessor.js';

/**
 * Most rows either response surface carries. The data query asks the canvas for no
 * more than this, so a large result is never materialized just to be sliced; the
 * exact total comes from a separate `COUNT(*)` over the caller's SQL.
 */
const PREVIEW_ROW_LIMIT = 100;

/**
 * Longest the `COUNT(*)` behind an exact `row_count` may run. The count re-executes the
 * caller's SQL in full, where the data query stops after its preview rows, so a result
 * that streams its first rows instantly can take minutes to count. Past this budget the
 * response keeps its rows and reports the lower bound with `count_error: count_timeout`.
 */
const COUNT_BUDGET_MS = 5_000;

const INLINE_CHARS_LABEL = INLINE_CHARS.toLocaleString('en-US');

/** Paging advice both the notice and the `rows` description carry. */
const PAGE_ORDER =
  'Page under an ORDER BY: without one, DuckDB guarantees no row order between calls.';

/** The response fields that are not rows — what the preview's fixed cost is measured from. */
interface QueryMeta {
  canvas_id: string;
  count_error?: string | undefined;
  row_count: number;
}

/**
 * Render one header or cell for the markdown table in `format()`, so each table row
 * stays one line with the header's column count.
 *
 * Strings take JSON string escaping without the surrounding quotes, which turns
 * newlines, tabs, backslashes, and quotes into visible escapes (`\n`, `\t`, `\\`,
 * `\"`); the empty string renders as `""` so it stays distinct from null, which is an
 * empty cell. Structs and lists arrive as real objects and arrays from DuckDB's
 * `getRowObjectsJson()` and render as compact JSON. Numbers and booleans render bare,
 * as do BIGINT, DATE, and TIMESTAMP, which arrive pre-marshaled as strings with
 * nothing to escape — so no `bigint` ever reaches `JSON.stringify`.
 *
 * Every `|` is escaped last, over the rendered text: it is not JSON-significant, so
 * the steps above pass it through, and a bare pipe would end the cell early. Escaping
 * backslashes first is what keeps a value's own `\|` from reading back as `\|` → `|`.
 */
function renderCell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value === ''
          ? '""'
          : JSON.stringify(value).slice(1, -1)
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
  return text.replace(EDGE_OR_INVISIBLE_BREAK, toUnicodeEscapes).replaceAll('|', '\\|');
}

/**
 * Characters JSON escaping leaves bare that still split or erase a cell: U+2028 and
 * U+2029 end a line for JavaScript-based markdown parsers, a no-break space alone reads
 * as a blank row to some of them, and GFM trims leading and trailing spaces from every
 * cell, so `' '` would read back as null. Each becomes its `\uXXXX` JSON escape.
 */
const EDGE_OR_INVISIBLE_BREAK = /^ +| +$|[\p{Zl}\p{Zp}\xA0]/gu;

function toUnicodeEscapes(match: string): string {
  return match
    .split('')
    .map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
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
 * The notice for a preview of `shown` rows, or undefined when the preview is the whole
 * result. Which bound stopped it is read from `shown`: a full preview hit the row cap,
 * anything shorter hit the size ceiling.
 */
function previewNotice(meta: QueryMeta, shown: number): string | undefined {
  if (meta.count_error === undefined && meta.row_count <= shown) return;
  const bound =
    shown >= PREVIEW_ROW_LIMIT
      ? `the ${PREVIEW_ROW_LIMIT}-row inline cap`
      : `the next row would take this response past its ${INLINE_CHARS_LABEL}-character inline ceiling; select fewer or narrower columns to fit more rows per call`;
  return `_Showing first ${shown} of ${totalLabel(meta)} rows (${bound}). Continue at OFFSET ${shown}: re-issue the SQL with LIMIT / OFFSET, adding ${shown} to any OFFSET it already applies and subtracting it from any LIMIT. ${PAGE_ORDER}_`;
}

/** `content[0].text` for a non-empty result: the handler's size accounting renders through this too. */
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
    `**Canvas:** \`${meta.canvas_id}\` | **Rows:** ${rows}`,
    '',
    tableLine(headers.map(renderCell)),
    tableLine(headers.map(() => '---')),
    ...rowLines,
  ];
  const notice = previewNotice(meta, shown);
  if (notice) lines.push('', notice);
  return lines.join('\n');
}

/**
 * Take whole leading rows, up to the row cap, while both surfaces stay within
 * {@link INLINE_CHARS}. The fixed cost is the larger of the two surfaces with no rows —
 * the JSON envelope, or the rendered header, column row, separator, and the longest
 * notice this result can carry — and each row is charged the larger of its JSON length
 * and its rendered table line, plus the comma or newline joining it to the next. Values
 * are never cut, so the preview stops before the first row that does not fit.
 *
 * The size-ceiling notice appears whenever fewer rows fit than the result holds, so it
 * is measured at the widest such count — one short of the row cap or of `row_count`,
 * whichever is lower — including for a result under the row cap.
 */
function selectPreview(
  rows: readonly Record<string, unknown>[],
  meta: QueryMeta,
): { kept: Record<string, unknown>[]; firstRowChars: number; room: number } {
  const headers = Object.keys(rows[0] ?? {});
  const widestSizeBound = Math.max(Math.min(meta.row_count, PREVIEW_ROW_LIMIT) - 1, 1);
  const fixed = Math.max(
    JSON.stringify({ rows: [], ...meta }).length,
    renderText(meta, headers, [], PREVIEW_ROW_LIMIT).length,
    renderText(meta, headers, [], widestSizeBound).length,
  );
  const room = INLINE_CHARS - fixed;
  const kept: Record<string, unknown>[] = [];
  let used = 0;
  let firstRowChars = 0;
  for (const row of rows.slice(0, PREVIEW_ROW_LIMIT)) {
    const chars = 1 + Math.max(JSON.stringify(row).length, rowLine(headers, row).length);
    if (kept.length === 0) firstRowChars = chars;
    if (used + chars > room) break;
    used += chars;
    kept.push(row);
  }
  return { kept, firstRowChars, room };
}

export const openmeteoDataframeQueryTool = tool('openmeteo_dataframe_query', {
  description: `Run a read-only SQL SELECT against tables staged on a DataCanvas by openmeteo_get_forecast, openmeteo_get_historical, openmeteo_get_marine, openmeteo_get_air_quality, openmeteo_get_ensemble, openmeteo_get_flood, or openmeteo_get_climate. Pass the canvas_id returned when any of those tools spills (truncated: true), and reference the exact table_name those tools return alongside it. Call openmeteo_dataframe_describe to list staged tables and their columns when you need to discover names. Returns up to ${PREVIEW_ROW_LIMIT} leading rows — fewer when wide rows would pass the ${INLINE_CHARS_LABEL}-character inline ceiling — plus row_count — exact, or a lower bound flagged by count_error when counting fails or runs past 5 seconds; page the rest with LIMIT / OFFSET.`,
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
      reason: 'row_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: `The first result row alone cannot fit the ${INLINE_CHARS_LABEL}-character inline ceiling, and values are never cut.`,
      recovery:
        'Return less per row: select fewer columns, shorten wide strings with left() or substr(), trim long lists with list_slice(), or aggregate before returning.',
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
  }),

  output: z.object({
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        `Leading result rows: at most ${PREVIEW_ROW_LIMIT}, and fewer when the next row would take the response past its ${INLINE_CHARS_LABEL}-character inline ceiling. Values are never cut. When row_count exceeds rows.length, continue by re-issuing the SQL with OFFSET <rows.length>, added to any OFFSET it already applies, with any LIMIT reduced by the same amount. ${PAGE_ORDER}`,
      ),
    row_count: z
      .number()
      .describe(
        'Exact number of rows in the full result. When count_error is present, the total could not be counted and this is a lower bound: the rows the query confirmed exist.',
      ),
    count_error: z
      .string()
      .optional()
      .describe(
        'Present only when counting the full result failed after its rows were read — the failure reason (e.g. sql_execution_error, or count_timeout when counting ran past 5 seconds). The rows are still valid; row_count is then a lower bound.',
      ),
    canvas_id: z.string().describe('Canvas ID that was queried.'),
  }),

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
    const queryOptions = { signal: ctx.signal, denySystemCatalogs: true };
    // Rewrap the framework's query-level errors under this tool's own contracts so
    // the declared recovery hints reach the wire. The framework's system_catalog_access
    // throw carries no recovery of its own, and its missing_table recovery names
    // framework methods (registerTable()/describe()) instead of this server's tools.
    // Every other McpError (invalid_sql, sql_read_only, denied_function, a TTL-expired
    // canvas_not_found, …) passes through unchanged so consumers keep the original
    // code and data.reason.
    const result = await instance
      .query(input.sql, { ...queryOptions, rowLimit: PREVIEW_ROW_LIMIT })
      .catch((err: unknown) => {
        if (err instanceof McpError && err.data?.reason === 'system_catalog_access') {
          throw ctx.fail('system_catalog_access', err.message, undefined, { cause: err });
        }
        if (err instanceof McpError && err.data?.reason === 'missing_table') {
          const tableName = err.data.tableName;
          const named =
            typeof tableName === 'string' ? `Table "${tableName}"` : 'The referenced table';
          throw ctx.fail(
            'missing_table',
            `${named} is not staged on canvas "${input.canvas_id}". Use the exact table_name returned by openmeteo_get_forecast, openmeteo_get_historical, openmeteo_get_marine, openmeteo_get_air_quality, openmeteo_get_ensemble, openmeteo_get_flood, or openmeteo_get_climate, or call openmeteo_dataframe_describe to list staged tables. It may also have expired (24 h sliding TTL) or been dropped.`,
            undefined,
            { cause: err },
          );
        }
        throw err;
      });

    // A truncated read means more rows exist than the preview fetched; count them with
    // the caller's SQL as a subquery, through the same gate. The data query already
    // succeeded, so a count failure (only cancellation excepted) leaves its rows in
    // place and reports the lower bound the read established — rowLimit + 1 rows exist.
    const meta: QueryMeta = { canvas_id: instance.canvasId, row_count: result.rowCount };
    if (result.truncated) {
      const countSql = `SELECT COUNT(*) AS n FROM (\n${input.sql.replace(/[\s;]+$/, '')}\n)`;
      const countSignal = AbortSignal.any([ctx.signal, AbortSignal.timeout(COUNT_BUDGET_MS)]);
      await instance.query(countSql, { ...queryOptions, signal: countSignal }).then(
        (count) => {
          meta.row_count = Number(count.rows[0]?.n);
        },
        (err: unknown) => {
          if (ctx.signal.aborted) throw err;
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

    const { kept, firstRowChars, room } = selectPreview(result.rows, meta);
    if (kept.length === 0 && result.rows.length > 0) {
      throw ctx.fail(
        'row_too_large',
        `The first result row needs ${firstRowChars.toLocaleString('en-US')} characters inline, but this response has room for ${Math.max(room, 0).toLocaleString('en-US')} under its ${INLINE_CHARS_LABEL}-character ceiling.`,
      );
    }

    ctx.log.info('Dataframe query executed', {
      canvas_id: instance.canvasId,
      row_count: meta.row_count,
      preview_rows: kept.length,
    });

    return { rows: kept, ...meta };
  },

  format: (result) => {
    const firstRow = result.rows[0];
    if (!firstRow) {
      return [
        {
          type: 'text',
          text: `## DataCanvas query result\n**Canvas:** \`${result.canvas_id}\` | **Rows:** ${result.row_count}\n\n_No rows returned._`,
        },
      ];
    }
    const headers = Object.keys(firstRow);
    const rowLines = result.rows.map((row) => rowLine(headers, row));
    return [{ type: 'text', text: renderText(result, headers, rowLines, result.rows.length) }];
  },
});
