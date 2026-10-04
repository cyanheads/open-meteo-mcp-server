/**
 * @fileoverview Tool: openmeteo_dataframe_drop — remove one staged table or view from a canvas.
 * Opt-in: registered as callable only when OPENMETEO_DATAFRAME_DROP_ENABLED=true, otherwise
 * listed as disabled.
 * @module mcp-server/tools/definitions/dataframe-drop
 */

import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getCanvas } from '@/services/canvas-accessor.js';

/** Framework identifier-gate reasons for a table name that can never name a staged table. */
const INVALID_TABLE_NAME_REASONS = new Set([
  'identifier_empty',
  'identifier_shape',
  'identifier_reserved',
]);

const openmeteoDataframeDropDefinition = tool('openmeteo_dataframe_drop', {
  description:
    'Remove one table or view from a DataCanvas staged by openmeteo_get_forecast, ' +
    'openmeteo_get_historical, openmeteo_get_marine, openmeteo_get_air_quality, openmeteo_get_ensemble, openmeteo_get_flood, or openmeteo_get_climate. ' +
    'The canvas and its other tables stay in place. Copy the exact name from openmeteo_dataframe_describe. ' +
    'A name that is not staged changes nothing and returns dropped: false, so repeating a drop is safe. ' +
    'Dropped rows cannot be recovered — re-run the tool that staged them to fetch them again.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },

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
      when: 'The canvas_id is unknown, belongs to another tenant, or has expired under its 24 h sliding TTL.',
      recovery:
        'Check the canvas_id against the one the staging tool returned; an expired canvas has already released its tables, so there is nothing left to drop.',
      retryable: false,
    },
    {
      reason: 'invalid_table_name',
      code: JsonRpcErrorCode.ValidationError,
      when: 'table_name is empty, is not a plain SQL identifier (letters, digits, underscores, at most 63 characters), or is a reserved SQL keyword.',
      recovery:
        'Copy an exact table name from openmeteo_dataframe_describe and call openmeteo_dataframe_drop again.',
      retryable: false,
    },
  ],

  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'Canvas ID returned by openmeteo_get_forecast, openmeteo_get_historical, openmeteo_get_marine, openmeteo_get_air_quality, openmeteo_get_ensemble, openmeteo_get_flood, or openmeteo_get_climate when truncated: true.',
    ),
    table_name: z
      .string()
      .describe(
        'Exact table or view name to remove, as listed by openmeteo_dataframe_describe (e.g. spilled_ab12cd34).',
      ),
  }),

  output: z.object({
    canvas_id: z.string().describe('Canvas ID the drop ran against.'),
    table_name: z.string().describe('Table or view name that was requested.'),
    dropped: z
      .boolean()
      .describe(
        'True when the table or view was removed; false when nothing by that name was staged.',
      ),
    remaining_tables: z
      .array(z.string().describe('Table or view name.'))
      .describe('Tables and views still staged on the canvas after the drop.'),
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

    // The framework's identifier gate carries a recovery that names its own methods;
    // rewrap it under this tool's contract so the hint points at this server's tools.
    const dropped = await instance.drop(input.table_name).catch((err: unknown) => {
      const reason = err instanceof McpError ? err.data?.reason : undefined;
      if (typeof reason === 'string' && INVALID_TABLE_NAME_REASONS.has(reason)) {
        throw ctx.fail(
          'invalid_table_name',
          `"${input.table_name}" cannot name a staged table. ${(err as McpError).message}`,
          undefined,
          { cause: err },
        );
      }
      throw err;
    });
    const remaining = await instance.describe();

    ctx.log.info('Dataframe drop executed', {
      canvas_id: instance.canvasId,
      table_name: input.table_name,
      dropped,
    });

    return {
      canvas_id: instance.canvasId,
      table_name: input.table_name,
      dropped,
      remaining_tables: remaining.map((t) => t.name),
    };
  },

  format: (result) => {
    const lines = [
      `## DataCanvas drop`,
      `**Canvas:** \`${result.canvas_id}\` | **Table:** \`${result.table_name}\` | **Dropped:** ${result.dropped}`,
      '',
      result.dropped
        ? `Removed \`${result.table_name}\` from the canvas.`
        : `No table or view named \`${result.table_name}\` was staged — nothing changed.`,
      '',
      result.remaining_tables.length > 0
        ? `**Remaining tables:** ${result.remaining_tables.map((name) => `\`${name}\``).join(', ')}`
        : '**Remaining tables:** none',
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * Listed in every configuration so operators see the capability exists; callable only
 * when the deployment opts in, since a drop is destructive and a no-auth canvas is
 * reachable by anyone holding its id.
 */
export const openmeteoDataframeDropTool = getServerConfig().dataframeDropEnabled
  ? openmeteoDataframeDropDefinition
  : disabledTool(openmeteoDataframeDropDefinition, {
      reason: 'Dropping staged DataCanvas tables is turned off in this deployment.',
      hint: 'OPENMETEO_DATAFRAME_DROP_ENABLED=true',
    });
