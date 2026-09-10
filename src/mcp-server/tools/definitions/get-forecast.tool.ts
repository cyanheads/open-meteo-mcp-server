/**
 * @fileoverview Tool: openmeteo_get_forecast — weather forecast for coordinates.
 * Reshapes the columnar API response into per-timestamp records.
 * A wide window — past_days up to 92 alongside forecast_days up to 16 — reaches the
 * same payload class as openmeteo_get_historical, so it carries the shared spillover
 * pattern: spill to DataCanvas when canvas is enabled, bounded preview with
 * truncated: true when it is not.
 * @module mcp-server/tools/definitions/get-forecast
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';
import { toUnitsMap } from '@/services/open-meteo/types.js';
import { formatRecord, formatUnits, reshapeColumnar } from '../reshape-utils.js';
import { composeNotice, describeCoverageGaps, findCoverageGaps } from '../response-notice.js';
import {
  boundedPreviewByCadence,
  canvasPointerLine,
  canvasPointerNotice,
  exceedsInlineBudget,
  inlineBudget,
  noCanvasNotice,
  stageSpill,
  unitsTrimmedNotice,
} from '../spill-utils.js';
import {
  BLANK_TIMEZONE_MESSAGE,
  frameInvalidTimezoneMessage,
  isInvalidTimezoneReason,
} from '../timezone-input.js';
import { frameInvalidVariableMessage } from '../upstream-error.js';
import {
  describeCadenceMismatches,
  FORECAST_CADENCE,
  findCadenceMismatches,
  undefinedUnitColumns,
} from '../variable-cadence.js';

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
    'A wide window — a large past_days plus many hourly variables — produces thousands of ' +
    'records; these spill to a DataCanvas when canvas is enabled, returning canvas_id and ' +
    'table_name with truncated: true — inspect the staged columns with ' +
    'openmeteo_dataframe_describe, then query the full set with openmeteo_dataframe_query. ' +
    'With canvas disabled they return a bounded preview instead. ' +
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
      reason: 'variable_wrong_cadence',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A variable Open-Meteo documents under one cadence was passed in the other cadence field — for example cloud_cover in daily_variables, or temperature_2m_max in hourly_variables',
      recovery:
        'Move each variable the message names to the field the message names, or drop it — hourly_variables and daily_variables take separate Open-Meteo variable sets, and the message lists the same-cadence alternatives when the endpoint publishes any.',
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
      reason: 'invalid_timezone',
      code: JsonRpcErrorCode.ValidationError,
      when: 'timezone was blank, or upstream did not recognize the requested time zone',
      recovery:
        'Set timezone to "auto" or an exact IANA time-zone name such as "America/Los_Angeles", or omit it entirely to use the "auto" default.',
      retryable: false,
    },
  ],

  input: z.object({
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .describe(
        'Latitude in decimal degrees (e.g., 47.6062 for Seattle). Use openmeteo_search_locations to resolve a place name to coordinates.',
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
        'Hourly variables to fetch (e.g., ["temperature_2m", "precipitation", "wind_speed_10m", "relative_humidity_2m", "cloud_cover", "uv_index", "apparent_temperature"]). Hourly names only — a daily aggregate such as temperature_2m_max or precipitation_sum belongs in daily_variables and is rejected here. At least one of hourly_variables or daily_variables is required.',
      ),
    daily_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Daily summary variables (e.g., ["temperature_2m_max", "temperature_2m_min", "precipitation_sum", "wind_speed_10m_max", "sunrise", "sunset", "uv_index_max"]). Daily names only — an hourly name such as cloud_cover or temperature_2m belongs in hourly_variables and is rejected here; for a daily summary of an hourly variable use its published aggregate (cloud_cover_max, cloud_cover_mean, cloud_cover_min). At least one of hourly_variables or daily_variables is required.',
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
        'IANA timezone (e.g., "America/Los_Angeles") or "auto" to use the location\'s local timezone. Default "auto". The timezone from openmeteo_search_locations is ideal to pass here.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas token for wide past_days or multi-variable queries. When a result is too large to return inline — driven by total payload size, so a wide multi-variable pull can spill at any row count — it spills to this canvas: pass the returned token to openmeteo_dataframe_describe to list the staged table and its columns, then to openmeteo_dataframe_query to run SQL against it. Omit to create a fresh canvas.',
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
    record_count: z
      .number()
      .describe(
        'Total number of records (hourly + daily rows) — the full upstream total when truncated is true, not the combined length of the hourly and daily previews.',
      ),
    hourly: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Per-hour records. Each object has a "time" field (ISO 8601) plus one key per requested variable with its value. Units are in the hourly_units map. Absent when only daily_variables were requested. When truncated, contains only a preview — query canvas_id for the full dataset when one is present.',
      ),
    daily: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Per-day records. Each object has a "time" field (YYYY-MM-DD) plus one key per requested variable with its value. Units are in the daily_units map. Absent when only hourly_variables were requested. When truncated, contains only a preview — query canvas_id for the full dataset when one is present.',
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
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas token for the staged full dataset. Present only when truncated is true AND DataCanvas is enabled (CANVAS_PROVIDER_TYPE=duckdb) — absent otherwise, in which case the preview is all this response carries. Pass to openmeteo_dataframe_describe to list the staged table and its columns, then to openmeteo_dataframe_query to run SQL against it.',
      ),
    table_name: z
      .string()
      .optional()
      .describe(
        'DuckDB table name for the staged data — use as the FROM target in openmeteo_dataframe_query SQL; openmeteo_dataframe_describe lists its columns. Present only alongside canvas_id.',
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
        'Everything this response needs to say beyond the data, composed into one advisory: columns the endpoint returned with the unit "undefined" (a name it parsed but does not serve in the requested cadence); recognized variables whose requested window falls outside the data\'s coverage, with the timestamps that do carry values; and, when the result spilled, the canvas and table holding the full row set plus the two dataframe tools that read it.',
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
     * Reject a confident misplacement before the call. Upstream answers one direction
     * with a 400 that rejects the name as an unknown one — naming the value but not the
     * field it belongs in, nor a same-cadence alternative — and the other with a
     * successful all-null column. Neither is convergent; naming the value and its field
     * is. Unknown names are not misplacements and go upstream untouched.
     */
    const mismatches = findCadenceMismatches(
      FORECAST_CADENCE,
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

    /*
     * A blank timezone is omitted by the URL builder, so it reaches upstream as an
     * absent parameter and resolves to GMT rather than the documented "auto". Reject it
     * before the call — no documented workflow asks a caller to send one.
     */
    if (input.timezone.trim() === '') {
      throw ctx.fail(
        'invalid_timezone',
        BLANK_TIMEZONE_MESSAGE,
        ctx.recoveryFor('invalid_timezone'),
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
      if (isInvalidTimezoneReason(data.reason)) {
        throw ctx.fail(
          'invalid_timezone',
          frameInvalidTimezoneMessage(data.reason),
          ctx.recoveryFor('invalid_timezone'),
        );
      }
      throw ctx.fail(
        'invalid_variable',
        frameInvalidVariableMessage(data.reason),
        ctx.recoveryFor('invalid_variable'),
      );
    }

    const rawHourlyUnits = toUnitsMap(data.hourly_units as Record<string, unknown> | undefined);
    const rawDailyUnits = toUnitsMap(data.daily_units as Record<string, unknown> | undefined);

    /*
     * Split the inline ceiling between the unit maps and the preview rows before
     * anything is measured against it — the maps are part of the response, not free.
     * The raw maps stay in scope: they drive the analysis below, so an entry the
     * payload had to drop is still reported on.
     */
    const {
      units: [hourlyUnits, dailyUnits],
      omittedUnits,
      rowBudget,
    } = inlineBudget(rawHourlyUnits, rawDailyUnits);

    // One notice, composed — ctx.enrich.notice is last-write-wins on a single key.
    const notice = composeNotice(ctx);

    /*
     * Backstop for a name the catalog does not carry: the forecast endpoint answers
     * some wrong-cadence names with HTTP 200 and an all-null column whose unit is the
     * literal string "undefined". Left unsaid that reads as a genuine data gap.
     */
    const emptyColumns = undefinedUnitColumns(rawHourlyUnits, rawDailyUnits);
    if (emptyColumns.length > 0) {
      notice.add(
        `${emptyColumns.join(', ')} returned no data — Open-Meteo reported the unit as "undefined", which means the endpoint does not serve that name in the cadence it was requested under. Check the spelling, and whether it belongs in hourly_variables or daily_variables.`,
      );
    }

    /*
     * Temporal coverage, the case the check above cannot see: a recognized variable
     * whose window reaches past what the API serves comes back with a real unit and
     * null values — a past_days longer than the forecast archive holds opens with a
     * null head that is otherwise indistinguishable from a populated response.
     */
    notice.add(
      describeCoverageGaps(
        findCoverageGaps('hourly', data.hourly, rawHourlyUnits),
        findCoverageGaps('daily', data.daily, rawDailyUnits),
      ),
    );
    notice.add(unitsTrimmedNotice(omittedUnits, 'fewer hourly_variables / daily_variables'));

    const hourlyRecords = data.hourly ? reshapeColumnar(data.hourly) : undefined;
    const dailyRecords = data.daily ? reshapeColumnar(data.daily) : undefined;
    const allRecords = [...(hourlyRecords ?? []), ...(dailyRecords ?? [])];

    // DataCanvas spillover for payloads too large to return inline
    if (exceedsInlineBudget(allRecords, rowBudget)) {
      const canvas = getCanvas();
      if (canvas) {
        const instance = await canvas.acquire(input.canvas_id, ctx);
        const handle = await stageSpill(instance, allRecords, ctx.signal);
        notice.add(canvasPointerNotice(handle.rowCount, handle.tableName, instance.canvasId));

        /*
         * Bound each cadence against its own share of the budget rather than splitting
         * spillover()'s previewRows: those are drained from the head of the concatenated
         * array, so a wide hourly window fills them before a single daily row and the
         * daily summary comes back empty. The staged table is unaffected — it holds
         * every row of both cadences, in chronological order.
         */
        const preview = boundedPreviewByCadence(hourlyRecords ?? [], dailyRecords ?? [], rowBudget);

        return {
          latitude: data.latitude,
          longitude: data.longitude,
          elevation: data.elevation,
          timezone: data.timezone,
          utc_offset_seconds: data.utc_offset_seconds,
          record_count: handle.rowCount,
          hourly: preview.hourly,
          daily: preview.daily,
          hourly_units: hourlyUnits,
          daily_units: dailyUnits,
          canvas_id: instance.canvasId,
          table_name: handle.tableName,
          truncated: true,
        };
      }

      /*
       * No canvas (CANVAS_PROVIDER_TYPE=none, the default): bound the preview anyway.
       * Falling through to the full inline return would report truncated: false on a
       * 108-day hourly window. Same per-cadence selection the canvas branch uses, so
       * both paths return the same rows for the same records.
       */
      const preview = boundedPreviewByCadence(hourlyRecords ?? [], dailyRecords ?? [], rowBudget);
      return {
        latitude: data.latitude,
        longitude: data.longitude,
        elevation: data.elevation,
        timezone: data.timezone,
        utc_offset_seconds: data.utc_offset_seconds,
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
      utc_offset_seconds: data.utc_offset_seconds,
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
      `## Weather forecast`,
      `**Location:** ${result.latitude}, ${result.longitude} | **Elevation:** ${result.elevation}m`,
      `**Timezone:** ${result.timezone} | **utc_offset_seconds:** ${result.utc_offset_seconds}`,
      `**Records:** ${result.record_count} | **Truncated:** ${result.truncated}`,
      '',
    ];

    if (result.truncated && result.canvas_id) {
      lines.push(canvasPointerLine(result.canvas_id, result.table_name ?? ''), '');
    } else if (result.truncated) {
      lines.push(
        noCanvasNotice(
          'fewer past_days / forecast_days, or fewer hourly_variables / daily_variables',
        ),
        '',
      );
    }

    if (result.hourly_units) {
      lines.push(`**Hourly units:** ${formatUnits(result.hourly_units)}`);
    }
    if (result.daily_units) {
      lines.push(`**Daily units:** ${formatUnits(result.daily_units)}`);
    }

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
