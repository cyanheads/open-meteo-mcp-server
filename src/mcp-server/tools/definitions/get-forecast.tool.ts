/**
 * @fileoverview Tool: openmeteo_get_forecast — weather forecast for coordinates.
 * Reshapes the columnar API response into per-timestamp records. Omitting `models` reads
 * Open-Meteo's best_match blend; a `models` selection compares deterministic models,
 * each column suffixed with its model once two or more are requested.
 * A wide window — past_days up to 92 alongside forecast_days up to 16 — reaches the
 * same payload class as openmeteo_get_historical, so it carries the shared spillover
 * pattern: spill to DataCanvas when canvas is enabled, bounded preview with
 * truncated: true when it is not.
 * @module mcp-server/tools/definitions/get-forecast
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';
import { toUnitsMap } from '@/services/open-meteo/types.js';
import { FORECAST_MODEL_NAMES, FORECAST_MODELS } from '../model-catalog.js';
import { cleanNames } from '../name-input.js';
import { formatCurrent, formatRecord, formatUnits, reshapeColumnar } from '../reshape-utils.js';
import {
  composeNotice,
  describeCoverageGaps,
  describeCurrentGaps,
  describeDroppedModels,
  describeUnservedColumns,
  findCoverageGaps,
  findCurrentGaps,
} from '../response-notice.js';
import {
  boundedPreviewByCadence,
  canvasPointerLine,
  canvasPointerNotice,
  exceedsInlineBudget,
  inlineBudget,
  narrowingWithModels,
  noCanvasLine,
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
  coverageGapContract,
  frameInvalidVariableMessage,
  frameRequestTooLargeMessage,
  isRequestTooLargeReason,
  RATE_LIMITED_ERROR,
  UPSTREAM_TIMEOUT_ERROR,
  UPSTREAM_UNAVAILABLE_ERROR,
  variableOrModelRecovery,
} from '../upstream-error.js';
import {
  describeCadenceMismatches,
  FORECAST_CADENCE,
  findCadenceMismatches,
  undefinedUnitColumns,
} from '../variable-cadence.js';

/**
 * The inputs that shrink this tool's payload, named wherever a response has to tell the
 * caller how to ask for less: the upstream too-much-data rejection, and the no-canvas
 * preview notice on both response surfaces.
 */
const PAYLOAD_NARROWING =
  'fewer past_days / forecast_days, or fewer current_variables / hourly_variables / daily_variables';

/** The variable half of the `invalid_variable` recovery; see {@link variableOrModelRecovery}. */
const VARIABLE_RECOVERY =
  'Check the variable name against Open-Meteo docs. Common hourly: temperature_2m, precipitation, wind_speed_10m, relative_humidity_2m, cloud_cover, uv_index. Common daily: temperature_2m_max, temperature_2m_min, precipitation_sum.';

export const openmeteoGetForecastTool = tool('openmeteo_get_forecast', {
  description:
    'Weather forecast for coordinates: hourly and/or daily variables for up to 16 days ahead, ' +
    'with optional past_days (up to 92) for recent history. Use past_days instead of ' +
    'openmeteo_get_historical for dates within the last 1–5 days, since the archive’s ERA5 ' +
    'components lag by up to ~5 days. ' +
    'Returns per-timestamp records — each hourly entry contains a "time" field (ISO 8601) plus one key per requested variable; each daily entry contains a "time" field (YYYY-MM-DD) plus requested variables. ' +
    'Common hourly variables: temperature_2m, precipitation, wind_speed_10m, ' +
    'relative_humidity_2m, cloud_cover, uv_index, apparent_temperature, ' +
    'precipitation_probability, weather_code, surface_pressure, visibility, ' +
    'wind_direction_10m, wind_gusts_10m, dew_point_2m. ' +
    'Common daily variables: temperature_2m_max, temperature_2m_min, precipitation_sum, ' +
    'wind_speed_10m_max, sunrise, sunset, uv_index_max, precipitation_hours, weather_code. ' +
    'Set current_variables for conditions at this instant — Open-Meteo serves those from ' +
    '15-minute model data, which is more precise than picking the nearest hourly row, and the ' +
    'response carries a current object plus a current_units map. ' +
    'Set models to compare deterministic models side by side (e.g., ["ncep_gfs_seamless", "ecmwf_ifs025", "dwd_icon_seamless"]) — where they disagree, the forecast is uncertain. With 2+ models every hourly and daily key carries the model name as a suffix (temperature_2m_ecmwf_ifs025); with models omitted the data is Open-Meteo’s best_match blend. ' +
    'A wide window — a large past_days plus many hourly variables — produces thousands of ' +
    'records; these spill to a DataCanvas when canvas is enabled, returning canvas_id and ' +
    'table_name with truncated: true — inspect the staged columns with ' +
    'openmeteo_dataframe_describe, then query the full set with openmeteo_dataframe_query. ' +
    'With canvas disabled they return a bounded preview instead. ' +
    'At least one of current_variables, hourly_variables, or daily_variables is required.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'invalid_variable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An unknown variable name or forecast model was requested.',
      recovery: variableOrModelRecovery(VARIABLE_RECOVERY, FORECAST_MODEL_NAMES),
      retryable: false,
    },
    {
      reason: 'current_multi_model',
      code: JsonRpcErrorCode.ValidationError,
      when: 'current_variables was combined with two or more models — Open-Meteo answers current conditions from a single model in one unsuffixed block, so the values could not be attributed — caught before the request is sent.',
      recovery:
        'Send current_variables with at most one model, and compare models through hourly_variables or daily_variables, whose columns carry a per-model suffix.',
      retryable: false,
    },
    {
      reason: 'variable_wrong_cadence',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A variable sat in the cadence field Open-Meteo does not document it under — for example cloud_cover in daily_variables, or temperature_2m_max in hourly_variables — caught before the request is sent.',
      recovery:
        'Move each variable the message names to the field the message names, or drop it — hourly_variables and daily_variables take separate Open-Meteo variable sets, and the message lists the same-cadence alternatives when the endpoint publishes any.',
      retryable: false,
    },
    {
      reason: 'no_variables_requested',
      code: JsonRpcErrorCode.ValidationError,
      when: 'None of current_variables, hourly_variables, or daily_variables named a variable — blank or whitespace-only entries do not count.',
      recovery:
        'Provide at least one of current_variables (conditions right now), hourly_variables, or daily_variables.',
      retryable: false,
    },
    {
      reason: 'invalid_timezone',
      code: JsonRpcErrorCode.ValidationError,
      when: 'timezone was blank, or upstream did not recognize the requested time zone.',
      recovery:
        'Set timezone to "auto" or an exact IANA time-zone name such as "America/Los_Angeles", or omit it entirely to use the "auto" default.',
      retryable: false,
    },
    {
      reason: 'request_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Open-Meteo refused the request as asking for too much data in one call.',
      recovery: `Narrow the request and retry: ${PAYLOAD_NARROWING}, or fewer models when several were requested. Every requested name is valid — the size of the request is what was rejected, so re-checking spelling will not help.`,
      retryable: false,
    },
    coverageGapContract('forecast'),
    RATE_LIMITED_ERROR,
    UPSTREAM_UNAVAILABLE_ERROR,
    UPSTREAM_TIMEOUT_ERROR,
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
    current_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Variables to return for the current instant (e.g., ["temperature_2m", "precipitation", "wind_speed_10m", "weather_code"]). Uses Open-Meteo\'s 15-minute current-conditions data, so it answers "what is it doing right now?" without requesting an hourly series and picking a row. Takes the hourly variable names; a daily-only name such as temperature_2m_max comes back null with the unit "undefined" and is reported in the notice. Satisfies the variable requirement on its own.',
      ),
    hourly_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Hourly variables to fetch (e.g., ["temperature_2m", "precipitation", "wind_speed_10m", "relative_humidity_2m", "cloud_cover", "uv_index", "apparent_temperature"]). Hourly names only — a daily aggregate such as temperature_2m_max or precipitation_sum belongs in daily_variables and is rejected here. At least one of current_variables, hourly_variables, or daily_variables is required.',
      ),
    daily_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Daily summary variables (e.g., ["temperature_2m_max", "temperature_2m_min", "precipitation_sum", "wind_speed_10m_max", "sunrise", "sunset", "uv_index_max"]). Daily names only — an hourly name such as cloud_cover or temperature_2m belongs in hourly_variables and is rejected here; for a daily summary of an hourly variable use its published aggregate (cloud_cover_max, cloud_cover_mean, cloud_cover_min). At least one of current_variables, hourly_variables, or daily_variables is required.',
      ),
    models: z
      .array(z.string())
      .max(FORECAST_MODELS.length)
      .optional()
      .describe(
        `Deterministic forecast models to read from, to compare modeling centers side by side. Documented: ${FORECAST_MODEL_NAMES}. Older spellings such as gfs_seamless, icon_seamless, icon_d2, and gfs_hrrr still resolve. Omit to use Open-Meteo's best_match blend. With 2+ models every hourly and daily column and unit key is suffixed with the model name (temperature_2m_max_ecmwf_ifs025); one model keeps plain names. Regional models serve only their own domain: when every requested model misses the coordinate the call fails as coverage_gap, and when only some do, Open-Meteo drops those and the notice names them, or, when one model is left with unsuffixed columns, says the values cannot be attributed to a model. current_variables takes at most one model. A name outside this list is sent upstream rather than rejected here.`,
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
        'Include this many days of past data before today (0–92). Use for recent history — the archive’s ERA5 components lag by up to ~5 days. Default 0.',
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
    canvas_id: CanvasIdSchema.optional().describe(
      'DataCanvas token for wide past_days or multi-variable queries. When a result is too large to return inline — driven by total payload size, so a wide multi-variable pull can spill at any row count — it spills to this canvas: pass the returned token to openmeteo_dataframe_describe to list the staged table and its columns, then to openmeteo_dataframe_query to run SQL against it. Omit to create a fresh canvas.',
    ),
  }),

  output: z.object({
    latitude: z
      .number()
      .describe(
        'Snapped latitude (Open-Meteo snaps to nearest grid point — with models set, the grid of the first listed model that covers the coordinate)',
      ),
    longitude: z
      .number()
      .describe(
        'Snapped longitude (with models set, the grid of the first listed model that covers the coordinate)',
      ),
    elevation: z.number().describe('Terrain elevation at grid point (meters)'),
    timezone: z.string().describe('Resolved IANA timezone'),
    utc_offset_seconds: z
      .number()
      .describe('UTC offset in seconds for this timezone at query time'),
    models: z
      .array(z.string())
      .optional()
      .describe(
        "Forecast models requested — echoes the models parameter. Absent when models was omitted, which means the data came from Open-Meteo's best_match blend.",
      ),
    record_count: z
      .number()
      .describe(
        'Total number of records (hourly + daily rows) — the full upstream total when truncated is true, not the combined length of the hourly and daily previews.',
      ),
    current: z
      .object({
        time: z.string().describe('Timestamp of these values (ISO 8601, in the resolved timezone)'),
        interval: z
          .number()
          .describe(
            'Aggregation interval of the current block, in seconds (900 = 15 minutes) — metadata, not a requested variable. Summed or averaged values such as precipitation and sunshine_duration cover the preceding interval seconds ending at current.time; instantaneous values such as temperature_2m are valid at current.time',
          ),
      })
      .catchall(z.union([z.string(), z.number(), z.null()]))
      .optional()
      .describe(
        'Conditions at a single instant: one key per requested current variable alongside time and interval. Units are in the current_units map. Absent when current_variables was not requested.',
      ),
    hourly: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Per-hour records. Each object has a "time" field (ISO 8601) plus one key per requested variable with its value — one key per variable per model, suffixed with the model name (temperature_2m_ecmwf_ifs025), when 2+ models were requested. Units are in the hourly_units map. Absent when only daily_variables were requested. When truncated, contains only a preview — query canvas_id for the full dataset when one is present.',
      ),
    daily: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Per-day records. Each object has a "time" field (YYYY-MM-DD) plus one key per requested variable with its value — per model, suffixed with the model name, when 2+ models were requested. Units are in the daily_units map. Absent when only hourly_variables were requested. When truncated, contains only a preview — query canvas_id for the full dataset when one is present.',
      ),
    current_units: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Map of key → unit string for the current block, covering time and interval as well as each requested variable (e.g., {"interval": "seconds", "temperature_2m": "°C"}). Absent when no current_variables were requested.',
      ),
    hourly_units: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Map of variable name → unit string for hourly data (e.g., {"temperature_2m": "°C", "precipitation": "mm"}), keyed by the same model-suffixed names as the records when 2+ models were requested. Absent when no hourly_variables were requested.',
      ),
    daily_units: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Map of variable name → unit string for daily data, model-suffixed like the records when 2+ models were requested. Absent when no daily_variables were requested.',
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
        'Everything this response needs to say beyond the data, composed into one advisory: columns the endpoint returned with the unit "undefined" (a name it parsed but does not serve in the requested cadence, or — on a model-suffixed column — a variable that model does not serve); requested models Open-Meteo left out for having no data at this coordinate, or the plain-named columns a multi-model request cannot attribute to one model; current values that are null under a real unit (no coverage at this location and time); recognized variables whose requested window or location falls outside the data\'s coverage, with the timestamps that do carry values; and, when the result spilled, either the canvas and table holding the full row set plus the two dataframe tools that read it, or — with DataCanvas disabled — why there is no canvas_id and how to reach the rows the preview omits.',
      ),
  },

  async handler(args, ctx) {
    const input = {
      ...args,
      current_variables: cleanNames(args.current_variables),
      hourly_variables: cleanNames(args.hourly_variables),
      daily_variables: cleanNames(args.daily_variables),
      models: cleanNames(args.models),
    };
    const hasCurrent = (input.current_variables?.length ?? 0) > 0;
    const hasHourly = (input.hourly_variables?.length ?? 0) > 0;
    const hasDaily = (input.daily_variables?.length ?? 0) > 0;
    if (!hasCurrent && !hasHourly && !hasDaily) {
      throw ctx.fail(
        'no_variables_requested',
        'Provide at least one of current_variables, hourly_variables, or daily_variables — blank or whitespace-only entries do not count.',
      );
    }

    /*
     * Upstream answers `current` with one unsuffixed block taken from the first listed
     * model that covers the coordinate, however many models were sent — so beside a
     * comparison it reads as everyone's current conditions while being one model's.
     * Per-model current blocks are not something one request can produce.
     */
    const models = input.models ?? [];
    if (hasCurrent && models.length > 1) {
      throw ctx.fail(
        'current_multi_model',
        `current_variables cannot be combined with ${models.length} models (${models.join(', ')}): Open-Meteo answers current conditions from a single model — the first listed one that covers the coordinate — in one unsuffixed block, so the values would not say which model produced them. Send current_variables with one model or none, and compare models through hourly_variables or daily_variables.`,
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
      throw ctx.fail('variable_wrong_cadence', describeCadenceMismatches(mismatches));
    }

    /*
     * A blank timezone is omitted by the URL builder, so it reaches upstream as an
     * absent parameter and resolves to GMT rather than the documented "auto". Reject it
     * before the call — no documented workflow asks a caller to send one.
     */
    if (input.timezone.trim() === '') {
      throw ctx.fail('invalid_timezone', BLANK_TIMEZONE_MESSAGE);
    }

    const service = getOpenMeteoService();
    const data = await service.getForecast(
      input.latitude,
      input.longitude,
      {
        current: input.current_variables,
        hourly: input.hourly_variables,
        daily: input.daily_variables,
        models: input.models,
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
        throw ctx.fail('invalid_timezone', frameInvalidTimezoneMessage(data.reason));
      }
      /*
       * Volume, not vocabulary: upstream refuses an over-wide request through the same
       * envelope an unknown name arrives in, and the unknown-name framing would send
       * the caller to check spelling that is already correct.
       */
      if (isRequestTooLargeReason(data.reason)) {
        throw ctx.fail(
          'request_too_large',
          frameRequestTooLargeMessage(
            data.reason,
            narrowingWithModels(PAYLOAD_NARROWING, input.models),
          ),
        );
      }
      /*
       * An unknown model arrives through the same envelope as an unknown variable
       * ("Cannot initialize MultiDomains from invalid String value <name>"), and the
       * models list goes out with a literal comma, so upstream names only the offender.
       * With no models sent, the hint drops the model list along with the model label.
       */
      throw ctx.fail(
        'invalid_variable',
        frameInvalidVariableMessage(data.reason, input.models ? 'variable or model' : 'variable'),
        input.models ? undefined : { recovery: { hint: VARIABLE_RECOVERY } },
      );
    }

    const rawHourlyUnits = toUnitsMap(data.hourly_units as Record<string, unknown> | undefined);
    const rawDailyUnits = toUnitsMap(data.daily_units as Record<string, unknown> | undefined);
    const rawCurrentUnits = toUnitsMap(data.current_units as Record<string, unknown> | undefined);

    /*
     * Split the inline ceiling between the unit maps and the preview rows before
     * anything is measured against it — the maps are part of the response, not free.
     * The raw maps stay in scope: they drive the analysis below, so an entry the
     * payload had to drop is still reported on.
     */
    const {
      units: [hourlyUnits, dailyUnits, currentUnits],
      omittedUnits,
      rowBudget,
    } = inlineBudget(data.current, rawHourlyUnits, rawDailyUnits, rawCurrentUnits);

    // One notice, composed — ctx.enrich.notice is last-write-wins on a single key.
    const notice = composeNotice(ctx);

    /*
     * Backstop for a name the catalog does not carry: the forecast endpoint answers
     * some wrong-cadence names with HTTP 200 and an all-null column whose unit is the
     * literal string "undefined". Left unsaid that reads as a genuine data gap. On a
     * model-suffixed column the same unit means that model does not serve the variable,
     * which the cadence advice would misdirect — that case gets its own sentence.
     */
    const selection = {
      models: input.models,
      variables: [...(input.hourly_variables ?? []), ...(input.daily_variables ?? [])],
    };
    notice.add(
      describeUnservedColumns(
        undefinedUnitColumns(rawHourlyUnits, rawDailyUnits, rawCurrentUnits),
        selection,
        {
          server: 'the endpoint',
          fields: 'current_variables, hourly_variables, or daily_variables',
        },
      ),
    );

    // A model Open-Meteo dropped from a multi-model request for having no data here.
    notice.add(describeDroppedModels(selection, data.hourly, data.daily));

    /*
     * Coverage, the case the check above cannot see: a recognized variable comes back
     * with a real unit and null values — lightning_potential where the model carries
     * none, or a past_days longer than the forecast archive holds, which opens with a
     * null head that is otherwise indistinguishable from a populated response.
     */
    notice.add(describeCurrentGaps(findCurrentGaps(data.current, rawCurrentUnits)));
    notice.add(
      describeCoverageGaps(
        findCoverageGaps('hourly', data.hourly, rawHourlyUnits),
        findCoverageGaps('daily', data.daily, rawDailyUnits),
      ),
    );
    notice.add(
      unitsTrimmedNotice(
        omittedUnits,
        narrowingWithModels(
          'fewer current_variables / hourly_variables / daily_variables',
          input.models,
        ),
      ),
    );

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
        const preview = boundedPreviewByCadence(hourlyRecords, dailyRecords, rowBudget);

        return {
          latitude: data.latitude,
          longitude: data.longitude,
          elevation: data.elevation,
          timezone: data.timezone,
          utc_offset_seconds: data.utc_offset_seconds,
          models: input.models,
          record_count: handle.rowCount,
          current: data.current,
          hourly: preview.hourly,
          daily: preview.daily,
          current_units: currentUnits,
          hourly_units: hourlyUnits,
          daily_units: dailyUnits,
          canvas_id: instance.canvasId,
          table_name: handle.tableName,
          truncated: true,
        };
      }

      /*
       * No canvas (CANVAS_PROVIDER_TYPE=none): bound the preview anyway.
       * Falling through to the full inline return would report truncated: false on a
       * 108-day hourly window. Same per-cadence selection the canvas branch uses, so
       * both paths return the same rows for the same records.
       *
       * The full disclosure is composed into `notice`, for the reason the canvas pointer
       * is: a structuredContent-only client reads one surface, and on this branch the
       * omitted rows are behind no canvas at all. The notice trailer carries it into
       * content[] as well, so format() renders only the short line.
       */
      notice.add(noCanvasNotice(narrowingWithModels(PAYLOAD_NARROWING, input.models)));
      const preview = boundedPreviewByCadence(hourlyRecords, dailyRecords, rowBudget);
      return {
        latitude: data.latitude,
        longitude: data.longitude,
        elevation: data.elevation,
        timezone: data.timezone,
        utc_offset_seconds: data.utc_offset_seconds,
        models: input.models,
        record_count: allRecords.length,
        current: data.current,
        hourly: preview.hourly,
        daily: preview.daily,
        current_units: currentUnits,
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
      models: input.models,
      record_count: allRecords.length,
      current: data.current,
      hourly: hourlyRecords,
      daily: dailyRecords,
      current_units: currentUnits,
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
    ];
    // Only when requested: an omitted models list is best_match, and renders as it always has.
    if (result.models) lines.push(`**Models:** ${result.models.join(', ')}`);
    lines.push(`**Records:** ${result.record_count} | **Truncated:** ${result.truncated}`, '');

    if (result.truncated && result.canvas_id) {
      lines.push(canvasPointerLine(result.canvas_id, result.table_name ?? ''), '');
    } else if (result.truncated) {
      lines.push(noCanvasLine(narrowingWithModels(PAYLOAD_NARROWING, result.models)), '');
    }

    if (result.current_units) {
      lines.push(`**Current units:** ${formatUnits(result.current_units)}`);
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

    if (result.current) {
      // Its own section, and its own renderer: the block is one instant rather than a
      // series, and `interval` is its aggregation interval rather than a requested variable.
      lines.push('', '### Current conditions', formatCurrent(result.current));
    }

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
