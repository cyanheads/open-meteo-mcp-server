/**
 * @fileoverview Tool: openmeteo_get_flood — GloFAS daily river discharge (m³/s), as a
 * forecast outlook or a date range from 1984. Omitting `models` reads upstream's
 * `seamless_v4`, which stitches `consolidated_v4` reanalysis to `forecast_v4` run data at
 * a fixed switch date, so a date range is reanalysis only up to that date; a `models`
 * selection pins the source. Coordinate-based — discharge comes from the GloFAS 0.05° grid
 * cell nearest the point, which is not reliably the cell on the river intended. Wide ranges spill to
 * DataCanvas when canvas is enabled, and return a bounded preview with truncated: true when
 * it is not.
 * @module mcp-server/tools/definitions/get-flood
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';
import { toUnitsMap } from '@/services/open-meteo/types.js';
import { CalendarDateSchema } from '../date-input.js';
import {
  DEFAULT_FLOOD_MODEL,
  FLOOD_CONSOLIDATED_END_DATE,
  FLOOD_MODEL_LIST,
  FLOOD_MODEL_NAMES,
  FLOOD_SEAMLESS_SWITCH_DATE,
} from '../model-catalog.js';
import { cleanNames } from '../name-input.js';
import { formatRecord, formatUnits, reshapeColumnar } from '../reshape-utils.js';
import { composeNotice, describeCoverageGaps, findCoverageGaps } from '../response-notice.js';
import {
  boundedPreview,
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
import { undefinedUnitColumns } from '../variable-cadence.js';

/**
 * The inputs that shrink this tool's payload, named wherever a response has to tell the
 * caller how to ask for less: the upstream too-much-data rejection, and the no-canvas
 * preview notice on both response surfaces.
 */
const PAYLOAD_NARROWING = 'a shorter start_date–end_date range, or fewer daily_variables';

/** The variable half of the `invalid_variable` recovery; see {@link variableOrModelRecovery}. */
const VARIABLE_RECOVERY =
  'Valid variables: river_discharge, river_discharge_mean, river_discharge_min, river_discharge_max, river_discharge_median, river_discharge_p25, river_discharge_p75.';

/** Where the statistics carry spread and where they only repeat river_discharge. */
const STATISTICS_SPANS = `on forecast-run days — the forecast_days outlook, and date-range days from ${FLOOD_SEAMLESS_SWITCH_DATE} under seamless_v4 or forecast_v4. On reanalysis days (seamless_v4 before ${FLOOD_SEAMLESS_SWITCH_DATE}, consolidated_v4 through ${FLOOD_CONSOLIDATED_END_DATE}) they repeat river_discharge and are not uncertainty estimates`;

export const openmeteoGetFloodTool = tool('openmeteo_get_flood', {
  description: `GloFAS (Global Flood Awareness System) daily river discharge (m³/s) from the GloFAS 0.05° grid cell nearest the given coordinates — no river ID needed. The response's latitude and longitude name that cell. It is not reliably on the river intended: a point near a confluence, a pair of parallel channels, or a bank can resolve to a cell with little flow. When the value is far below what the named river carries, step the coordinate 0.05° across the channel and compare the values. One mode per call: forecast_days for the outlook, or start_date and end_date together for a date range from 1984-01-01. The two modes are mutually exclusive, and a date range needs both ends — a lone start_date or end_date is rejected. forecast_days accepts up to 210, but the current GloFAS run sets how far the data reaches (about six months ahead); later days come back null and the notice names where the data ends. What a date range holds depends on the model. Omitting models reads seamless_v4: consolidated_v4 reanalysis before ${FLOOD_SEAMLESS_SWITCH_DATE}, then forecast-run discharge from ${FLOOD_SEAMLESS_SWITCH_DATE} on, so a range crossing that date changes source mid-series. Set models to pin a source: ${FLOOD_MODEL_LIST}. consolidated_v4 is the only way to read reanalysis for ${FLOOD_SEAMLESS_SWITCH_DATE} through ${FLOOD_CONSOLIDATED_END_DATE}. With 2+ models every daily column is suffixed with the model name (river_discharge_consolidated_v4). Available daily variables: "river_discharge" (the daily discharge value; the mean across ensemble members is "river_discharge_mean"), and the ensemble statistics "river_discharge_mean", "river_discharge_median", "river_discharge_min", "river_discharge_max", "river_discharge_p25" (25th percentile), and "river_discharge_p75" (75th percentile). The statistics carry spread across ensemble members ${STATISTICS_SPANS}. Returns null for coordinates far from any river or in areas without GloFAS coverage. A wide date range produces thousands of daily records and spills to a DataCanvas when canvas is enabled, returning canvas_id and table_name with truncated: true — inspect the staged columns with openmeteo_dataframe_describe, then query the full set with openmeteo_dataframe_query. With canvas disabled it returns a bounded preview instead.`,
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'no_variables_requested',
      code: JsonRpcErrorCode.ValidationError,
      when: 'daily_variables named no variable — omitted, empty, or holding only blank or whitespace-only entries.',
      recovery:
        'Provide daily_variables with at least one discharge variable (e.g., ["river_discharge", "river_discharge_p25", "river_discharge_p75"]).',
      retryable: false,
    },
    {
      reason: 'date_range_incomplete',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Only one of start_date / end_date was provided — GloFAS requires the pair together.',
      recovery:
        'Provide both start_date and end_date to pull a historical range, or omit both and use forecast_days for the forecast outlook.',
      retryable: false,
    },
    {
      reason: 'forecast_days_conflict',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A start_date or end_date range was combined with a forecast_days value.',
      recovery:
        'Drop forecast_days to pull the historical range, or drop start_date and end_date to pull the forecast — GloFAS accepts one mode per call, never both.',
      retryable: false,
    },
    {
      reason: 'date_order_invalid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The end_date value is earlier than the start_date value.',
      recovery: 'Ensure end_date is on or after start_date.',
      retryable: false,
    },
    {
      reason: 'date_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'start_date predates 1984-01-01 or date range is otherwise invalid.',
      recovery: 'Use start_date >= 1984-01-01. GloFAS reanalysis covers from 1984-01-01 onward.',
      retryable: false,
    },
    {
      reason: 'invalid_variable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An unknown discharge variable or model name was requested.',
      recovery: variableOrModelRecovery(VARIABLE_RECOVERY, FLOOD_MODEL_NAMES),
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
      recovery: `Narrow the request and retry: ${PAYLOAD_NARROWING}, or fewer models when several were requested. Every requested name is valid and the dates are in range — the size of the request is what was rejected.`,
      retryable: false,
    },
    coverageGapContract('flood'),
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
        'Latitude in decimal degrees. Discharge is returned for the GloFAS 0.05° grid cell nearest this point — no river ID required, and that cell is not reliably on the river intended. When the value is far below what the named river carries, step the coordinate 0.05° across the channel and compare. Use openmeteo_search_locations to resolve a place name.',
      ),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .describe(
        'Longitude in decimal degrees. With latitude it selects the nearest GloFAS 0.05° grid cell, which is not reliably on the river intended.',
      ),
    daily_variables: z
      .array(z.string())
      .max(20)
      .optional()
      .describe(
        `Daily discharge variables to fetch (e.g., ["river_discharge", "river_discharge_p25", "river_discharge_p75", "river_discharge_min", "river_discharge_max"]). Required. river_discharge is the daily discharge value; the _mean, _median, _min, _max, _p25, and _p75 statistics span the ensemble members ${STATISTICS_SPANS}.`,
      ),
    forecast_days: z
      .number()
      .int()
      .min(1)
      .max(210)
      .optional()
      .describe(
        'Number of forecast days ahead (1–210). The API accepts up to 210, but the current GloFAS run sets how far the data reaches (about six months); later days come back null. consolidated_v4 serves no forecast days — with it every row is null. Mutually exclusive with start_date/end_date — omit it entirely when pulling a date range.',
      ),
    start_date: CalendarDateSchema.optional().describe(
      `Start of a date range (YYYY-MM-DD, e.g., "2023-01-01"), from 1984-01-01. Under the default seamless_v4 a range holds consolidated_v4 reanalysis before ${FLOOD_SEAMLESS_SWITCH_DATE} and forecast-run discharge from ${FLOOD_SEAMLESS_SWITCH_DATE} on; request models: ["consolidated_v4"] for reanalysis through ${FLOOD_CONSOLIDATED_END_DATE}. Requires end_date — the pair must be sent together, and neither combines with forecast_days.`,
    ),
    end_date: CalendarDateSchema.optional().describe(
      `End of the date range (YYYY-MM-DD, inclusive). Must be on or after start_date. Days from ${FLOOD_SEAMLESS_SWITCH_DATE} are forecast-run discharge under the default seamless_v4; consolidated_v4 reanalysis ends ${FLOOD_CONSOLIDATED_END_DATE} and answers later days with null. Requires start_date — the pair must be sent together, and neither combines with forecast_days.`,
    ),
    models: z
      .array(z.string())
      // The six selectors the GloFAS docs page lists: the three advertised v4 models and the v3 trio.
      .max(6)
      .optional()
      .describe(
        `GloFAS models to read from: ${FLOOD_MODEL_LIST}. Omit to use Open-Meteo's seamless_v4 default. With 2+ models each daily column and unit key is suffixed with the model name (river_discharge_consolidated_v4); one model keeps plain names. A model with no data for the requested days answers with null values rather than an error, and the notice names those columns. A name outside this list (the GloFAS v3 selectors included) is sent upstream rather than rejected here.`,
      ),
    timezone: z.string().default('auto').describe('IANA timezone or "auto". Default "auto".'),
    canvas_id: CanvasIdSchema.optional().describe(
      'DataCanvas token for wide date-range queries. When a result is too large to return inline — driven by total payload size, so a multi-variable pull can spill at any row count — it spills to this canvas: pass the returned token to openmeteo_dataframe_describe to list the staged table and its columns, then to openmeteo_dataframe_query to run SQL against it. Omit to create a fresh canvas.',
    ),
  }),

  output: z.object({
    latitude: z
      .number()
      .describe('Snapped latitude — the GloFAS grid cell the discharge comes from'),
    longitude: z
      .number()
      .describe('Snapped longitude — the GloFAS grid cell the discharge comes from'),
    timezone: z.string().describe('Resolved IANA timezone'),
    models: z
      .array(z.string())
      .optional()
      .describe(
        `GloFAS models requested — echoes the models parameter. Absent when models was omitted, which means the data came from seamless_v4: consolidated_v4 reanalysis before ${FLOOD_SEAMLESS_SWITCH_DATE}, forecast_v4 runs from ${FLOOD_SEAMLESS_SWITCH_DATE} on.`,
      ),
    record_count: z
      .number()
      .describe(
        'Total number of daily discharge records — the full staged count when truncated is true, not the length of the daily preview.',
      ),
    daily: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Per-day records with "time" (YYYY-MM-DD) + one key per requested variable containing discharge in m³/s — per model, suffixed with the model name (river_discharge_consolidated_v4), when 2+ models were requested — or null for coordinates outside GloFAS coverage and days the selected model does not serve. When truncated, contains only a preview — query canvas_id for the full dataset when one is present.',
      ),
    daily_units: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Variable → unit string for daily data (e.g., {"river_discharge": "m³/s"}), model-suffixed like the records when 2+ models were requested.',
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
        'True when the response was too large to return inline, so daily carries a bounded preview rather than the full set. With DataCanvas enabled the complete data is staged at canvas_id. With it disabled there is no canvas_id, and the omitted rows are reached only by narrowing the request.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Everything this response needs to say beyond the data, composed into one advisory: columns GloFAS returned with the unit "undefined" (a name it parsed but does not serve); recognized columns whose requested days fall outside the coordinate\'s discharge record or the selected model\'s span, with the dates that do carry values; and, when the result spilled, either the canvas and table holding the full row set plus the two dataframe tools that read it, or — with DataCanvas disabled — why there is no canvas_id and how to reach the rows the preview omits.',
      ),
  },

  async handler(input, ctx) {
    const dailyVariables = cleanNames(input.daily_variables);
    const models = cleanNames(input.models);
    if (!dailyVariables) {
      throw ctx.fail(
        'no_variables_requested',
        'Provide daily_variables with at least one discharge variable — blank or whitespace-only entries do not count.',
      );
    }

    /**
     * GloFAS takes the forecast window or a historical range, never both, and rejects
     * a half-specified range. Guarding here rather than letting upstream reject keeps
     * both cases off the post-call `reason.includes('date')` branch, which frames every
     * date complaint as the 1984 coverage floor — advice that fixes neither.
     */
    const hasStart = input.start_date !== undefined;
    const hasEnd = input.end_date !== undefined;

    // Mode conflict outranks pairing: when forecast_days arrives with a half-specified
    // range, both faults are present, but only this one names the caller's actual
    // choice. Reporting the pair first would answer "or omit both and use
    // forecast_days" to a caller who already did exactly that.
    if (input.forecast_days !== undefined && (hasStart || hasEnd)) {
      throw ctx.fail(
        'forecast_days_conflict',
        'forecast_days cannot be combined with start_date/end_date — GloFAS serves either the forecast window or a historical range, not both.',
      );
    }

    if (hasStart !== hasEnd) {
      throw ctx.fail(
        'date_range_incomplete',
        `GloFAS needs start_date and end_date together — only ${hasStart ? 'start_date' : 'end_date'} was provided.`,
      );
    }

    if (input.start_date && input.end_date && input.end_date < input.start_date) {
      throw ctx.fail(
        'date_order_invalid',
        `end_date (${input.end_date}) is before start_date (${input.start_date}).`,
      );
    }

    if (input.start_date && input.start_date < '1984-01-01') {
      throw ctx.fail(
        'date_out_of_range',
        `start_date ${input.start_date} predates GloFAS reanalysis coverage (1984-01-01).`,
      );
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
    const data = await service.getFlood(
      input.latitude,
      input.longitude,
      {
        daily: dailyVariables,
        models,
        forecast_days: input.forecast_days,
        start_date: input.start_date,
        end_date: input.end_date,
        timezone: input.timezone,
      },
      ctx,
    );

    if (data.error) {
      const reason = data.reason ?? '';
      if (isInvalidTimezoneReason(data.reason)) {
        throw ctx.fail('invalid_timezone', frameInvalidTimezoneMessage(data.reason));
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
          frameRequestTooLargeMessage(reason, narrowingWithModels(PAYLOAD_NARROWING, models)),
        );
      }
      if (reason.toLowerCase().includes('date') || reason.toLowerCase().includes('range')) {
        throw ctx.fail('date_out_of_range', reason || 'Date out of GloFAS range.');
      }
      /*
       * An unknown model arrives through the same envelope as an unknown variable
       * ("Cannot initialize MultiDomains from invalid String value <name>"), so a call that
       * sent models gets the variable-or-model label the other model tools use; the raw
       * upstream text in the parenthetical keeps the type name that tells the two apart.
       * The models list goes out with a literal comma, so upstream names only the offender.
       * With no models sent, the hint drops the model list along with the model label.
       */
      throw ctx.fail(
        'invalid_variable',
        frameInvalidVariableMessage(
          data.reason,
          models ? 'discharge variable or model' : 'discharge variable',
        ),
        models ? undefined : { recovery: { hint: VARIABLE_RECOVERY } },
      );
    }

    const rawDailyUnits = toUnitsMap(data.daily_units as Record<string, unknown> | undefined);

    /*
     * Split the inline ceiling between the unit map and the preview rows before
     * anything is measured against it — the map is part of the response, not free.
     * The raw map stays in scope: it drives the analysis below, so an entry the
     * payload had to drop is still reported on.
     */
    const {
      units: [dailyUnits],
      omittedUnits,
      rowBudget,
    } = inlineBudget(undefined, rawDailyUnits);

    // One notice, composed — ctx.enrich.notice is last-write-wins on a single key.
    const notice = composeNotice(ctx);

    /*
     * Backstop for a name GloFAS parses but does not serve: it shares the forecast
     * API's variable parser, so a weather name such as precipitation_sum comes back as
     * HTTP 200 with an all-null column whose unit is the literal string "undefined".
     * Only a name the parser cannot resolve at all draws a 400. Left unsaid, a null
     * column reads as a coordinate outside GloFAS coverage.
     */
    const emptyColumns = undefinedUnitColumns(rawDailyUnits);
    if (emptyColumns.length > 0) {
      notice.add(
        `${emptyColumns.join(', ')} returned no data — Open-Meteo reported the unit as "undefined", which means GloFAS does not serve that name. Use a river-discharge variable (river_discharge, river_discharge_mean, river_discharge_max, river_discharge_min); weather variables belong in openmeteo_get_forecast.`,
      );
    }

    /*
     * Temporal coverage, the case the check above cannot see: a range opening before
     * the selected river's record begins, or reaching past the selected model's span
     * (consolidated_v4 after its end date or on any forecast_days call, forecast_v4
     * before its first run), comes back null with the real m³/s unit, which the null
     * column alone cannot distinguish from a coordinate outside GloFAS coverage
     * entirely. GloFAS never drops a requested model — one with nothing for the window
     * still returns its suffixed column, null — so the per-column gap names it, and no
     * dropped-model notice is needed here.
     */
    notice.add(describeCoverageGaps(findCoverageGaps('daily', data.daily, rawDailyUnits)));
    notice.add(
      unitsTrimmedNotice(omittedUnits, narrowingWithModels('fewer daily_variables', models)),
    );

    const dailyRecords = data.daily ? reshapeColumnar(data.daily) : [];

    // DataCanvas spillover for payloads too large to return inline
    if (exceedsInlineBudget(dailyRecords, rowBudget)) {
      const canvas = getCanvas();
      if (canvas) {
        const instance = await canvas.acquire(input.canvas_id, ctx);
        const handle = await stageSpill(instance, dailyRecords, ctx.signal);
        notice.add(canvasPointerNotice(handle.rowCount, handle.tableName, instance.canvasId));

        return {
          latitude: data.latitude,
          longitude: data.longitude,
          timezone: data.timezone,
          models,
          record_count: handle.rowCount,
          // Same selection the canvas-less branch makes, so both paths return the same
          // rows for the same records — and both start at the first row carrying data,
          // which a range opening before the coordinate's record needs.
          daily: boundedPreview(dailyRecords, rowBudget),
          daily_units: dailyUnits,
          canvas_id: instance.canvasId,
          table_name: handle.tableName,
          truncated: true,
        };
      }

      /*
       * No canvas (CANVAS_PROVIDER_TYPE=none): bound the preview anyway.
       * Falling through to the full inline return would report truncated: false on a
       * multi-decade pull.
       *
       * The full disclosure is composed into `notice`, for the reason the canvas pointer
       * is: a structuredContent-only client reads one surface, and on this branch the
       * omitted rows are behind no canvas at all. The notice trailer carries it into
       * content[] as well, so format() renders only the short line.
       */
      notice.add(noCanvasNotice(narrowingWithModels(PAYLOAD_NARROWING, models)));
      return {
        latitude: data.latitude,
        longitude: data.longitude,
        timezone: data.timezone,
        models,
        record_count: dailyRecords.length,
        daily: boundedPreview(dailyRecords, rowBudget),
        daily_units: dailyUnits,
        canvas_id: undefined,
        table_name: undefined,
        truncated: true,
      };
    }

    return {
      latitude: data.latitude,
      longitude: data.longitude,
      timezone: data.timezone,
      models,
      record_count: dailyRecords.length,
      daily: dailyRecords,
      daily_units: dailyUnits,
      canvas_id: undefined,
      table_name: undefined,
      truncated: false,
    };
  },

  format: (result) => {
    const lines = [
      '## GloFAS river discharge',
      // The response carries no mode, and a seamless_v4 date range is itself mixed
      // provenance, so the model line — not the heading — says where the data came from.
      result.models
        ? `**${result.models.length > 1 ? 'Models' : 'Model'}:** ${result.models.join(', ')}`
        : `**Model:** ${DEFAULT_FLOOD_MODEL.name} (${DEFAULT_FLOOD_MODEL.note})`,
      `**Location:** ${result.latitude}, ${result.longitude} | **Timezone:** ${result.timezone}`,
      `**Records:** ${result.record_count} | **Truncated:** ${result.truncated}`,
    ];

    if (result.truncated && result.canvas_id) {
      lines.push(`\n${canvasPointerLine(result.canvas_id, result.table_name ?? '')}`);
    } else if (result.truncated) {
      lines.push(`\n${noCanvasLine(narrowingWithModels(PAYLOAD_NARROWING, result.models))}`);
    }

    if (result.daily_units) lines.push('', `**Daily units:** ${formatUnits(result.daily_units)}`);

    if (result.daily.length > 0) {
      // When truncated, result.daily is the preview array — render all of it so
      // content[] matches structuredContent.daily; the heading references
      // record_count (the full upstream total), not the preview length. "on canvas"
      // only when one exists — with canvas disabled nothing holds the omitted rows.
      lines.push(
        '',
        result.truncated
          ? `### Daily discharge (preview — ${result.daily.length} shown of ${result.record_count} total rows${result.canvas_id ? ' on canvas' : ''})`
          : `### Daily discharge (${result.daily.length} records)`,
      );
      for (const rec of result.daily) lines.push(formatRecord(rec));
    } else {
      lines.push('', '_No discharge data returned — coordinates may be outside GloFAS coverage._');
    }

    lines.push('', '_Weather data by Open-Meteo.com_');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
