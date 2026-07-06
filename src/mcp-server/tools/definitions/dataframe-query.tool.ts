/**
 * @fileoverview Tool: openmeteo_dataframe_query — run read-only SQL against a staged canvas.
 * @module mcp-server/tools/definitions/dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';

export const openmeteoDataframeQueryTool = tool('openmeteo_dataframe_query', {
  description:
    'Run a read-only SQL SELECT against tables staged on a DataCanvas by ' +
    'openmeteo_get_historical, openmeteo_get_ensemble, or openmeteo_get_climate. ' +
    'Pass the canvas_id returned when any of those tools spills (truncated: true). ' +
    'Tables are named by the spillover helper (e.g. spilled_<id>); use openmeteo_dataframe_describe ' +
    'to list available tables and their columns before querying.',
  annotations: { readOnlyHint: true },

  errors: [
    {
      reason: 'canvas_not_enabled',
      code: JsonRpcErrorCode.InternalError,
      when: 'CANVAS_PROVIDER_TYPE is not set to duckdb',
      recovery: 'Set CANVAS_PROVIDER_TYPE=duckdb and restart the server to enable DataCanvas.',
      retryable: false,
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id is unknown or has expired (TTL is 24 h sliding)',
      recovery:
        'Re-run openmeteo_get_historical, openmeteo_get_ensemble, or openmeteo_get_climate to stage a fresh canvas, then retry.',
      retryable: false,
    },
    {
      reason: 'system_catalog_access',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL references a system catalog (information_schema, sqlite_master, pg_catalog, or a duckdb_*() function)',
      recovery:
        'List tables and columns with openmeteo_dataframe_describe instead — system catalogs are blocked so callers cannot enumerate other staged canvases.',
      retryable: false,
    },
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'The SQL references a table that is not staged on this canvas — a mistyped name, or one that expired (24 h sliding TTL) or was dropped',
      recovery:
        'List the staged tables and columns with openmeteo_dataframe_describe, then reference an existing name — or re-run openmeteo_get_historical, openmeteo_get_ensemble, or openmeteo_get_climate to stage a fresh canvas.',
      retryable: false,
    },
  ],

  input: z.object({
    canvas_id: z
      .string()
      .describe(
        'Canvas ID returned by openmeteo_get_historical, openmeteo_get_ensemble, or openmeteo_get_climate when truncated: true.',
      ),
    sql: z
      .string()
      .describe(
        'Read-only SELECT statement. Reference table names from openmeteo_dataframe_describe. ' +
          "Example: SELECT AVG(temperature_2m) AS avg_temp, strftime(time, '%Y-%m') AS month FROM spilled_abc123 GROUP BY month ORDER BY month",
      ),
  }),

  output: z.object({
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Result rows (capped at the canvas row limit, default 10 000).'),
    row_count: z.number().describe('Total rows in the full result before any cap.'),
    canvas_id: z.string().describe('Canvas ID that was queried.'),
  }),

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail(
        'canvas_not_enabled',
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb and restart.',
        ctx.recoveryFor('canvas_not_enabled'),
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
          ctx.recoveryFor('canvas_not_found'),
          { cause: err },
        );
      }
      throw err;
    });
    // Rewrap the framework's query-level errors under this tool's own contracts so
    // the declared recovery hints reach the wire. The framework's system_catalog_access
    // throw carries no recovery of its own, and its missing_table recovery names
    // framework methods (registerTable()/describe()) instead of this server's tools.
    // Every other McpError (invalid_sql, non_select_statement, a TTL-expired
    // canvas_not_found, …) passes through unchanged so consumers keep the original
    // code and data.reason.
    const result = await instance
      .query(input.sql, { signal: ctx.signal, denySystemCatalogs: true })
      .catch((err: unknown) => {
        if (err instanceof McpError && err.data?.reason === 'system_catalog_access') {
          throw ctx.fail(
            'system_catalog_access',
            err.message,
            ctx.recoveryFor('system_catalog_access'),
            { cause: err },
          );
        }
        if (err instanceof McpError && err.data?.reason === 'missing_table') {
          const tableName = err.data.tableName;
          const named =
            typeof tableName === 'string' ? `Table "${tableName}"` : 'The referenced table';
          throw ctx.fail(
            'missing_table',
            `${named} is not staged on canvas "${input.canvas_id}" — it may have expired (24 h sliding TTL) or been dropped.`,
            ctx.recoveryFor('missing_table'),
            { cause: err },
          );
        }
        throw err;
      });

    ctx.log.info('Dataframe query executed', {
      canvas_id: instance.canvasId,
      row_count: result.rowCount,
    });

    return {
      rows: result.rows,
      row_count: result.rowCount,
      canvas_id: instance.canvasId,
    };
  },

  format: (result) => {
    const lines = [
      `## DataCanvas query result`,
      `**Canvas:** \`${result.canvas_id}\` | **Rows:** ${result.row_count}`,
    ];

    if (result.rows.length === 0) {
      lines.push('', '_No rows returned._');
    } else {
      const firstRow = result.rows[0] ?? {};
      const headers = Object.keys(firstRow);
      lines.push('', `| ${headers.join(' | ')} |`);
      lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
      for (const row of result.rows.slice(0, 100)) {
        lines.push(`| ${headers.map((h) => String(row[h] ?? '')).join(' | ')} |`);
      }
      if (result.row_count > 100) {
        lines.push(``, `_Showing 100 of ${result.row_count} rows._`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
