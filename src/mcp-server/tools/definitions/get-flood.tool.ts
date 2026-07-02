/**
 * @fileoverview Tool: openmeteo_get_flood — GloFAS river discharge forecast and reanalysis.
 * Returns daily ensemble river discharge (m³/s) for up to ~7 months ahead, with reanalysis
 * history back to 1984. Coordinate-based — snaps to nearest river automatically.
 * @module mcp-server/tools/definitions/get-flood
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';
import { toUnitsMap } from '@/services/open-meteo/types.js';
import { formatRecord, formatUnits, reshapeColumnar } from '../reshape-utils.js';
import { frameInvalidVariableMessage } from '../upstream-error.js';

export const openmeteoGetFloodTool = tool('openmeteo_get_flood', {
  description:
    'GloFAS (Global Flood Awareness System) river discharge forecast and historical reanalysis. ' +
    'Returns daily ensemble river discharge (m³/s) for the river nearest to the given coordinates ' +
    '— no river ID needed, the API snaps to the nearest stream. Forecast horizon up to 210 days ' +
    'ahead; reanalysis history back to 1984-01-01. Use start_date/end_date for historical pulls ' +
    'and forecast_days for future forecasts; both can be combined. ' +
    'Available daily variables: "river_discharge" (ensemble mean), "river_discharge_mean", ' +
    '"river_discharge_min", "river_discharge_max", "river_discharge_median", ' +
    '"river_discharge_p25" (25th percentile), "river_discharge_p75" (75th percentile). ' +
    'Returns null for coordinates far from any river or in areas without GloFAS coverage.',
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
      .min(1)
      .max(20)
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
        'Number of forecast days ahead (1–210). Omit when fetching historical data only via start_date/end_date.',
      ),
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'Start date for historical reanalysis (YYYY-MM-DD, e.g., "2023-01-01"). GloFAS reanalysis covers from 1984-01-01.',
      ),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'End date for historical reanalysis (YYYY-MM-DD, inclusive). Must be on or after start_date.',
      ),
    timezone: z.string().default('auto').describe('IANA timezone or "auto". Default "auto".'),
  }),

  output: z.object({
    latitude: z.number().describe('Snapped latitude (nearest river grid point)'),
    longitude: z.number().describe('Snapped longitude'),
    timezone: z.string().describe('Resolved IANA timezone'),
    daily: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Per-day records with "time" (YYYY-MM-DD) + one key per requested variable containing discharge in m³/s, or null for coordinates outside GloFAS coverage.',
      ),
    daily_units: z
      .record(z.string(), z.string())
      .optional()
      .describe('Variable → unit string for daily data (e.g., {"river_discharge": "m³/s"}).'),
  }),

  async handler(input, ctx) {
    if ((input.daily_variables?.length ?? 0) === 0) {
      throw ctx.fail(
        'no_variables_requested',
        'Provide daily_variables with at least one discharge variable.',
        ctx.recoveryFor('no_variables_requested'),
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
        daily: input.daily_variables,
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

    return {
      latitude: data.latitude,
      longitude: data.longitude,
      timezone: data.timezone,
      daily: data.daily ? reshapeColumnar(data.daily) : [],
      daily_units: toUnitsMap(data.daily_units as Record<string, unknown> | undefined),
    };
  },

  format: (result) => {
    const lines = [
      '## GloFAS river discharge forecast',
      `**Location:** ${result.latitude}, ${result.longitude} | **Timezone:** ${result.timezone}`,
      '',
    ];

    if (result.daily_units) lines.push(`**Daily units:** ${formatUnits(result.daily_units)}`);

    if (result.daily.length > 0) {
      const shown = Math.min(result.daily.length, 30);
      lines.push('', `### Daily discharge (first ${shown} of ${result.daily.length})`);
      for (const rec of result.daily.slice(0, shown)) lines.push(formatRecord(rec));
      if (result.daily.length > shown) {
        lines.push(`_...and ${result.daily.length - shown} more daily records._`);
      }
    } else {
      lines.push('_No discharge data returned — coordinates may be outside GloFAS coverage._');
    }

    lines.push('', '_Weather data by Open-Meteo.com_');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
