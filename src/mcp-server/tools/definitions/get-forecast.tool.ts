/**
 * @fileoverview Tool: openmeteo_get_forecast — weather forecast for coordinates.
 * Reshapes the columnar API response into per-timestamp records.
 * @module mcp-server/tools/definitions/get-forecast
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';
import { toUnitsMap } from '@/services/open-meteo/types.js';
import { formatRecord, formatUnits, reshapeColumnar } from '../reshape-utils.js';
import { frameInvalidVariableMessage } from '../upstream-error.js';

export const openmeteoGetForecastTool = tool('openmeteo_get_forecast', {
  description:
    'Weather forecast for coordinates: hourly and/or daily variables for up to 16 days ahead, ' +
    'with optional past_days (up to 92) for recent history. Use past_days instead of ' +
    'openmeteo_get_historical for dates within the last 1–5 days, since ERA5 has a variable lag. ' +
    'Returns per-timestamp records — each hourly entry contains a "time" field (ISO 8601) plus one key per requested variable; each daily entry contains a "time" field (YYYY-MM-DD) plus requested variables. ' +
    'Common hourly variables: temperature_2m, precipitation, wind_speed_10m, ' +
    'relative_humidity_2m, cloud_cover, uv_index, apparent_temperature, ' +
    'precipitation_probability, weather_code, surface_pressure, visibility, ' +
    'wind_direction_10m, wind_gusts_10m, dew_point_2m. ' +
    'Common daily variables: temperature_2m_max, temperature_2m_min, precipitation_sum, ' +
    'wind_speed_10m_max, sunrise, sunset, uv_index_max, precipitation_hours, weather_code. ' +
    'At least one of hourly_variables or daily_variables is required.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'invalid_variable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An unknown variable name was requested',
      recovery:
        'Check the variable name against Open-Meteo docs. Common hourly: temperature_2m, precipitation, wind_speed_10m, relative_humidity_2m, cloud_cover, uv_index. Common daily: temperature_2m_max, temperature_2m_min, precipitation_sum.',
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
        'Latitude in decimal degrees (e.g., 47.6062 for Seattle). Use openmeteo_geocode to resolve a place name to coordinates.',
      ),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .describe('Longitude in decimal degrees (e.g., -122.3321 for Seattle).'),
    hourly_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Hourly variables to fetch (e.g., ["temperature_2m", "precipitation", "wind_speed_10m", "relative_humidity_2m", "cloud_cover", "uv_index", "apparent_temperature"]). At least one of hourly_variables or daily_variables is required.',
      ),
    daily_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Daily summary variables (e.g., ["temperature_2m_max", "temperature_2m_min", "precipitation_sum", "wind_speed_10m_max", "sunrise", "sunset", "uv_index_max"]). At least one of hourly_variables or daily_variables is required.',
      ),
    forecast_days: z
      .number()
      .int()
      .min(1)
      .max(16)
      .default(7)
      .describe('Number of forecast days (1–16). Default 7.'),
    past_days: z
      .number()
      .int()
      .min(0)
      .max(92)
      .default(0)
      .describe(
        'Include this many days of past data before today (0–92). Use for recent history — ERA5 archive has a variable ~5-day lag. Default 0.',
      ),
    temperature_unit: z
      .enum(['celsius', 'fahrenheit'])
      .default('celsius')
      .describe('Temperature unit. Default "celsius".'),
    wind_speed_unit: z
      .enum(['kmh', 'mph', 'ms', 'kn'])
      .default('kmh')
      .describe(
        'Wind speed unit: "kmh" (km/h), "mph", "ms" (m/s), or "kn" (knots). Default "kmh".',
      ),
    precipitation_unit: z
      .enum(['mm', 'inch'])
      .default('mm')
      .describe('Precipitation unit: "mm" or "inch". Default "mm".'),
    timezone: z
      .string()
      .default('auto')
      .describe(
        'IANA timezone (e.g., "America/Los_Angeles") or "auto" to use the location\'s local timezone. Default "auto". The timezone from openmeteo_geocode is ideal to pass here.',
      ),
  }),

  output: z.object({
    latitude: z.number().describe('Snapped latitude (Open-Meteo snaps to nearest grid point)'),
    longitude: z.number().describe('Snapped longitude'),
    elevation: z.number().describe('Terrain elevation at grid point (meters)'),
    timezone: z.string().describe('Resolved IANA timezone'),
    utc_offset_seconds: z
      .number()
      .describe('UTC offset in seconds for this timezone at query time'),
    hourly: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Per-hour records. Each object has a "time" field (ISO 8601) plus one key per requested variable with its value. Units are in the hourly_units map. Absent when only daily_variables were requested.',
      ),
    daily: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Per-day records. Each object has a "time" field (YYYY-MM-DD) plus one key per requested variable with its value. Units are in the daily_units map. Absent when only hourly_variables were requested.',
      ),
    hourly_units: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Map of variable name → unit string for hourly data (e.g., {"temperature_2m": "°C", "precipitation": "mm"}). Absent when no hourly_variables were requested.',
      ),
    daily_units: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Map of variable name → unit string for daily data. Absent when no daily_variables were requested.',
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
    const data = await service.getForecast(
      input.latitude,
      input.longitude,
      {
        hourly: input.hourly_variables,
        daily: input.daily_variables,
        forecast_days: input.forecast_days,
        past_days: input.past_days,
        temperature_unit: input.temperature_unit,
        wind_speed_unit: input.wind_speed_unit,
        precipitation_unit: input.precipitation_unit,
        timezone: input.timezone,
      },
      ctx,
    );

    // API returns error envelope for unknown variable names
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
      elevation: data.elevation,
      timezone: data.timezone,
      utc_offset_seconds: data.utc_offset_seconds,
      hourly: data.hourly ? reshapeColumnar(data.hourly) : undefined,
      daily: data.daily ? reshapeColumnar(data.daily) : undefined,
      hourly_units: toUnitsMap(data.hourly_units as Record<string, unknown> | undefined),
      daily_units: toUnitsMap(data.daily_units as Record<string, unknown> | undefined),
    };
  },

  format: (result) => {
    const lines = [
      `## Weather forecast`,
      `**Location:** ${result.latitude}, ${result.longitude} | **Elevation:** ${result.elevation}m`,
      `**Timezone:** ${result.timezone} | **utc_offset_seconds:** ${result.utc_offset_seconds}`,
      '',
    ];

    if (result.hourly_units) {
      lines.push(`**Hourly units:** ${formatUnits(result.hourly_units)}`);
    }
    if (result.daily_units) {
      lines.push(`**Daily units:** ${formatUnits(result.daily_units)}`);
    }

    if (result.daily && result.daily.length > 0) {
      lines.push('', `### Daily summary (${result.daily.length} records)`);
      for (const rec of result.daily) lines.push(formatRecord(rec));
    }

    if (result.hourly && result.hourly.length > 0) {
      lines.push('', `### Hourly (${result.hourly.length} records)`);
      for (const rec of result.hourly) lines.push(formatRecord(rec));
    }

    lines.push('', '_Weather data by Open-Meteo.com_');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
