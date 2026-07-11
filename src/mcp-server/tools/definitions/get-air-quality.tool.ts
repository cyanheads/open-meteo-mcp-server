/**
 * @fileoverview Tool: openmeteo_get_air_quality — CAMS air quality forecast.
 * Reshapes columnar response into per-timestamp records.
 * @module mcp-server/tools/definitions/get-air-quality
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';
import { toUnitsMap } from '@/services/open-meteo/types.js';
import { formatRecord, formatUnits, reshapeColumnar } from '../reshape-utils.js';
import { frameInvalidVariableMessage } from '../upstream-error.js';

export const openmeteoGetAirQualityTool = tool('openmeteo_get_air_quality', {
  description:
    'Modeled CAMS (Copernicus Atmosphere Monitoring Service) air quality forecast: PM2.5, PM10, ' +
    'nitrogen dioxide, sulphur dioxide, ozone, carbon monoxide, dust, pollen, and European/US AQI ' +
    'indices. This is modeled grid data, not measured station readings — for measured data, use ' +
    'openaq-mcp-server. Forecast only (no historical archive). ' +
    'Common variables: pm2_5, pm10, carbon_monoxide, nitrogen_dioxide, sulphur_dioxide, ozone, ' +
    'dust, european_aqi, us_aqi, alder_pollen, birch_pollen, grass_pollen, mugwort_pollen, ' +
    'olive_pollen, ragweed_pollen.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'invalid_variable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An unknown air quality variable name was requested',
      recovery:
        'Check variable names. Common: pm2_5, pm10, ozone, nitrogen_dioxide, sulphur_dioxide, carbon_monoxide, european_aqi, us_aqi.',
      retryable: false,
    },
    {
      reason: 'no_variables_requested',
      code: JsonRpcErrorCode.ValidationError,
      when: 'hourly_variables was not provided or is empty',
      recovery: 'Provide hourly_variables with at least one air quality variable.',
      retryable: false,
    },
  ],

  input: z.object({
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .describe('Latitude in decimal degrees. Use openmeteo_geocode to resolve a place name.'),
    longitude: z.number().min(-180).max(180).describe('Longitude in decimal degrees.'),
    hourly_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Hourly air quality variables (e.g., ["pm2_5", "pm10", "ozone", "nitrogen_dioxide", "european_aqi", "us_aqi"]). At least one required.',
      ),
    forecast_days: z
      .number()
      .int()
      .min(1)
      .max(7)
      .default(5)
      .describe('Forecast horizon in days (1–7). Default 5.'),
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
        'Per-hour records with "time" (ISO 8601) + one key per requested variable. Units: pm2_5/pm10/dust in μg/m³, carbon_monoxide in μg/m³, nitrogen_dioxide/sulphur_dioxide/ozone in μg/m³, european_aqi/us_aqi as index values.',
      ),
    hourly_units: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Variable → unit string for hourly data (e.g., {"pm2_5": "μg/m³", "european_aqi": "EAQI"}).',
      ),
    data_source: z
      .literal('CAMS')
      .describe(
        'Data source identifier — this is modeled forecast data from CAMS, not measured station data.',
      ),
  }),

  async handler(input, ctx) {
    const hasHourly = (input.hourly_variables?.length ?? 0) > 0;
    if (!hasHourly) {
      throw ctx.fail(
        'no_variables_requested',
        'Provide hourly_variables with at least one air quality variable.',
        ctx.recoveryFor('no_variables_requested'),
      );
    }

    const service = getOpenMeteoService();
    const data = await service.getAirQuality(
      input.latitude,
      input.longitude,
      {
        hourly: input.hourly_variables,
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
      hourly_units: toUnitsMap(data.hourly_units as Record<string, unknown> | undefined),
      data_source: 'CAMS' as const,
    };
  },

  format: (result) => {
    const lines = [
      `## CAMS Air Quality forecast`,
      `**Location:** ${result.latitude}, ${result.longitude} | **Timezone:** ${result.timezone}`,
      `**Source:** CAMS modeled forecast (not measured station data)`,
      '',
    ];

    if (result.hourly_units) lines.push(`**Hourly units:** ${formatUnits(result.hourly_units)}`);

    if (result.hourly && result.hourly.length > 0) {
      lines.push('', `### Hourly air quality (${result.hourly.length} records)`);
      for (const rec of result.hourly) lines.push(formatRecord(rec));
    }

    lines.push('', '_Weather data by Open-Meteo.com_');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
