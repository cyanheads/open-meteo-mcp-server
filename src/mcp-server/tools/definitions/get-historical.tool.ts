/**
 * @fileoverview Tool: openmeteo_get_historical — ERA5 historical weather archive.
 * Reshapes columnar response into per-timestamp records.
 * Large date ranges (multi-year hourly) spill to DataCanvas when canvas is enabled.
 * @module mcp-server/tools/definitions/get-historical
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

export const openmeteoGetHistoricalTool = tool('openmeteo_get_historical', {
  description:
    'Historical weather from the ERA5 reanalysis archive (1940–present). Requires start_date ' +
    'and end_date (ISO 8601 date, e.g., "2024-07-01"). ERA5 has a variable lag of up to ~5 days ' +
    '— for dates within the last week, use openmeteo_get_forecast with past_days instead. ' +
    'Uses the same variable names as the forecast API for direct comparison. Large date ranges ' +
    '(multi-year hourly) produce thousands of records — these spill to DataCanvas for SQL querying ' +
    'when canvas is enabled. At least one of hourly_variables or daily_variables is required.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'date_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'start_date predates 1940-01-01 or end_date is within the ERA5 lag window',
      recovery:
        'Use start_date >= 1940-01-01. For dates within the last ~5 days, use openmeteo_get_forecast with past_days instead.',
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
      reason: 'no_variables_requested',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither hourly_variables nor daily_variables was provided',
      recovery: 'Provide at least one of hourly_variables or daily_variables.',
      retryable: false,
    },
    {
      reason: 'invalid_variable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An unknown variable name was requested',
      recovery:
        'Check the variable name against Open-Meteo docs. Common hourly: temperature_2m, precipitation, wind_speed_10m, relative_humidity_2m, cloud_cover. Common daily: temperature_2m_max, temperature_2m_min, precipitation_sum.',
      retryable: false,
    },
  ],

  input: z.object({
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .describe(
        'Latitude in decimal degrees. Use openmeteo_geocode to resolve a place name to coordinates.',
      ),
    longitude: z.number().min(-180).max(180).describe('Longitude in decimal degrees.'),
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe(
        'Start date (YYYY-MM-DD, e.g., "2024-07-01"). ERA5 covers from 1940-01-01 to approximately 5 days ago.',
      ),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe(
        'End date (YYYY-MM-DD, inclusive). Must be on or after start_date. For dates within the last ~5 days, use openmeteo_get_forecast with past_days instead.',
      ),
    hourly_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Hourly ERA5 variables (e.g., ["temperature_2m", "precipitation", "wind_speed_10m", "relative_humidity_2m", "cloud_cover", "soil_moisture_0_to_7cm"]). At least one of hourly_variables or daily_variables required.',
      ),
    daily_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Daily summary variables (e.g., ["temperature_2m_max", "temperature_2m_min", "precipitation_sum", "wind_speed_10m_max"]). At least one of hourly_variables or daily_variables required.',
      ),
    temperature_unit: z
      .enum(['celsius', 'fahrenheit'])
      .default('celsius')
      .describe('Temperature unit. Default "celsius".'),
    wind_speed_unit: z
      .enum(['kmh', 'mph', 'ms', 'kn'])
      .default('kmh')
      .describe('Wind speed unit. Default "kmh".'),
    precipitation_unit: z
      .enum(['mm', 'inch'])
      .default('mm')
      .describe('Precipitation unit. Default "mm".'),
    timezone: z.string().default('auto').describe('IANA timezone or "auto". Default "auto".'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas token for multi-year or multi-variable queries. When a result is too large to return inline — driven by total payload size, so a wide multi-variable pull can spill at any row count — it spills to this canvas for SQL querying. Omit to create a fresh canvas.',
      ),
  }),

  output: z.object({
    latitude: z.number().describe('Snapped latitude'),
    longitude: z.number().describe('Snapped longitude'),
    elevation: z.number().describe('Elevation at grid point (meters)'),
    timezone: z.string().describe('Resolved IANA timezone'),
    date_range: z
      .object({
        start: z.string().describe('Actual start date of returned data'),
        end: z.string().describe('Actual end date of returned data'),
      })
      .describe('Date range of returned data'),
    record_count: z
      .number()
      .describe('Total number of records (hourly or daily rows) in this response'),
    hourly: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Per-hour records with "time" (ISO 8601) + variable keys. Absent when only daily_variables were requested. When truncated, contains only a preview; query canvas_id for the full dataset.',
      ),
    daily: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Per-day records with "time" (YYYY-MM-DD) + variable keys. Absent when only hourly_variables were requested. When truncated, contains only a preview; query canvas_id for the full dataset.',
      ),
    hourly_units: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Variable → unit string for hourly data (e.g., {"temperature_2m": "°C", "precipitation": "mm"}). Absent when no hourly_variables were requested.',
      ),
    daily_units: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Variable → unit string for daily data. Absent when no daily_variables were requested.',
      ),
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
        'True when the response was too large to return inline and data spilled to canvas_id. Query the canvas for the full dataset — it holds every hourly and daily row, including any column the preview omits.',
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

    if (input.end_date < input.start_date) {
      throw ctx.fail(
        'date_order_invalid',
        `end_date (${input.end_date}) is before start_date (${input.start_date}).`,
        ctx.recoveryFor('date_order_invalid'),
      );
    }

    if (input.start_date < '1940-01-01') {
      throw ctx.fail(
        'date_out_of_range',
        `start_date ${input.start_date} predates ERA5 coverage (1940-01-01).`,
        ctx.recoveryFor('date_out_of_range'),
      );
    }

    const service = getOpenMeteoService();
    const data = await service.getHistorical(
      input.latitude,
      input.longitude,
      {
        start_date: input.start_date,
        end_date: input.end_date,
        hourly: input.hourly_variables,
        daily: input.daily_variables,
        temperature_unit: input.temperature_unit,
        wind_speed_unit: input.wind_speed_unit,
        precipitation_unit: input.precipitation_unit,
        timezone: input.timezone,
      },
      ctx,
    );

    if (data.error) {
      const reason = data.reason ?? '';
      if (reason.toLowerCase().includes('date') || reason.toLowerCase().includes('range')) {
        throw ctx.fail(
          'date_out_of_range',
          reason || 'Date out of ERA5 range.',
          ctx.recoveryFor('date_out_of_range'),
        );
      }
      throw ctx.fail(
        'invalid_variable',
        frameInvalidVariableMessage(data.reason),
        ctx.recoveryFor('invalid_variable'),
      );
    }

    const hourlyRecords = data.hourly ? reshapeColumnar(data.hourly) : undefined;
    const dailyRecords = data.daily ? reshapeColumnar(data.daily) : undefined;

    const records = hourlyRecords ?? dailyRecords;
    const allRecords = [...(hourlyRecords ?? []), ...(dailyRecords ?? [])];
    const dateRange = {
      start: (records?.[0]?.time as string) ?? input.start_date,
      end: (records?.[records.length - 1]?.time as string) ?? input.end_date,
    };

    // DataCanvas spillover for payloads too large to return inline
    if (exceedsInlineBudget(allRecords)) {
      const canvas = getCanvas();
      if (canvas) {
        const instance = await canvas.acquire(input.canvas_id, ctx);
        // Explicit schema over every staged row — hourly records lead, so a sniffed
        // window would never reach a daily row. See deriveSpillSchema.
        const spilled = await spillover({
          canvas: instance,
          source: allRecords,
          schema: deriveSpillSchema(allRecords),
          previewChars: PREVIEW_CHARS,
          signal: ctx.signal,
        });

        return {
          latitude: data.latitude,
          longitude: data.longitude,
          elevation: data.elevation,
          timezone: data.timezone,
          date_range: dateRange,
          record_count: spilled.spilled ? spilled.handle.rowCount : allRecords.length,
          hourly: spilled.previewRows.filter(
            (r) => typeof r.time === 'string' && r.time.includes('T'),
          ) as Record<string, unknown>[],
          daily: spilled.previewRows.filter(
            (r) => typeof r.time === 'string' && !r.time.includes('T'),
          ) as Record<string, unknown>[],
          hourly_units: toUnitsMap(data.hourly_units as Record<string, unknown> | undefined),
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
      elevation: data.elevation,
      timezone: data.timezone,
      date_range: dateRange,
      record_count: allRecords.length,
      hourly: hourlyRecords,
      daily: dailyRecords,
      hourly_units: toUnitsMap(data.hourly_units as Record<string, unknown> | undefined),
      daily_units: toUnitsMap(data.daily_units as Record<string, unknown> | undefined),
      canvas_id: undefined,
      table_name: undefined,
      truncated: false,
    };
  },

  format: (result) => {
    const lines = [
      `## Historical weather (ERA5)`,
      `**Location:** ${result.latitude}, ${result.longitude} | **Elevation:** ${result.elevation}m | **Timezone:** ${result.timezone}`,
      `**Date range:** ${result.date_range.start} → ${result.date_range.end} | **Records:** ${result.record_count} | **Truncated:** ${result.truncated}`,
    ];

    if (result.truncated && result.canvas_id) {
      lines.push(
        `\n⚠️ Large result — full data staged on canvas \`${result.canvas_id}\`, table \`${result.table_name}\`. Query with SQL via openmeteo_dataframe_query.`,
      );
    }

    if (result.hourly_units) lines.push(`\n**Hourly units:** ${formatUnits(result.hourly_units)}`);
    if (result.daily_units) lines.push(`**Daily units:** ${formatUnits(result.daily_units)}`);

    if (result.daily && result.daily.length > 0) {
      // When truncated, result.daily is the spillover preview array — render all of
      // it so content[] matches structuredContent.daily; the heading references
      // record_count (the full staged total), not the preview length.
      lines.push(
        '',
        result.truncated
          ? `### Daily summary (preview — ${result.daily.length} shown of ${result.record_count} total rows on canvas)`
          : `### Daily summary (${result.daily.length} records)`,
      );
      for (const rec of result.daily) lines.push(formatRecord(rec));
    }

    if (result.hourly && result.hourly.length > 0) {
      // When truncated, result.hourly is the spillover preview array — render all of
      // it so content[] matches structuredContent.hourly; the heading references
      // record_count (the full staged total), not the preview length.
      lines.push(
        '',
        result.truncated
          ? `### Hourly (preview — ${result.hourly.length} shown of ${result.record_count} total rows on canvas)`
          : `### Hourly (${result.hourly.length} records)`,
      );
      for (const rec of result.hourly) lines.push(formatRecord(rec));
    }

    lines.push('', '_Weather data by Open-Meteo.com_');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
