/**
 * @fileoverview Tool: openmeteo_get_marine — marine wave and ocean forecast.
 * Reshapes columnar response into per-timestamp records.
 * @module mcp-server/tools/definitions/get-marine
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';
import { toUnitsMap } from '@/services/open-meteo/types.js';
import { formatRecord, formatUnits, reshapeColumnar } from '../reshape-utils.js';
import { frameInvalidVariableMessage } from '../upstream-error.js';

export const openmeteoGetMarineTool = tool('openmeteo_get_marine', {
  description:
    'Marine weather forecast for a coastal or ocean coordinate: wave height, wave period, ' +
    'wave direction, wind-wave height, swell height, sea-surface temperature. Forecast horizon ' +
    'up to 7 days. Returns per-timestamp records — each entry contains a "time" field plus one key per requested variable. Best for open-ocean ' +
    'and coastal exposed points — sheltered inland waters return near-zero wave values. ' +
    'Common hourly variables: wave_height, wave_direction, wave_period, wind_wave_height, ' +
    'wind_wave_direction, wind_wave_period, swell_wave_height, swell_wave_direction, ' +
    'swell_wave_period. Common daily: wave_height_max, wave_direction_dominant, wave_period_max. ' +
    'Note: ocean_current_velocity is null for non-open-ocean coordinates.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'invalid_variable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An unknown marine variable name was requested',
      recovery:
        'Check variable names against Open-Meteo marine docs. Common: wave_height, wave_direction, wave_period, wind_wave_height, swell_wave_height, wave_height_max.',
      retryable: false,
    },
    {
      reason: 'no_variables_requested',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither hourly_variables nor daily_variables was provided',
      recovery: 'Provide at least one of hourly_variables or daily_variables.',
      retryable: false,
    },
  ],

  input: z.object({
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .describe(
        'Latitude of a coastal or ocean point. Use openmeteo_geocode to resolve a place name. Inland points return near-zero wave values.',
      ),
    longitude: z.number().min(-180).max(180).describe('Longitude in decimal degrees.'),
    hourly_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Hourly marine variables (e.g., ["wave_height", "wave_direction", "wave_period", "wind_wave_height", "swell_wave_height"]). At least one of hourly_variables or daily_variables required.',
      ),
    daily_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Daily marine summary variables (e.g., ["wave_height_max", "wave_direction_dominant", "wave_period_max"]). At least one of hourly_variables or daily_variables required.',
      ),
    forecast_days: z
      .number()
      .int()
      .min(1)
      .max(7)
      .default(7)
      .describe('Forecast horizon in days (1–7). Default 7.'),
    timezone: z.string().default('auto').describe('IANA timezone or "auto". Default "auto".'),
  }),

  output: z.object({
    latitude: z.number().describe('Snapped latitude'),
    longitude: z.number().describe('Snapped longitude'),
    timezone: z.string().describe('Resolved IANA timezone'),
    hourly: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Per-hour records with "time" (ISO 8601) + one key per requested variable (e.g., wave_height in meters, wave_direction in degrees, wave_period in seconds). Absent when only daily_variables were requested.',
      ),
    daily: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Per-day summary records with "time" (YYYY-MM-DD) + variable keys (e.g., wave_height_max in meters, wave_direction_dominant in degrees, wave_period_max in seconds).',
      ),
    hourly_units: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Variable → unit string for hourly data (e.g., {"wave_height": "m", "wave_period": "s"}). Absent when no hourly_variables were requested.',
      ),
    daily_units: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Variable → unit string for daily data. Absent when no daily_variables were requested.',
      ),
  }),

  async handler(input, ctx) {
    const hasHourly = (input.hourly_variables?.length ?? 0) > 0;
    const hasDaily = (input.daily_variables?.length ?? 0) > 0;
    if (!hasHourly && !hasDaily) {
      throw ctx.fail(
        'no_variables_requested',
        'Provide at least one of hourly_variables or daily_variables.',
        ctx.recoveryFor('no_variables_requested'),
      );
    }

    const service = getOpenMeteoService();
    const data = await service.getMarine(
      input.latitude,
      input.longitude,
      {
        hourly: input.hourly_variables,
        daily: input.daily_variables,
        forecast_days: input.forecast_days,
        timezone: input.timezone,
      },
      ctx,
    );

    if (data.error) {
      throw ctx.fail(
        'invalid_variable',
        frameInvalidVariableMessage(data.reason),
        ctx.recoveryFor('invalid_variable'),
      );
    }

    return {
      latitude: data.latitude,
      longitude: data.longitude,
      timezone: data.timezone,
      hourly: data.hourly ? reshapeColumnar(data.hourly) : undefined,
      daily: data.daily ? reshapeColumnar(data.daily) : undefined,
      hourly_units: toUnitsMap(data.hourly_units as Record<string, unknown> | undefined),
      daily_units: toUnitsMap(data.daily_units as Record<string, unknown> | undefined),
    };
  },

  format: (result) => {
    const lines = [
      `## Marine forecast`,
      `**Location:** ${result.latitude}, ${result.longitude} | **Timezone:** ${result.timezone}`,
      '',
    ];

    if (result.hourly_units) lines.push(`**Hourly units:** ${formatUnits(result.hourly_units)}`);
    if (result.daily_units) lines.push(`**Daily units:** ${formatUnits(result.daily_units)}`);

    if (result.daily && result.daily.length > 0) {
      lines.push('', '### Daily marine summary');
      for (const rec of result.daily) lines.push(formatRecord(rec));
    }

    if (result.hourly && result.hourly.length > 0) {
      lines.push('', `### Hourly marine (${result.hourly.length} records)`);
      for (const rec of result.hourly) lines.push(formatRecord(rec));
    }

    lines.push('', '_Weather data by Open-Meteo.com_');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
