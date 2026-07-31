/**
 * @fileoverview Tool: openmeteo_get_historical — ERA5 historical weather archive.
 * Reshapes columnar response into per-timestamp records.
 * Large date ranges (multi-year hourly) spill to DataCanvas when canvas is enabled,
 * and return a bounded preview with truncated: true when it is not.
 * @module mcp-server/tools/definitions/get-historical
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';
import { toUnitsMap } from '@/services/open-meteo/types.js';
import { formatRecord, formatUnits, reshapeColumnar } from '../reshape-utils.js';
import {
  boundedPreview,
  deriveSpillSchema,
  exceedsInlineBudget,
  noCanvasNotice,
  PREVIEW_CHARS,
  splitByCadence,
} from '../spill-utils.js';
import { frameInvalidVariableMessage } from '../upstream-error.js';
import {
  describeCadenceMismatches,
  findCadenceMismatches,
  HISTORICAL_CADENCE,
  undefinedUnitColumns,
} from '../variable-cadence.js';

export const openmeteoGetHistoricalTool = tool('openmeteo_get_historical', {
  description:
    'Historical weather from the ERA5 reanalysis archive (1940–present). Requires start_date ' +
    'and end_date (ISO 8601 date, e.g., "2024-07-01"). ERA5 has a variable lag of up to ~5 days ' +
    '— for dates within the last week, use openmeteo_get_forecast with past_days instead. ' +
    'Uses the same variable names as the forecast API for direct comparison. Large date ranges ' +
    '(multi-year hourly) produce thousands of records — these spill to DataCanvas for SQL querying ' +
    'when canvas is enabled, and return a bounded preview with truncated: true when it is not. ' +
    'At least one of hourly_variables or daily_variables is required.',
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
    {
      reason: 'variable_wrong_cadence',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A variable Open-Meteo documents under one cadence was passed in the other cadence field — for example cloud_cover in daily_variables, or temperature_2m_max in hourly_variables',
      recovery:
        'Move each variable the message names to the field the message names, or drop it — hourly_variables and daily_variables take separate ERA5 variable sets, and the message lists the same-cadence alternatives when the archive publishes any.',
      retryable: false,
    },
  ],

  input: z.object({
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .describe(
        'Latitude in decimal degrees. Use openmeteo_search_locations to resolve a place name to coordinates.',
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
        'Hourly ERA5 variables (e.g., ["temperature_2m", "precipitation", "wind_speed_10m", "relative_humidity_2m", "cloud_cover", "soil_moisture_0_to_7cm"]). Hourly names only — a daily aggregate such as temperature_2m_max or precipitation_sum belongs in daily_variables and is rejected here. At least one of hourly_variables or daily_variables required.',
      ),
    daily_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Daily summary variables (e.g., ["temperature_2m_max", "temperature_2m_min", "precipitation_sum", "wind_speed_10m_max"]). Daily names only — an hourly name such as cloud_cover or temperature_2m belongs in hourly_variables and is rejected here; for a daily summary of an hourly variable use its published aggregate (cloud_cover_max, cloud_cover_mean, cloud_cover_min). At least one of hourly_variables or daily_variables required.',
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
      .describe(
        'Total number of records (hourly + daily rows) — the full upstream total when truncated is true, not the combined length of the hourly and daily previews.',
      ),
    hourly: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Per-hour records with "time" (ISO 8601) + variable keys. Absent when only daily_variables were requested. When truncated, contains only a preview — query canvas_id for the full dataset when one is present.',
      ),
    daily: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Per-day records with "time" (YYYY-MM-DD) + variable keys. Absent when only hourly_variables were requested. When truncated, contains only a preview — query canvas_id for the full dataset when one is present.',
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
        'DataCanvas token for the staged full dataset. Present only when truncated is true AND DataCanvas is enabled (CANVAS_PROVIDER_TYPE=duckdb) — absent otherwise, in which case the preview is all this response carries. Query with SQL using this token.',
      ),
    table_name: z
      .string()
      .optional()
      .describe(
        'DuckDB table name for the staged data — pass to openmeteo_dataframe_query. Present only alongside canvas_id.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when the response was too large to return inline, so hourly and daily carry a bounded preview rather than the full set. With DataCanvas enabled the complete data is staged at canvas_id — every hourly and daily row, including any column the preview omits. With it disabled there is no canvas_id, and the omitted rows are reached only by narrowing the request.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Warning that a requested variable came back with no data — names each column whose unit is "undefined", which is how the archive reports a name it parsed but does not serve in the requested cadence.',
      ),
  },

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

    /*
     * Reject a confident misplacement before the call. The archive answers one
     * direction with a 400 that echoes the entire encoded variable list — valid
     * siblings included, so the offender is never isolated — and the other with a
     * successful all-null column. Unknown names are not misplacements and go upstream
     * untouched.
     */
    const mismatches = findCadenceMismatches(
      HISTORICAL_CADENCE,
      input.hourly_variables,
      input.daily_variables,
    );
    if (mismatches.length > 0) {
      throw ctx.fail(
        'variable_wrong_cadence',
        describeCadenceMismatches(mismatches),
        ctx.recoveryFor('variable_wrong_cadence'),
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

    const hourlyUnits = toUnitsMap(data.hourly_units as Record<string, unknown> | undefined);
    const dailyUnits = toUnitsMap(data.daily_units as Record<string, unknown> | undefined);

    /*
     * Backstop for a name the catalog does not carry: the archive answers some
     * wrong-cadence names with HTTP 200 and an all-null column whose unit is the
     * literal string "undefined". Left unsaid that reads as a genuine data gap.
     */
    const emptyColumns = undefinedUnitColumns(hourlyUnits, dailyUnits);
    if (emptyColumns.length > 0) {
      ctx.enrich.notice(
        `${emptyColumns.join(', ')} returned no data — Open-Meteo reported the unit as "undefined", which means the archive does not serve that name in the cadence it was requested under. Check the spelling, and whether it belongs in hourly_variables or daily_variables.`,
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

        const spilledPreview = splitByCadence(spilled.previewRows);

        return {
          latitude: data.latitude,
          longitude: data.longitude,
          elevation: data.elevation,
          timezone: data.timezone,
          date_range: dateRange,
          record_count: spilled.spilled ? spilled.handle.rowCount : allRecords.length,
          hourly: spilledPreview.hourly,
          daily: spilledPreview.daily,
          hourly_units: hourlyUnits,
          daily_units: dailyUnits,
          // Only point at the canvas when data actually spilled — spillover()
          // stages a table only past its byte threshold, so a canvas_id on the
          // non-spilled path would reference an empty canvas.
          canvas_id: spilled.spilled ? instance.canvasId : undefined,
          table_name: spilled.spilled ? spilled.handle.tableName : undefined,
          truncated: spilled.spilled,
        };
      }

      /*
       * No canvas (CANVAS_PROVIDER_TYPE=none, the default): bound the preview anyway.
       * Falling through to the full inline return would report truncated: false on a
       * multi-megabyte payload. Split by timestamp shape the same way the canvas
       * branch splits spillover()'s preview rows, so both paths return the same
       * preview for the same records.
       */
      const preview = splitByCadence(boundedPreview(allRecords));
      return {
        latitude: data.latitude,
        longitude: data.longitude,
        elevation: data.elevation,
        timezone: data.timezone,
        date_range: dateRange,
        record_count: allRecords.length,
        hourly: preview.hourly,
        daily: preview.daily,
        hourly_units: hourlyUnits,
        daily_units: dailyUnits,
        canvas_id: undefined,
        table_name: undefined,
        truncated: true,
      };
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
      hourly_units: hourlyUnits,
      daily_units: dailyUnits,
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
    } else if (result.truncated) {
      lines.push(
        `\n${noCanvasNotice('a shorter start_date–end_date range, or fewer hourly_variables / daily_variables')}`,
      );
    }

    if (result.hourly_units) lines.push(`\n**Hourly units:** ${formatUnits(result.hourly_units)}`);
    if (result.daily_units) lines.push(`**Daily units:** ${formatUnits(result.daily_units)}`);

    // "on canvas" only when one exists — with canvas disabled the total is the
    // upstream row count and nothing holds the rows the preview omits.
    const totalRows = `${result.record_count} total rows${result.canvas_id ? ' on canvas' : ''}`;

    if (result.daily && result.daily.length > 0) {
      // When truncated, result.daily is the preview array — render all of it so
      // content[] matches structuredContent.daily; the heading references
      // record_count (the full upstream total), not the preview length.
      lines.push(
        '',
        result.truncated
          ? `### Daily summary (preview — ${result.daily.length} shown of ${totalRows})`
          : `### Daily summary (${result.daily.length} records)`,
      );
      for (const rec of result.daily) lines.push(formatRecord(rec));
    }

    if (result.hourly && result.hourly.length > 0) {
      // When truncated, result.hourly is the preview array — render all of it so
      // content[] matches structuredContent.hourly; the heading references
      // record_count (the full upstream total), not the preview length.
      lines.push(
        '',
        result.truncated
          ? `### Hourly (preview — ${result.hourly.length} shown of ${totalRows})`
          : `### Hourly (${result.hourly.length} records)`,
      );
      for (const rec of result.hourly) lines.push(formatRecord(rec));
    }

    lines.push('', '_Weather data by Open-Meteo.com_');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
