/**
 * @fileoverview Tool: openmeteo_get_flood — GloFAS river discharge forecast and reanalysis.
 * Returns daily ensemble river discharge (m³/s) for up to ~7 months ahead, with reanalysis
 * history back to 1984. Coordinate-based — snaps to nearest river automatically. Wide
 * reanalysis ranges spill to DataCanvas when canvas is enabled.
 * @module mcp-server/tools/definitions/get-flood
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';
import { toUnitsMap } from '@/services/open-meteo/types.js';
import { formatRecord, formatUnits, reshapeColumnar } from '../reshape-utils.js';
import { deriveSpillSchema, exceedsInlineBudget, PREVIEW_CHARS } from '../spill-utils.js';
import { frameInvalidVariableMessage } from '../upstream-error.js';

export const openmeteoGetFloodTool = tool('openmeteo_get_flood', {
  description:
    'GloFAS (Global Flood Awareness System) river discharge forecast and historical reanalysis. ' +
    'Returns daily ensemble river discharge (m³/s) for the river nearest to the given coordinates ' +
    '— no river ID needed, the API snaps to the nearest stream. Forecast horizon up to 210 days ' +
    'ahead; reanalysis history back to 1984-01-01. One mode per call: forecast_days for the ' +
    'future outlook, or start_date and end_date together for reanalysis history. The two modes ' +
    'are mutually exclusive, and a date range needs both ends — a lone start_date or end_date is ' +
    'rejected. Available daily variables: "river_discharge" (ensemble mean), "river_discharge_mean", ' +
    '"river_discharge_min", "river_discharge_max", "river_discharge_median", ' +
    '"river_discharge_p25" (25th percentile), "river_discharge_p75" (75th percentile). ' +
    'Returns null for coordinates far from any river or in areas without GloFAS coverage. ' +
    'A wide reanalysis range produces thousands of daily records and spills to DataCanvas for ' +
    'SQL querying when canvas is enabled.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'no_variables_requested',
      code: JsonRpcErrorCode.ValidationError,
      when: 'daily_variables was not provided or is empty',
      recovery:
        'Provide daily_variables with at least one discharge variable (e.g., ["river_discharge", "river_discharge_p25", "river_discharge_p75"]).',
      retryable: false,
    },
    {
      reason: 'date_range_incomplete',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Only one of start_date / end_date was provided — GloFAS requires the pair together',
      recovery:
        'Provide both start_date and end_date to pull a historical range, or omit both and use forecast_days for the forecast outlook.',
      retryable: false,
    },
    {
      reason: 'forecast_days_conflict',
      code: JsonRpcErrorCode.ValidationError,
      when: 'forecast_days was combined with start_date or end_date',
      recovery:
        'Drop forecast_days to pull the historical range, or drop start_date and end_date to pull the forecast — GloFAS accepts one mode per call, never both.',
      retryable: false,
    },
    {
      reason: 'date_order_invalid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'end_date is before start_date',
      recovery: 'Ensure end_date is on or after start_date.',
      retryable: false,
    },
    {
      reason: 'date_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'start_date predates 1984-01-01 or date range is otherwise invalid',
      recovery: 'Use start_date >= 1984-01-01. GloFAS reanalysis covers from 1984-01-01 onward.',
      retryable: false,
    },
    {
      reason: 'invalid_variable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An unknown discharge variable name was requested',
      recovery:
        'Valid variables: river_discharge, river_discharge_mean, river_discharge_min, river_discharge_max, river_discharge_median, river_discharge_p25, river_discharge_p75.',
      retryable: false,
    },
  ],

  input: z.object({
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .describe(
        'Latitude in decimal degrees. The API snaps to the nearest river — no river ID required. Use openmeteo_geocode to resolve a place name.',
      ),
    longitude: z.number().min(-180).max(180).describe('Longitude in decimal degrees.'),
    daily_variables: z
      .array(z.string())
      .max(20)
      .optional()
      .describe(
        'Daily discharge variables to fetch (e.g., ["river_discharge", "river_discharge_p25", "river_discharge_p75", "river_discharge_min", "river_discharge_max"]). Required.',
      ),
    forecast_days: z
      .number()
      .int()
      .min(1)
      .max(210)
      .optional()
      .describe(
        'Number of forecast days ahead (1–210). Mutually exclusive with start_date/end_date — omit it entirely when pulling a historical range.',
      ),
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'Start date for historical reanalysis (YYYY-MM-DD, e.g., "2023-01-01"). GloFAS reanalysis covers from 1984-01-01. Requires end_date — the pair must be sent together, and neither combines with forecast_days.',
      ),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'End date for historical reanalysis (YYYY-MM-DD, inclusive). Must be on or after start_date. Requires start_date — the pair must be sent together, and neither combines with forecast_days.',
      ),
    timezone: z.string().default('auto').describe('IANA timezone or "auto". Default "auto".'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas token for wide reanalysis queries. When a result is too large to return inline — driven by total payload size, so a multi-variable pull can spill at any row count — it spills to this canvas for SQL querying. Omit to create a fresh canvas.',
      ),
  }),

  output: z.object({
    latitude: z.number().describe('Snapped latitude (nearest river grid point)'),
    longitude: z.number().describe('Snapped longitude'),
    timezone: z.string().describe('Resolved IANA timezone'),
    record_count: z
      .number()
      .describe(
        'Total number of daily discharge records — the full staged count when truncated is true, not the length of the daily preview.',
      ),
    daily: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Per-day records with "time" (YYYY-MM-DD) + one key per requested variable containing discharge in m³/s, or null for coordinates outside GloFAS coverage. When truncated, contains only a preview; query canvas_id for the full dataset.',
      ),
    daily_units: z
      .record(z.string(), z.string())
      .optional()
      .describe('Variable → unit string for daily data (e.g., {"river_discharge": "m³/s"}).'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas token — present only when truncated is true (data spilled). Query with SQL using this token.',
      ),
    table_name: z
      .string()
      .optional()
      .describe(
        'DuckDB table name for the staged data — pass to openmeteo_dataframe_query. Present only when truncated is true.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when the response was too large to return inline and data spilled to canvas_id. Query the canvas for the full dataset.',
      ),
  }),

  async handler(input, ctx) {
    const dailyVariables = input.daily_variables;
    if (!dailyVariables || dailyVariables.length === 0) {
      throw ctx.fail(
        'no_variables_requested',
        'Provide daily_variables with at least one discharge variable.',
        ctx.recoveryFor('no_variables_requested'),
      );
    }

    /**
     * GloFAS takes the forecast window or a historical range, never both, and rejects
     * a half-specified range. Guarding here rather than letting upstream reject keeps
     * both cases off the post-call `reason.includes('date')` branch, which frames every
     * date complaint as the 1984 coverage floor — advice that fixes neither.
     */
    const hasStart = input.start_date !== undefined;
    const hasEnd = input.end_date !== undefined;

    // Mode conflict outranks pairing: when forecast_days arrives with a half-specified
    // range, both faults are present, but only this one names the caller's actual
    // choice. Reporting the pair first would answer "or omit both and use
    // forecast_days" to a caller who already did exactly that.
    if (input.forecast_days !== undefined && (hasStart || hasEnd)) {
      throw ctx.fail(
        'forecast_days_conflict',
        'forecast_days cannot be combined with start_date/end_date — GloFAS serves either the forecast window or a historical range, not both.',
        ctx.recoveryFor('forecast_days_conflict'),
      );
    }

    if (hasStart !== hasEnd) {
      throw ctx.fail(
        'date_range_incomplete',
        `GloFAS needs start_date and end_date together — only ${hasStart ? 'start_date' : 'end_date'} was provided.`,
        ctx.recoveryFor('date_range_incomplete'),
      );
    }

    if (input.start_date && input.end_date && input.end_date < input.start_date) {
      throw ctx.fail(
        'date_order_invalid',
        `end_date (${input.end_date}) is before start_date (${input.start_date}).`,
        ctx.recoveryFor('date_order_invalid'),
      );
    }

    if (input.start_date && input.start_date < '1984-01-01') {
      throw ctx.fail(
        'date_out_of_range',
        `start_date ${input.start_date} predates GloFAS reanalysis coverage (1984-01-01).`,
        ctx.recoveryFor('date_out_of_range'),
      );
    }

    const service = getOpenMeteoService();
    const data = await service.getFlood(
      input.latitude,
      input.longitude,
      {
        daily: dailyVariables,
        forecast_days: input.forecast_days,
        start_date: input.start_date,
        end_date: input.end_date,
        timezone: input.timezone,
      },
      ctx,
    );

    if (data.error) {
      const reason = data.reason ?? '';
      if (reason.toLowerCase().includes('date') || reason.toLowerCase().includes('range')) {
        throw ctx.fail(
          'date_out_of_range',
          reason || 'Date out of GloFAS range.',
          ctx.recoveryFor('date_out_of_range'),
        );
      }
      throw ctx.fail(
        'invalid_variable',
        frameInvalidVariableMessage(data.reason, 'discharge variable'),
        ctx.recoveryFor('invalid_variable'),
      );
    }

    const dailyRecords = data.daily ? reshapeColumnar(data.daily) : [];

    // DataCanvas spillover for payloads too large to return inline
    if (exceedsInlineBudget(dailyRecords)) {
      const canvas = getCanvas();
      if (canvas) {
        const instance = await canvas.acquire(input.canvas_id, ctx);
        // Explicit schema over every staged row — a coordinate outside GloFAS coverage
        // is null down its whole column. See deriveSpillSchema.
        const spilled = await spillover({
          canvas: instance,
          source: dailyRecords,
          schema: deriveSpillSchema(dailyRecords),
          previewChars: PREVIEW_CHARS,
          signal: ctx.signal,
        });

        return {
          latitude: data.latitude,
          longitude: data.longitude,
          timezone: data.timezone,
          record_count: spilled.spilled ? spilled.handle.rowCount : dailyRecords.length,
          daily: spilled.previewRows as Record<string, unknown>[],
          daily_units: toUnitsMap(data.daily_units as Record<string, unknown> | undefined),
          // Only point at the canvas when data actually spilled — spillover()
          // stages a table only past its byte threshold, so a canvas_id on the
          // non-spilled path would reference an empty canvas.
          canvas_id: spilled.spilled ? instance.canvasId : undefined,
          table_name: spilled.spilled ? spilled.handle.tableName : undefined,
          truncated: spilled.spilled,
        };
      }
    }

    return {
      latitude: data.latitude,
      longitude: data.longitude,
      timezone: data.timezone,
      record_count: dailyRecords.length,
      daily: dailyRecords,
      daily_units: toUnitsMap(data.daily_units as Record<string, unknown> | undefined),
      canvas_id: undefined,
      table_name: undefined,
      truncated: false,
    };
  },

  format: (result) => {
    const lines = [
      '## GloFAS river discharge forecast',
      `**Location:** ${result.latitude}, ${result.longitude} | **Timezone:** ${result.timezone}`,
      `**Records:** ${result.record_count} | **Truncated:** ${result.truncated}`,
    ];

    if (result.truncated && result.canvas_id) {
      lines.push(
        `\n⚠️ Large result — full data staged on canvas \`${result.canvas_id}\`, table \`${result.table_name}\`. Query with SQL via openmeteo_dataframe_query.`,
      );
    }

    if (result.daily_units) lines.push('', `**Daily units:** ${formatUnits(result.daily_units)}`);

    if (result.daily.length > 0) {
      // When truncated, result.daily is the spillover preview array — render all of
      // it so content[] matches structuredContent.daily; the heading references
      // record_count (the full staged total), not the preview length.
      lines.push(
        '',
        result.truncated
          ? `### Daily discharge (preview — ${result.daily.length} shown of ${result.record_count} total rows on canvas)`
          : `### Daily discharge (${result.daily.length} records)`,
      );
      for (const rec of result.daily) lines.push(formatRecord(rec));
    } else {
      lines.push('', '_No discharge data returned — coordinates may be outside GloFAS coverage._');
    }

    lines.push('', '_Weather data by Open-Meteo.com_');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
