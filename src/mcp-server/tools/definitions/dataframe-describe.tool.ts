/**
 * @fileoverview Tool: openmeteo_dataframe_describe — list tables and columns on a staged canvas.
 * @module mcp-server/tools/definitions/dataframe-describe
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';

export const openmeteoDataframeDescribeTool = tool('openmeteo_dataframe_describe', {
  description:
    'List the tables and their columns on a DataCanvas staged by openmeteo_get_historical, ' +
    'openmeteo_get_ensemble, or openmeteo_get_climate. ' +
    'Call this first to discover table names before querying with openmeteo_dataframe_query.',
  annotations: { readOnlyHint: true, idempotentHint: true },

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
  ],

  input: z.object({
    canvas_id: z
      .string()
      .describe(
        'Canvas ID returned by openmeteo_get_historical, openmeteo_get_ensemble, or openmeteo_get_climate when truncated: true.',
      ),
  }),

  output: z.object({
    canvas_id: z.string().describe('Canvas ID that was inspected.'),
    tables: z
      .array(
        z
          .object({
            name: z.string().describe('Table name — pass to openmeteo_dataframe_query.'),
            kind: z.enum(['table', 'view']).describe('Whether this is a base table or a view.'),
            row_count: z.number().describe('Number of rows.'),
            columns: z
              .array(
                z
                  .object({
                    name: z.string().describe('Column name.'),
                    type: z.string().describe('DuckDB type (e.g. VARCHAR, DOUBLE, TIMESTAMP).'),
                    nullable: z.boolean().describe('Whether the column allows NULL.'),
                  })
                  .describe('A column: name, DuckDB type, and nullability.'),
              )
              .describe('Column schema.'),
          })
          .describe('A table or view on the canvas: name, kind, row count, and column schema.'),
      )
      .describe('Tables and views registered on this canvas.'),
    expires_at: z.string().describe('ISO 8601 expiry after the sliding 24 h TTL.'),
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
    const tableInfos = await instance.describe();

    ctx.log.info('Dataframe describe executed', {
      canvas_id: instance.canvasId,
      table_count: tableInfos.length,
    });

    return {
      canvas_id: instance.canvasId,
      tables: tableInfos.map((t) => ({
        name: t.name,
        kind: t.kind,
        row_count: t.rowCount,
        columns: t.columns.map((c) => ({
          name: c.name,
          type: String(c.type),
          nullable: c.nullable ?? true,
        })),
      })),
      expires_at: instance.expiresAt,
    };
  },

  format: (result) => {
    const lines = [
      `## DataCanvas contents`,
      `**Canvas:** \`${result.canvas_id}\` | **Expires:** ${result.expires_at}`,
      `**Tables:** ${result.tables.length}`,
    ];

    for (const table of result.tables) {
      lines.push('', `### ${table.name} (${table.kind}, ${table.row_count} rows)`);
      lines.push('| Column | Type | Nullable |');
      lines.push('| --- | --- | --- |');
      for (const col of table.columns) {
        lines.push(`| ${col.name} | ${col.type} | ${col.nullable ? 'yes' : 'no'} |`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
