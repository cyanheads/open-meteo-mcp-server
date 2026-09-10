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
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';
import {
  type AirQualityParams,
  getOpenMeteoService,
} from '@/services/open-meteo/open-meteo-service.js';
import { toUnitsMap } from '@/services/open-meteo/types.js';
import { formatCurrent, formatRecord, formatUnits, reshapeColumnar } from '../reshape-utils.js';
import { composeNotice, describeCoverageGaps, findCoverageGaps } from '../response-notice.js';
import {
  boundedPreview,
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
import { undefinedUnitColumns } from '../variable-cadence.js';

/**
 * The inputs that shrink this tool's payload, named wherever a response has to tell the
 * caller how to ask for less: the upstream too-much-data rejection, and the no-canvas
 * preview notice on both response surfaces.
 */
const PAYLOAD_NARROWING =
  'fewer past_days / forecast_days or a shorter start_date–end_date range, or fewer current_variables / hourly_variables';

export const openmeteoGetAirQualityTool = tool('openmeteo_get_air_quality', {
  description:
    'Modeled CAMS (Copernicus Atmosphere Monitoring Service) air quality: PM2.5, PM10, ' +
    'nitrogen dioxide, sulphur dioxide, ozone, carbon monoxide, dust, pollen, and European/US AQI ' +
    'indices. This is modeled grid data, not measured station readings — for measured data, use ' +
    'openaq-mcp-server. Forecast horizon up to 7 days, with optional past_days (up to 92) for ' +
    'recent history — or start_date and end_date together for an archive range; the CAMS global ' +
    'archive begins in August 2022, and earlier dates return rows of nulls. One window per call: ' +
    'a date range is mutually exclusive with forecast_days and past_days, and needs both ends — ' +
    'a lone start_date or end_date is rejected. ' +
    'Common variables: pm2_5, pm10, carbon_monoxide, nitrogen_dioxide, sulphur_dioxide, ozone, ' +
    'dust, european_aqi, us_aqi, alder_pollen, birch_pollen, grass_pollen, mugwort_pollen, ' +
    'olive_pollen, ragweed_pollen. ' +
    'Set current_variables for pollutant and AQI values at this instant — returned as a current ' +
    'object plus a current_units map, and enough on its own without hourly_variables; the ' +
    'block’s interval field reports how often that value updates (3600 seconds on this endpoint). ' +
    'A wide window — a large past_days or date range plus many variables — produces thousands of ' +
    'records; these spill to a DataCanvas when canvas is enabled, returning canvas_id and ' +
    'table_name with truncated: true — inspect the staged columns with ' +
    'openmeteo_dataframe_describe, then query the full set with openmeteo_dataframe_query. ' +
    'With canvas disabled they return a bounded preview instead.',
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
      when: 'Neither current_variables nor hourly_variables was provided',
      recovery:
        'Provide at least one air quality variable in current_variables (values right now) or hourly_variables (a time series).',
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
    {
      reason: 'date_order_invalid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'end_date is before start_date',
      recovery: 'Ensure end_date is on or after start_date.',
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
      recovery: `Narrow the request and retry: ${PAYLOAD_NARROWING}. Every requested name is valid — the size of the request is what was rejected, so re-checking spelling will not help.`,
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
    current_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Air quality variables to return for the current instant (e.g., ["pm2_5", "pm10", "european_aqi", "us_aqi"]). Uses Open-Meteo\'s current-conditions data, so it answers "what is the AQI now?" without requesting an hourly series and picking a row; the returned interval reports the update cadence, 3600 seconds on this endpoint. Satisfies the variable requirement on its own.',
      ),
    hourly_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Hourly air quality variables (e.g., ["pm2_5", "pm10", "ozone", "nitrogen_dioxide", "european_aqi", "us_aqi"]). At least one of current_variables or hourly_variables is required.',
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
        'Start date for the archive range (YYYY-MM-DD, e.g., "2024-07-01"). The CAMS global archive begins in August 2022; earlier dates return rows of nulls, and us_aqi starts a day later than the pollutant series (european_aqi starts with it). Requires end_date — the pair must be sent together, and neither combines with forecast_days or past_days.',
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
        'DataCanvas token for wide past_days, archive-range, or multi-variable queries. When a result is too large to return inline — driven by total payload size, so a wide multi-variable pull can spill at any row count — it spills to this canvas: pass the returned token to openmeteo_dataframe_describe to list the staged table and its columns, then to openmeteo_dataframe_query to run SQL against it. Omit to create a fresh canvas.',
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
    current: z
      .object({
        time: z.string().describe('Timestamp of these values (ISO 8601, in the resolved timezone)'),
        interval: z
          .number()
          .describe(
            'Update cadence of the current-conditions data, in seconds (3600 = hourly on this endpoint) — metadata, not a requested variable',
          ),
      })
      .catchall(z.union([z.string(), z.number(), z.null()]))
      .optional()
      .describe(
        'Pollutant and index values at a single instant: one key per requested current variable alongside time and interval. Units are in the current_units map. Absent when current_variables was not requested.',
      ),
    hourly: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Per-hour records with "time" (ISO 8601) + one key per requested variable. Units: pm2_5/pm10/dust in μg/m³, carbon_monoxide in μg/m³, nitrogen_dioxide/sulphur_dioxide/ozone in μg/m³, european_aqi/us_aqi as index values. When truncated, contains only a preview — query canvas_id for the full dataset when one is present.',
      ),
    current_units: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Key → unit string for the current block, covering time and interval as well as each requested variable (e.g., {"interval": "seconds", "pm2_5": "μg/m³"}). Absent when no current_variables were requested.',
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
        'True when the response was too large to return inline, so hourly carries a bounded preview rather than the full set. With DataCanvas enabled the complete data is staged at canvas_id. With it disabled there is no canvas_id, and the omitted rows are reached only by narrowing the request.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Everything this response needs to say beyond the data, composed into one advisory: columns the endpoint returned with the unit "undefined" (a name it parsed but does not serve); recognized variables whose requested window falls outside the CAMS archive, with the timestamps that do carry values; and, when the result spilled, either the canvas and table holding the full row set plus the two dataframe tools that read it, or — with DataCanvas disabled — why there is no canvas_id and how to reach the rows the preview omits.',
      ),
  },

  async handler(input, ctx) {
    const hasCurrent = (input.current_variables?.length ?? 0) > 0;
    const hasHourly = (input.hourly_variables?.length ?? 0) > 0;
    if (!hasCurrent && !hasHourly) {
      throw ctx.fail(
        'no_variables_requested',
        'Provide at least one air quality variable in current_variables or hourly_variables.',
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

    // Ordering, last of the three range checks: upstream answers a reversed pair with a
    // bare `Bad Request` carrying no per-field detail, which the post-call branch frames
    // as an unknown variable name. A single-day range (start_date == end_date) is valid.
    if (input.start_date && input.end_date && input.end_date < input.start_date) {
      throw ctx.fail(
        'date_order_invalid',
        `end_date (${input.end_date}) is before start_date (${input.start_date}).`,
        ctx.recoveryFor('date_order_invalid'),
      );
    }

    // past_days: 0 is the schema default, not an opt-in — sending it alongside a date
    // range is exactly the combination upstream rejects, so the two windows are built
    // as disjoint parameter sets rather than merged.
    const window: AirQualityParams = hasStart
      ? { start_date: input.start_date, end_date: input.end_date }
      : { forecast_days: input.forecast_days, past_days: input.past_days };

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
    const data = await service.getAirQuality(
      input.latitude,
      input.longitude,
      {
        current: input.current_variables,
        hourly: input.hourly_variables,
        ...window,
        timezone: input.timezone,
      },
      ctx,
    );

    if (data.error) {
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
       * the caller to check spelling that is already correct.
       */
      if (isRequestTooLargeReason(data.reason)) {
        throw ctx.fail(
          'request_too_large',
          frameRequestTooLargeMessage(data.reason, PAYLOAD_NARROWING),
          ctx.recoveryFor('request_too_large'),
        );
      }
      throw ctx.fail(
        'invalid_variable',
        frameInvalidVariableMessage(data.reason),
        ctx.recoveryFor('invalid_variable'),
      );
    }

    const rawHourlyUnits = toUnitsMap(data.hourly_units as Record<string, unknown> | undefined);
    const rawCurrentUnits = toUnitsMap(data.current_units as Record<string, unknown> | undefined);

    /*
     * Split the inline ceiling between the unit map and the preview rows before
     * anything is measured against it — the map is part of the response, not free.
     * The raw map stays in scope: it drives the analysis below, so an entry the
     * payload had to drop is still reported on.
     */
    const {
      units: [hourlyUnits, currentUnits],
      omittedUnits,
      rowBudget,
    } = inlineBudget(data.current, rawHourlyUnits, rawCurrentUnits);

    // One notice, composed — ctx.enrich.notice is last-write-wins on a single key.
    const notice = composeNotice(ctx);

    /*
     * The endpoint shares the forecast API's hourly variable parser, so it answers a
     * weather variable name it does not serve — temperature_2m_max, say — with HTTP
     * 200 and an all-null column whose unit is the literal string "undefined" rather
     * than an error. Left unsaid that reads as a genuine data gap.
     */
    const emptyColumns = undefinedUnitColumns(rawHourlyUnits, rawCurrentUnits);
    if (emptyColumns.length > 0) {
      notice.add(
        `${emptyColumns.join(', ')} returned no data — Open-Meteo reported the unit as "undefined", which means the air-quality endpoint does not serve that name. Check it against the air-quality variable list (pm2_5, pm10, ozone, nitrogen_dioxide, european_aqi, us_aqi, …); weather variables belong in openmeteo_get_forecast.`,
      );
    }

    /*
     * Temporal coverage, the case the check above cannot see: an archive range opening
     * before CAMS begins comes back with real units (μg/m³, USAQI) and null values, so
     * a 48-record all-null success is otherwise indistinguishable from a populated one.
     */
    notice.add(describeCoverageGaps(findCoverageGaps('hourly', data.hourly, rawHourlyUnits)));
    notice.add(unitsTrimmedNotice(omittedUnits, 'fewer current_variables / hourly_variables'));

    const hourlyRecords = data.hourly ? reshapeColumnar(data.hourly) : undefined;

    // DataCanvas spillover for payloads too large to return inline
    if (hourlyRecords && exceedsInlineBudget(hourlyRecords, rowBudget)) {
      const canvas = getCanvas();
      if (canvas) {
        const instance = await canvas.acquire(input.canvas_id, ctx);
        const handle = await stageSpill(instance, hourlyRecords, ctx.signal);
        notice.add(canvasPointerNotice(handle.rowCount, handle.tableName, instance.canvasId));

        return {
          latitude: data.latitude,
          longitude: data.longitude,
          timezone: data.timezone,
          record_count: handle.rowCount,
          current: data.current,
          // Same selection the canvas-less branch makes, so both paths return the same
          // rows for the same records — and both start at the first row carrying data,
          // which an archive range opening before CAMS coverage needs.
          hourly: boundedPreview(hourlyRecords, rowBudget),
          current_units: currentUnits,
          hourly_units: hourlyUnits,
          data_source: 'CAMS' as const,
          canvas_id: instance.canvasId,
          table_name: handle.tableName,
          truncated: true,
        };
      }

      /*
       * No canvas (CANVAS_PROVIDER_TYPE=none, the default): bound the preview anyway.
       * Falling through to the full inline return would report truncated: false on a
       * 92-day hourly window.
       *
       * The disclosure is composed into `notice` as well as rendered by format(), for
       * the reason the canvas pointer is: a structuredContent-only client reads one
       * surface, and on this branch the omitted rows are behind no canvas at all.
       */
      notice.add(noCanvasNotice(PAYLOAD_NARROWING));
      return {
        latitude: data.latitude,
        longitude: data.longitude,
        timezone: data.timezone,
        record_count: hourlyRecords.length,
        current: data.current,
        hourly: boundedPreview(hourlyRecords, rowBudget),
        current_units: currentUnits,
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
      current: data.current,
      hourly: hourlyRecords,
      current_units: currentUnits,
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
      lines.push(canvasPointerLine(result.canvas_id, result.table_name ?? ''), '');
    } else if (result.truncated) {
      lines.push(noCanvasNotice(PAYLOAD_NARROWING), '');
    }

    if (result.current_units) {
      lines.push(`**Current units:** ${formatUnits(result.current_units)}`);
    }
    if (result.hourly_units) lines.push(`**Hourly units:** ${formatUnits(result.hourly_units)}`);

    if (result.current) {
      // Its own section, and its own renderer: the block is one instant rather than a
      // series, and `interval` is the model's cadence rather than a requested variable.
      lines.push('', '### Current conditions', formatCurrent(result.current));
    }

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
