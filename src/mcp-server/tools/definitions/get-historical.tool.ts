/**
 * @fileoverview Tool: openmeteo_get_historical — Open-Meteo historical weather archive.
 * Reshapes columnar response into per-timestamp records. Omitting `models` reads the
 * Best Match blend (IFS HRES + ERA5 + ERA5-Land); a `models` selection pins the source.
 * Large date ranges (multi-year hourly) spill to DataCanvas when canvas is enabled,
 * and return a bounded preview with truncated: true when it is not.
 * @module mcp-server/tools/definitions/get-historical
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';
import { toUnitsMap } from '@/services/open-meteo/types.js';
import { ARCHIVE_MODEL_LIST, ARCHIVE_MODEL_NAMES } from '../model-catalog.js';
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
import {
  frameInvalidVariableMessage,
  frameRequestTooLargeMessage,
  isRequestTooLargeReason,
} from '../upstream-error.js';
import {
  describeCadenceMismatches,
  findCadenceMismatches,
  HISTORICAL_CADENCE,
  undefinedUnitColumns,
} from '../variable-cadence.js';

/**
 * The inputs that shrink this tool's payload, named wherever a response has to tell the
 * caller how to ask for less: the upstream too-much-data rejection, and the no-canvas
 * preview notice on both response surfaces.
 */
const PAYLOAD_NARROWING =
  'a shorter start_date–end_date range, fewer hourly_variables / daily_variables, or fewer models';

export const openmeteoGetHistoricalTool = tool('openmeteo_get_historical', {
  description:
    'Historical weather from the Open-Meteo reanalysis archive (1940–present). Requires ' +
    'start_date and end_date (ISO 8601 date, e.g., "2024-07-01"). With models omitted the ' +
    'archive answers from Best Match, which blends IFS HRES, ERA5, and ERA5-Land seamlessly — ' +
    'so the source varies by date and no single update lag describes the response. Set models ' +
    'to pin a consistent source for a multi-decade series: the ERA5 family updates daily with ' +
    'about a 5-day delay, while IFS HRES has none, so for the last few days either request ' +
    `models: ["ecmwf_ifs"] or use openmeteo_get_forecast with past_days. Available models: ${ARCHIVE_MODEL_LIST}. ` +
    'Uses the same variable names as the forecast API for direct comparison. Large date ranges ' +
    '(multi-year hourly) produce thousands of records — these spill to a DataCanvas when canvas ' +
    'is enabled, returning canvas_id and table_name with truncated: true; inspect the staged ' +
    'columns with openmeteo_dataframe_describe, then query the full set with ' +
    'openmeteo_dataframe_query. With canvas disabled they return a bounded preview instead. ' +
    'At least one of hourly_variables or daily_variables is required.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'date_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'start_date predates 1940-01-01, or the requested dates fall outside the coverage of the selected model',
      recovery:
        'Use start_date >= 1940-01-01. A selected ERA5-family model updates daily with roughly a 5-day delay, so for the last few days request models: ["ecmwf_ifs"], drop models to use the Best Match blend, or use openmeteo_get_forecast with past_days instead.',
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
      when: 'An unknown variable name or unsupported archive model was requested',
      recovery: `Check the variable name against Open-Meteo docs. Common hourly: temperature_2m, precipitation, wind_speed_10m, relative_humidity_2m, cloud_cover. Common daily: temperature_2m_max, temperature_2m_min, precipitation_sum. Documented models: ${ARCHIVE_MODEL_NAMES}. When the message names one model, correct only that one — the rest of the models list is valid.`,
      retryable: false,
    },
    {
      reason: 'variable_wrong_cadence',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A variable Open-Meteo documents under one cadence was passed in the other cadence field — for example cloud_cover in daily_variables, or temperature_2m_max in hourly_variables',
      recovery:
        'Move each variable the message names to the field the message names, or drop it — hourly_variables and daily_variables take separate archive variable sets, and the message lists the same-cadence alternatives when the archive publishes any.',
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
    {
      reason: 'request_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Open-Meteo refused the request as asking for too much data in one call',
      recovery: `Narrow the request and retry: ${PAYLOAD_NARROWING}. Every requested name is valid and the dates are in range — the size of the request is what was rejected.`,
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
        'Start date (YYYY-MM-DD, e.g., "2024-07-01"). The archive covers from 1940-01-01; how close to today it reaches depends on the model — the ERA5 family runs about 5 days behind, IFS HRES is current.',
      ),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe(
        'End date (YYYY-MM-DD, inclusive). Must be on or after start_date. For the last few days, either request models: ["ecmwf_ifs"] or use openmeteo_get_forecast with past_days.',
      ),
    hourly_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Hourly archive variables (e.g., ["temperature_2m", "precipitation", "wind_speed_10m", "relative_humidity_2m", "cloud_cover", "soil_moisture_0_to_7cm"]). Hourly names only — a daily aggregate such as temperature_2m_max or precipitation_sum belongs in daily_variables and is rejected here. At least one of hourly_variables or daily_variables required.',
      ),
    daily_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Daily summary variables (e.g., ["temperature_2m_max", "temperature_2m_min", "precipitation_sum", "wind_speed_10m_max"]). Daily names only — an hourly name such as cloud_cover or temperature_2m belongs in hourly_variables and is rejected here; for a daily summary of an hourly variable use its published aggregate (cloud_cover_max, cloud_cover_mean, cloud_cover_min). At least one of hourly_variables or daily_variables required.',
      ),
    models: z
      .array(z.string())
      .max(8)
      .optional()
      .describe(
        `Archive models to read from: ${ARCHIVE_MODEL_LIST}. Omit to use Open-Meteo's Best Match default, which blends IFS HRES, ERA5, and ERA5-Land — pin a model instead when a consistent source matters across the range. With 2+ models each variable column is suffixed with the model name. cerra covers Europe only and is rejected as a coverage gap elsewhere. A name outside this list is sent upstream rather than rejected here.`,
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
        'DataCanvas token for multi-year or multi-variable queries. When a result is too large to return inline — driven by total payload size, so a wide multi-variable pull can spill at any row count — it spills to this canvas: pass the returned token to openmeteo_dataframe_describe to list the staged table and its columns, then to openmeteo_dataframe_query to run SQL against it. Omit to create a fresh canvas.',
      ),
  }),

  output: z.object({
    latitude: z.number().describe('Snapped latitude'),
    longitude: z.number().describe('Snapped longitude'),
    elevation: z.number().describe('Elevation at grid point (meters)'),
    timezone: z.string().describe('Resolved IANA timezone'),
    models: z
      .array(z.string())
      .optional()
      .describe(
        'Archive models requested — echoes the models parameter. Absent when models was omitted, which means the data came from Open-Meteo Best Match (IFS HRES + ERA5 + ERA5-Land) and the source varies by date.',
      ),
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
        'Everything this response needs to say beyond the data, composed into one advisory: columns the archive returned with the unit "undefined" (a name it parsed but does not serve in the requested cadence); recognized variables whose requested window falls outside the data\'s coverage, with the timestamps that do carry values; and, when the result spilled, either the canvas and table holding the full row set plus the two dataframe tools that read it, or — with DataCanvas disabled — why there is no canvas_id and how to reach the rows the preview omits.',
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
     * direction with a 400 that rejects the name as an unknown one — naming the value
     * but not the field it belongs in, nor a same-cadence alternative — and the other
     * with a successful all-null column. Unknown names are not misplacements and go
     * upstream untouched.
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
        `start_date ${input.start_date} predates the archive's coverage (1940-01-01).`,
        ctx.recoveryFor('date_out_of_range'),
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
    const data = await service.getHistorical(
      input.latitude,
      input.longitude,
      {
        start_date: input.start_date,
        end_date: input.end_date,
        hourly: input.hourly_variables,
        daily: input.daily_variables,
        models: input.models,
        temperature_unit: input.temperature_unit,
        wind_speed_unit: input.wind_speed_unit,
        precipitation_unit: input.precipitation_unit,
        timezone: input.timezone,
      },
      ctx,
    );

    if (data.error) {
      const reason = data.reason ?? '';
      if (isInvalidTimezoneReason(data.reason)) {
        throw ctx.fail(
          'invalid_timezone',
          frameInvalidTimezoneMessage(data.reason),
          ctx.recoveryFor('invalid_timezone'),
        );
      }
      /*
       * Volume, not vocabulary: upstream refuses an over-wide request through the same
       * envelope an unknown name arrives in, and the unknown-name framing would send
       * the caller to check spelling that is already correct. Checked ahead of the date
       * branch so a future rewording that happens to mention a date cannot claim it.
       */
      if (isRequestTooLargeReason(reason)) {
        throw ctx.fail(
          'request_too_large',
          frameRequestTooLargeMessage(reason, PAYLOAD_NARROWING),
          ctx.recoveryFor('request_too_large'),
        );
      }
      if (reason.toLowerCase().includes('date') || reason.toLowerCase().includes('range')) {
        throw ctx.fail(
          'date_out_of_range',
          reason || 'Date out of archive range.',
          ctx.recoveryFor('date_out_of_range'),
        );
      }
      /*
       * The models array goes out with a literal comma, so upstream parses it as a list
       * and its rejection names only the offending model rather than the whole request.
       * Reframing that message is all this needs — the same holds for a variable name.
       */
      throw ctx.fail(
        'invalid_variable',
        frameInvalidVariableMessage(data.reason, 'variable or model'),
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
    } = inlineBudget(undefined, rawHourlyUnits, rawDailyUnits);

    // One notice, composed — ctx.enrich.notice is last-write-wins on a single key.
    const notice = composeNotice(ctx);

    /*
     * Backstop for a name the catalog does not carry: the archive answers some
     * wrong-cadence names with HTTP 200 and an all-null column whose unit is the
     * literal string "undefined". Left unsaid that reads as a genuine data gap.
     */
    const emptyColumns = undefinedUnitColumns(rawHourlyUnits, rawDailyUnits);
    if (emptyColumns.length > 0) {
      notice.add(
        `${emptyColumns.join(', ')} returned no data — Open-Meteo reported the unit as "undefined", which means the archive does not serve that name in the cadence it was requested under. Check the spelling, and whether it belongs in hourly_variables or daily_variables.`,
      );
    }

    /*
     * Temporal coverage, the case the check above cannot see: the archive leaves a
     * recognized variable null wherever the reanalysis carries nothing for the grid
     * point, with the unit intact — success and emptiness look identical without this.
     */
    notice.add(
      describeCoverageGaps(
        findCoverageGaps('hourly', data.hourly, rawHourlyUnits),
        findCoverageGaps('daily', data.daily, rawDailyUnits),
      ),
    );
    notice.add(
      unitsTrimmedNotice(omittedUnits, 'fewer hourly_variables / daily_variables, or fewer models'),
    );

    const hourlyRecords = data.hourly ? reshapeColumnar(data.hourly) : undefined;
    const dailyRecords = data.daily ? reshapeColumnar(data.daily) : undefined;
    const models = input.models && input.models.length > 0 ? input.models : undefined;

    const records = hourlyRecords ?? dailyRecords;
    const allRecords = [...(hourlyRecords ?? []), ...(dailyRecords ?? [])];
    const dateRange = {
      start: (records?.[0]?.time as string) ?? input.start_date,
      end: (records?.[records.length - 1]?.time as string) ?? input.end_date,
    };

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
        const preview = boundedPreviewByCadence(hourlyRecords, dailyRecords, rowBudget);

        return {
          latitude: data.latitude,
          longitude: data.longitude,
          elevation: data.elevation,
          timezone: data.timezone,
          models,
          date_range: dateRange,
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
       * multi-megabyte payload. Same per-cadence selection the canvas branch uses, so
       * both paths return the same rows for the same records.
       *
       * The disclosure is composed into `notice` as well as rendered by format(), for
       * the reason the canvas pointer is: a structuredContent-only client reads one
       * surface, and on this branch the omitted rows are behind no canvas at all.
       */
      notice.add(noCanvasNotice(PAYLOAD_NARROWING));
      const preview = boundedPreviewByCadence(hourlyRecords, dailyRecords, rowBudget);
      return {
        latitude: data.latitude,
        longitude: data.longitude,
        elevation: data.elevation,
        timezone: data.timezone,
        models,
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
      models,
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
      `## Historical weather`,
      `**Location:** ${result.latitude}, ${result.longitude} | **Elevation:** ${result.elevation}m | **Timezone:** ${result.timezone}`,
      // An omitted models parameter is the Best Match blend, whose source varies by
      // date — naming the components is the only honest provenance line for it.
      `**Models:** ${result.models?.join(', ') ?? 'Best Match (IFS HRES + ERA5 + ERA5-Land)'}`,
      `**Date range:** ${result.date_range.start} → ${result.date_range.end} | **Records:** ${result.record_count} | **Truncated:** ${result.truncated}`,
    ];

    if (result.truncated && result.canvas_id) {
      lines.push(`\n${canvasPointerLine(result.canvas_id, result.table_name ?? '')}`);
    } else if (result.truncated) {
      lines.push(`\n${noCanvasNotice(PAYLOAD_NARROWING)}`);
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
