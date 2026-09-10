/**
 * @fileoverview Tool: openmeteo_get_climate — bias-corrected daily CMIP6 climate projections.
 * Covers 1950-01-01 to 2050-12-31 across up to seven high-resolution climate models.
 * Reshapes columnar response into per-date records. Multi-decade, multi-model pulls
 * spill to DataCanvas when canvas is enabled, and return a bounded preview with
 * truncated: true when it is not.
 * @module mcp-server/tools/definitions/get-climate
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';
import { toUnitsMap } from '@/services/open-meteo/types.js';
import { CLIMATE_MODEL_LIST } from '../model-catalog.js';
import { formatRecord, formatUnits, reshapeColumnar } from '../reshape-utils.js';
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
  'a shorter start_date–end_date range, fewer daily_variables, or fewer models';

export const openmeteoGetClimateTool = tool('openmeteo_get_climate', {
  description:
    'Long-range climate projections from bias-corrected daily CMIP6 models, covering ' +
    '1950-01-01 to 2050-12-31 at any coordinate. Answers "what will conditions look like ' +
    'through 2050?" — the future-projection counterpart to openmeteo_get_historical (the ' +
    `observed archive, what happened). Daily resolution only. Available models: ${CLIMATE_MODEL_LIST}. ` +
    'A model name outside that list is sent upstream rather than rejected here, so a model ' +
    'Open-Meteo adds later still works; if upstream rejects the request, the error names the ' +
    'offending model on its own rather than the whole requested list. ' +
    'With 2+ models each variable appears once per model with the model name as suffix ' +
    '(e.g. temperature_2m_max_CMCC_CM2_VHR4); a single or omitted model returns plain ' +
    'variable names. Not all models carry all variables — missing combinations return null. ' +
    'Multi-decade daily pulls across several models produce thousands of records and spill to a ' +
    'DataCanvas when canvas is enabled, returning canvas_id and table_name with truncated: true ' +
    '— inspect the staged columns with openmeteo_dataframe_describe, then query the full set ' +
    'with openmeteo_dataframe_query. With canvas disabled they return a bounded preview instead.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'date_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'start_date predates 1950-01-01 or end_date is after 2050-12-31',
      recovery:
        'Use dates between 1950-01-01 and 2050-12-31 — the CMIP6 projection coverage. For observed history before 1950 limits, use openmeteo_get_historical (the archive, from 1940).',
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
      when: 'daily_variables was not provided or is empty',
      recovery:
        'Provide daily_variables with at least one variable (e.g., ["temperature_2m_max", "precipitation_sum"]).',
      retryable: false,
    },
    {
      reason: 'invalid_variable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An unknown variable name or unsupported climate model was requested',
      recovery: `Check names against Open-Meteo Climate API docs. Common daily variables: temperature_2m_max, temperature_2m_min, temperature_2m_mean, precipitation_sum, rain_sum, snowfall_sum, wind_speed_10m_mean, wind_speed_10m_max, shortwave_radiation_sum, cloud_cover_mean. Documented models: ${CLIMATE_MODEL_LIST}. When the message names one model, correct only that one — the rest of the models list is valid.`,
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
      recovery: `Narrow the request and retry: ${PAYLOAD_NARROWING}. Every requested name and model is valid and the dates are in range — the size of the request is what was rejected.`,
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
        'Start date (YYYY-MM-DD, e.g., "2049-01-01"). CMIP6 projections cover 1950-01-01 to 2050-12-31.',
      ),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe(
        'End date (YYYY-MM-DD, inclusive, max 2050-12-31). Must be on or after start_date.',
      ),
    daily_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Daily climate variables to fetch (e.g., ["temperature_2m_max", "temperature_2m_min", "precipitation_sum", "wind_speed_10m_mean", "shortwave_radiation_sum"]). Required — the Climate API is daily-only.',
      ),
    models: z
      .array(z.string())
      .max(7)
      .optional()
      .describe(
        `CMIP6 models to include: ${CLIMATE_MODEL_LIST}. With 2+ models each variable column is suffixed with the model name (e.g. temperature_2m_max_MRI_AGCM3_2_S). Omit to use the API default (a single model, unsuffixed columns). A name outside this list is sent upstream rather than rejected here.`,
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
        'DataCanvas token for multi-decade or multi-model queries. When a result is too large to return inline — driven by total payload size, so a wide multi-model pull can spill at any row count — it spills to this canvas: pass the returned token to openmeteo_dataframe_describe to list the staged table and its per-model columns, then to openmeteo_dataframe_query to run SQL against it. Omit to create a fresh canvas.',
      ),
  }),

  output: z.object({
    latitude: z.number().describe('Snapped latitude (Open-Meteo snaps to nearest grid point)'),
    longitude: z.number().describe('Snapped longitude'),
    elevation: z.number().describe('Elevation at grid point (meters)'),
    timezone: z.string().describe('Resolved IANA timezone'),
    models: z
      .array(z.string())
      .optional()
      .describe(
        'Climate models requested — echoes the models parameter. Absent when models was omitted (API default model; the response carries no provenance).',
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
        'Total number of daily records — the full upstream total when truncated is true, not the length of the daily preview.',
      ),
    daily: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Per-day records with "time" (YYYY-MM-DD) + one key per requested variable — per-model suffixed keys when 2+ models were requested (e.g. temperature_2m_max_CMCC_CM2_VHR4). Null values mean the model does not carry that variable. When truncated, contains only a preview — query canvas_id for the full dataset when one is present.',
      ),
    daily_units: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Column → unit string for daily data (e.g., {"temperature_2m_max_CMCC_CM2_VHR4": "°C"}).',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas token for the staged full dataset. Present only when truncated is true AND DataCanvas is enabled (CANVAS_PROVIDER_TYPE=duckdb) — absent otherwise, in which case the preview is all this response carries. Pass to openmeteo_dataframe_describe to list the staged table and its per-model columns, then to openmeteo_dataframe_query to run SQL against it.',
      ),
    table_name: z
      .string()
      .optional()
      .describe(
        'DuckDB table name for the staged data — use as the FROM target in openmeteo_dataframe_query SQL; openmeteo_dataframe_describe lists its columns, which is the only way to learn the per-model suffixes this request produced. Present only alongside canvas_id.',
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
        'Everything this response needs to say beyond the data, composed into one advisory: columns the endpoint returned with the unit "undefined" (a name it parsed but does not serve); recognized variables a selected model carries no values for, with the dates that do carry values; and, when the result spilled, either the canvas and table holding the full row set plus the two dataframe tools that read it, or — with DataCanvas disabled — why there is no canvas_id and how to reach the rows the preview omits.',
      ),
  },

  async handler(input, ctx) {
    const dailyVariables = input.daily_variables;
    if (!dailyVariables || dailyVariables.length === 0) {
      throw ctx.fail(
        'no_variables_requested',
        'Provide daily_variables with at least one climate variable.',
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

    if (input.start_date < '1950-01-01') {
      throw ctx.fail(
        'date_out_of_range',
        `start_date ${input.start_date} predates CMIP6 projection coverage (1950-01-01).`,
        ctx.recoveryFor('date_out_of_range'),
      );
    }

    if (input.end_date > '2050-12-31') {
      throw ctx.fail(
        'date_out_of_range',
        `end_date ${input.end_date} is after CMIP6 projection coverage (2050-12-31).`,
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
    const data = await service.getClimate(
      input.latitude,
      input.longitude,
      {
        start_date: input.start_date,
        end_date: input.end_date,
        daily: dailyVariables,
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
       * Volume, not vocabulary: a 1950–2050 pull across every model is refused through
       * the same envelope an unknown name arrives in, and the unknown-name framing
       * would send the caller to check spelling that is already correct. Checked ahead
       * of the date branch so a future rewording mentioning a date cannot claim it.
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
          reason || 'Date out of CMIP6 projection range.',
          ctx.recoveryFor('date_out_of_range'),
        );
      }
      /*
       * The models array goes out with a literal comma, so upstream parses it as a list
       * and its rejection names only the offending model — a valid MRI_AGCM3_2_S sent
       * alongside a bad name is not echoed as a suspect. Reframing that message is all
       * this needs; reconstructing the offender from a local catalog would only re-derive
       * what upstream already stated, against a list that has to be refreshed to stay
       * correct. The same holds for a rejected variable name.
       */
      throw ctx.fail(
        'invalid_variable',
        frameInvalidVariableMessage(data.reason, 'variable or model'),
        ctx.recoveryFor('invalid_variable'),
      );
    }

    const rawDailyUnits = toUnitsMap(data.daily_units as Record<string, unknown> | undefined);

    /*
     * Split the inline ceiling between the unit map and the preview rows before
     * anything is measured against it — with seven models suffixing every variable the
     * map is a real share of the response. The raw map stays in scope: it drives the
     * analysis below, so an entry the payload had to drop is still reported on.
     */
    const {
      units: [dailyUnits],
      omittedUnits,
      rowBudget,
    } = inlineBudget(undefined, rawDailyUnits);

    // One notice, composed — ctx.enrich.notice is last-write-wins on a single key.
    const notice = composeNotice(ctx);

    /*
     * Backstop for a name the CMIP6 endpoint parses but does not serve: it shares the
     * forecast API's variable parser, so a name from another endpoint's vocabulary such
     * as river_discharge_max comes back as HTTP 200 with an all-null column whose unit
     * is the literal string "undefined". Only a name the parser cannot resolve at all
     * draws a 400.
     */
    const emptyColumns = undefinedUnitColumns(rawDailyUnits);
    if (emptyColumns.length > 0) {
      notice.add(
        `${emptyColumns.join(', ')} returned no data — Open-Meteo reported the unit as "undefined", which means the CMIP6 climate endpoint does not serve that name. Check it against the climate variable list (temperature_2m_max, temperature_2m_min, precipitation_sum, wind_speed_10m_max, …).`,
      );
    }

    /*
     * Temporal coverage, the case the check above cannot see: not all models carry all
     * variables, and the combination a model does not run comes back null under its
     * real unit rather than as an unserved name — per-model columns are reported
     * separately, since the gap belongs to one model and not the variable.
     */
    notice.add(describeCoverageGaps(findCoverageGaps('daily', data.daily, rawDailyUnits)));
    notice.add(unitsTrimmedNotice(omittedUnits, 'fewer daily_variables, or fewer models'));

    const dailyRecords = data.daily ? reshapeColumnar(data.daily) : [];
    const models = input.models && input.models.length > 0 ? input.models : undefined;
    const dateRange = {
      start: (dailyRecords[0]?.time as string) ?? input.start_date,
      end: (dailyRecords[dailyRecords.length - 1]?.time as string) ?? input.end_date,
    };

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
          elevation: data.elevation,
          timezone: data.timezone,
          models,
          date_range: dateRange,
          record_count: handle.rowCount,
          // Same selection the canvas-less branch makes, so both paths return the same
          // rows for the same records.
          daily: boundedPreview(dailyRecords, rowBudget),
          daily_units: dailyUnits,
          canvas_id: instance.canvasId,
          table_name: handle.tableName,
          truncated: true,
        };
      }

      /*
       * No canvas (CANVAS_PROVIDER_TYPE=none, the default): bound the preview anyway.
       * Falling through to the full inline return would report truncated: false on a
       * multi-decade, multi-model pull.
       *
       * The disclosure is composed into `notice` as well as rendered by format(), for
       * the reason the canvas pointer is: a structuredContent-only client reads one
       * surface, and on this branch the omitted rows are behind no canvas at all.
       */
      notice.add(noCanvasNotice(PAYLOAD_NARROWING));
      return {
        latitude: data.latitude,
        longitude: data.longitude,
        elevation: data.elevation,
        timezone: data.timezone,
        models,
        date_range: dateRange,
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
      elevation: data.elevation,
      timezone: data.timezone,
      models,
      date_range: dateRange,
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
      '## Climate projections (CMIP6)',
      `**Location:** ${result.latitude}, ${result.longitude} | **Elevation:** ${result.elevation}m | **Timezone:** ${result.timezone}`,
      `**Models:** ${result.models?.join(', ') ?? 'API default'}`,
      `**Date range:** ${result.date_range.start} → ${result.date_range.end} | **Records:** ${result.record_count} | **Truncated:** ${result.truncated}`,
    ];

    if (result.truncated && result.canvas_id) {
      lines.push(`\n${canvasPointerLine(result.canvas_id, result.table_name ?? '')}`);
    } else if (result.truncated) {
      lines.push(`\n${noCanvasNotice(PAYLOAD_NARROWING)}`);
    }

    if (result.daily_units) lines.push(`\n**Daily units:** ${formatUnits(result.daily_units)}`);

    if (result.daily.length > 0) {
      // When truncated, result.daily is the preview array — render all of it so
      // content[] matches structuredContent.daily; the heading references
      // record_count (the full upstream total), not the preview length. "on canvas"
      // only when one exists — with canvas disabled nothing holds the omitted rows.
      lines.push(
        '',
        result.truncated
          ? `### Daily projections (preview — ${result.daily.length} shown of ${result.record_count} total rows${result.canvas_id ? ' on canvas' : ''})`
          : `### Daily projections (${result.daily.length} records)`,
      );
      for (const rec of result.daily) lines.push(formatRecord(rec));
    }

    lines.push('', '_Weather data by Open-Meteo.com_');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
