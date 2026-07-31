/**
 * @fileoverview Tool: openmeteo_get_air_quality — CAMS air quality forecast and archive.
 * Reshapes columnar response into per-timestamp records. Serves either the forecast
 * window (forecast_days + past_days) or an archive range (start_date + end_date), which
 * upstream treats as mutually exclusive. A wide window reaches the same payload class as
 * the other spill-capable tools, so it carries the shared spillover pattern: spill to
 * DataCanvas when canvas is enabled, bounded preview with truncated: true when it is not.
 * @module mcp-server/tools/definitions/get-air-quality
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';
import {
  type AirQualityParams,
  getOpenMeteoService,
} from '@/services/open-meteo/open-meteo-service.js';
import { toUnitsMap } from '@/services/open-meteo/types.js';
import { formatRecord, formatUnits, reshapeColumnar } from '../reshape-utils.js';
import {
  boundedPreview,
  deriveSpillSchema,
  exceedsInlineBudget,
  noCanvasNotice,
  PREVIEW_CHARS,
} from '../spill-utils.js';
import { frameInvalidVariableMessage } from '../upstream-error.js';
import { undefinedUnitColumns } from '../variable-cadence.js';

export const openmeteoGetAirQualityTool = tool('openmeteo_get_air_quality', {
  description:
    'Modeled CAMS (Copernicus Atmosphere Monitoring Service) air quality: PM2.5, PM10, ' +
    'nitrogen dioxide, sulphur dioxide, ozone, carbon monoxide, dust, pollen, and European/US AQI ' +
    'indices. This is modeled grid data, not measured station readings — for measured data, use ' +
    'openaq-mcp-server. Forecast horizon up to 7 days, with optional past_days (up to 92) for ' +
    'recent history — or start_date and end_date together for an archive range, which returns real ' +
    'CAMS values back to at least 2022-10-01. One window per call: a date range is mutually ' +
    'exclusive with forecast_days and past_days, and needs both ends — a lone start_date or ' +
    'end_date is rejected. ' +
    'Common variables: pm2_5, pm10, carbon_monoxide, nitrogen_dioxide, sulphur_dioxide, ozone, ' +
    'dust, european_aqi, us_aqi, alder_pollen, birch_pollen, grass_pollen, mugwort_pollen, ' +
    'olive_pollen, ragweed_pollen. ' +
    'A wide window — a large past_days or date range plus many variables — produces thousands of ' +
    'records; these spill to DataCanvas for SQL querying when canvas is enabled, and return a ' +
    'bounded preview with truncated: true when it is not.',
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
    {
      reason: 'date_range_incomplete',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Only one of start_date / end_date was provided — the CAMS archive requires the pair together',
      recovery:
        'Provide both start_date and end_date to pull an archive range, or omit both and use forecast_days / past_days for the forecast window.',
      retryable: false,
    },
    {
      reason: 'forecast_window_conflict',
      code: JsonRpcErrorCode.ValidationError,
      when: 'forecast_days or a non-zero past_days was combined with start_date or end_date',
      recovery:
        'Drop forecast_days and past_days to pull the archive range, or drop start_date and end_date to pull the forecast window — the endpoint accepts one window per call, never both.',
      retryable: false,
    },
  ],

  input: z.object({
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .describe(
        'Latitude in decimal degrees. Use openmeteo_search_locations to resolve a place name.',
      ),
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
      .optional()
      .describe(
        'Forecast horizon in days (1–7). Omit for the upstream default of 5. Mutually exclusive with start_date/end_date — omit it entirely when pulling an archive range.',
      ),
    past_days: z
      .number()
      .int()
      .min(0)
      .max(92)
      .default(0)
      .describe(
        'Include this many days of past data before today (0–92). Use for recent history instead of a start_date/end_date range. Default 0. Must stay 0 when start_date/end_date are used.',
      ),
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'Start date for the archive range (YYYY-MM-DD, e.g., "2024-07-01"). Real CAMS values go back to at least 2022-10-01; earlier dates return rows of nulls. Requires end_date — the pair must be sent together, and neither combines with forecast_days or past_days.',
      ),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'End date for the archive range (YYYY-MM-DD, inclusive). Must be on or after start_date. Requires start_date — the pair must be sent together, and neither combines with forecast_days or past_days.',
      ),
    timezone: z.string().default('auto').describe('IANA timezone or "auto". Default "auto".'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas token for wide past_days, archive-range, or multi-variable queries. When a result is too large to return inline — driven by total payload size, so a wide multi-variable pull can spill at any row count — it spills to this canvas for SQL querying. Omit to create a fresh canvas.',
      ),
  }),

  output: z.object({
    latitude: z.number().describe('Snapped latitude'),
    longitude: z.number().describe('Snapped longitude'),
    timezone: z.string().describe('Resolved IANA timezone'),
    record_count: z
      .number()
      .describe(
        'Total number of hourly records — the full upstream total when truncated is true, not the length of the hourly preview.',
      ),
    hourly: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Per-hour records with "time" (ISO 8601) + one key per requested variable. Units: pm2_5/pm10/dust in μg/m³, carbon_monoxide in μg/m³, nitrogen_dioxide/sulphur_dioxide/ozone in μg/m³, european_aqi/us_aqi as index values. When truncated, contains only a preview — query canvas_id for the full dataset when one is present.',
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
        'Data source identifier — this is modeled CAMS data, forecast or archive, not measured station data.',
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
        'True when the response was too large to return inline, so hourly carries a bounded preview rather than the full set. With DataCanvas enabled the complete data is staged at canvas_id. With it disabled there is no canvas_id, and the omitted rows are reached only by narrowing the request.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Warning that a requested variable came back with no data — names each column whose unit is "undefined", which is how the endpoint reports a name it parsed but does not serve.',
      ),
  },

  async handler(input, ctx) {
    const hasHourly = (input.hourly_variables?.length ?? 0) > 0;
    if (!hasHourly) {
      throw ctx.fail(
        'no_variables_requested',
        'Provide hourly_variables with at least one air quality variable.',
        ctx.recoveryFor('no_variables_requested'),
      );
    }

    /**
     * The air-quality endpoint takes the forecast window or an archive range, never
     * both, and rejects a half-specified range. Guarding here rather than letting
     * upstream reject keeps both cases off the post-call invalid_variable branch, which
     * frames every rejection as an unknown variable name — advice that fixes neither.
     */
    const hasStart = input.start_date !== undefined;
    const hasEnd = input.end_date !== undefined;

    // Window conflict outranks pairing: when a forecast window arrives with a
    // half-specified range, both faults are present, but only this one names the
    // caller's actual choice. Reporting the pair first would answer "or omit both and
    // use forecast_days" to a caller who already did exactly that.
    if ((input.forecast_days !== undefined || input.past_days > 0) && (hasStart || hasEnd)) {
      throw ctx.fail(
        'forecast_window_conflict',
        'forecast_days/past_days cannot be combined with start_date/end_date — the air-quality endpoint serves either the forecast window or an archive range, not both.',
        ctx.recoveryFor('forecast_window_conflict'),
      );
    }

    if (hasStart !== hasEnd) {
      throw ctx.fail(
        'date_range_incomplete',
        `The CAMS archive needs start_date and end_date together — only ${hasStart ? 'start_date' : 'end_date'} was provided.`,
        ctx.recoveryFor('date_range_incomplete'),
      );
    }

    // past_days: 0 is the schema default, not an opt-in — sending it alongside a date
    // range is exactly the combination upstream rejects, so the two windows are built
    // as disjoint parameter sets rather than merged.
    const window: AirQualityParams = hasStart
      ? { start_date: input.start_date, end_date: input.end_date }
      : { forecast_days: input.forecast_days, past_days: input.past_days };

    const service = getOpenMeteoService();
    const data = await service.getAirQuality(
      input.latitude,
      input.longitude,
      {
        hourly: input.hourly_variables,
        ...window,
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

    const hourlyUnits = toUnitsMap(data.hourly_units as Record<string, unknown> | undefined);

    /*
     * The endpoint shares the forecast API's hourly variable parser, so it answers a
     * weather variable name it does not serve — temperature_2m_max, say — with HTTP
     * 200 and an all-null column whose unit is the literal string "undefined" rather
     * than an error. Left unsaid that reads as a genuine data gap.
     */
    const emptyColumns = undefinedUnitColumns(hourlyUnits);
    if (emptyColumns.length > 0) {
      ctx.enrich.notice(
        `${emptyColumns.join(', ')} returned no data — Open-Meteo reported the unit as "undefined", which means the air-quality endpoint does not serve that name. Check it against the air-quality variable list (pm2_5, pm10, ozone, nitrogen_dioxide, european_aqi, us_aqi, …); weather variables belong in openmeteo_get_forecast.`,
      );
    }

    const hourlyRecords = data.hourly ? reshapeColumnar(data.hourly) : undefined;

    // DataCanvas spillover for payloads too large to return inline
    if (hourlyRecords && exceedsInlineBudget(hourlyRecords)) {
      const canvas = getCanvas();
      if (canvas) {
        const instance = await canvas.acquire(input.canvas_id, ctx);
        // Explicit schema over every staged row — an archive range that starts before
        // CAMS coverage is null down its whole column. See deriveSpillSchema.
        const spilled = await spillover({
          canvas: instance,
          source: hourlyRecords,
          schema: deriveSpillSchema(hourlyRecords),
          previewChars: PREVIEW_CHARS,
          signal: ctx.signal,
        });

        return {
          latitude: data.latitude,
          longitude: data.longitude,
          timezone: data.timezone,
          record_count: spilled.spilled ? spilled.handle.rowCount : hourlyRecords.length,
          hourly: spilled.previewRows as Record<string, unknown>[],
          hourly_units: hourlyUnits,
          data_source: 'CAMS' as const,
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
       * 92-day hourly window.
       */
      return {
        latitude: data.latitude,
        longitude: data.longitude,
        timezone: data.timezone,
        record_count: hourlyRecords.length,
        hourly: boundedPreview(hourlyRecords),
        hourly_units: hourlyUnits,
        data_source: 'CAMS' as const,
        canvas_id: undefined,
        table_name: undefined,
        truncated: true,
      };
    }

    return {
      latitude: data.latitude,
      longitude: data.longitude,
      timezone: data.timezone,
      record_count: hourlyRecords?.length ?? 0,
      hourly: hourlyRecords,
      hourly_units: hourlyUnits,
      data_source: 'CAMS' as const,
      canvas_id: undefined,
      table_name: undefined,
      truncated: false,
    };
  },

  format: (result) => {
    const lines = [
      '## CAMS air quality',
      `**Location:** ${result.latitude}, ${result.longitude} | **Timezone:** ${result.timezone}`,
      `**Source:** ${result.data_source} modeled data (not measured station data)`,
      `**Records:** ${result.record_count} | **Truncated:** ${result.truncated}`,
      '',
    ];

    if (result.truncated && result.canvas_id) {
      lines.push(
        `⚠️ Large result — full data staged on canvas \`${result.canvas_id}\`, table \`${result.table_name}\`. Query with SQL via openmeteo_dataframe_query.`,
        '',
      );
    } else if (result.truncated) {
      lines.push(
        noCanvasNotice(
          'fewer past_days / forecast_days or a shorter start_date–end_date range, or fewer hourly_variables',
        ),
        '',
      );
    }

    if (result.hourly_units) lines.push(`**Hourly units:** ${formatUnits(result.hourly_units)}`);

    if (result.hourly && result.hourly.length > 0) {
      // When truncated, result.hourly is the preview array — render all of it so
      // content[] matches structuredContent.hourly; the heading references
      // record_count (the full upstream total), not the preview length. "on canvas"
      // only when one exists — with canvas disabled nothing holds the omitted rows.
      lines.push(
        '',
        result.truncated
          ? `### Hourly air quality (preview — ${result.hourly.length} shown of ${result.record_count} total rows${result.canvas_id ? ' on canvas' : ''})`
          : `### Hourly air quality (${result.hourly.length} records)`,
      );
      for (const rec of result.hourly) lines.push(formatRecord(rec));
    }

    lines.push('', '_Weather data by Open-Meteo.com_');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
