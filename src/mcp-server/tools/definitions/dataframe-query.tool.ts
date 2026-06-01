/**
 * @fileoverview Tool: openmeteo_dataframe_query — run read-only SQL against a staged canvas.
 * @module mcp-server/tools/definitions/dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';

export const openmeteoDataframeQueryTool = tool('openmeteo_dataframe_query', {
  description:
    'Run a read-only SQL SELECT against tables staged on a DataCanvas by openmeteo_get_historical. ' +
    'Pass the canvas_id returned when openmeteo_get_historical spills (truncated: true). ' +
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
      recovery: 'Re-run openmeteo_get_historical to stage a fresh canvas, then retry.',
      retryable: false,
    },
  ],

  input: z.object({
    canvas_id: z
      .string()
      .describe('Canvas ID returned by openmeteo_get_historical when truncated: true.'),
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
      );
    }

    const instance = await canvas.acquire(input.canvas_id, ctx);
    const result = await instance.query(input.sql, { signal: ctx.signal });

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
