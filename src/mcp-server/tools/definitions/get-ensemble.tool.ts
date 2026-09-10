/**
 * @fileoverview Tool: openmeteo_get_ensemble — probabilistic ensemble weather forecast.
 * Returns per-member hourly/daily time series from NWP ensemble models (up to 64 members,
 * 16 days ahead). Large multi-member pulls spill to DataCanvas when canvas is enabled,
 * and return a bounded preview with truncated: true when it is not.
 * @module mcp-server/tools/definitions/get-ensemble
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';
import { type ColumnarBlock, toUnitsMap } from '@/services/open-meteo/types.js';
import { ENSEMBLE_MODEL_LIST, ENSEMBLE_MODEL_NAMES } from '../model-catalog.js';
import { formatRecord, formatUnits, reshapeColumnar } from '../reshape-utils.js';
import {
  byEnsembleVariable,
  composeNotice,
  describeCoverageGaps,
  findCoverageGaps,
} from '../response-notice.js';
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
  ENSEMBLE_CADENCE,
  findCadenceMismatches,
  undefinedUnitColumns,
} from '../variable-cadence.js';

/**
 * The inputs that shrink this tool's payload, named wherever a response has to tell the
 * caller how to ask for less: the upstream too-much-data rejection, and the no-canvas
 * preview notice on both response surfaces. `models` takes one model, so the lever is a
 * lighter model rather than a shorter list.
 */
const PAYLOAD_NARROWING =
  'fewer forecast_days / past_days, fewer hourly_variables / daily_variables, or a models value with fewer members (gem_global_ensemble has 21, ecmwf_ifs025_ensemble 51)';

/**
 * Variable names behind the columns upstream reported with unit `"undefined"`, with the
 * `_memberNN` suffix stripped so one unserved variable is named once rather than once
 * per member — a 51-member fan-out would otherwise produce a 51-name notice.
 */
function unservedVariables(...unitMaps: (Record<string, string> | undefined)[]): string[] {
  return [
    ...new Set(undefinedUnitColumns(...unitMaps).map((column) => byEnsembleVariable(column))),
  ];
}

/**
 * Count distinct ensemble members from per-member column names (_memberNN suffix).
 * The API envelope carries no top-level member metadata — column names are the
 * only member identity. Returns undefined when no member columns exist.
 */
function countMembers(...blocks: (ColumnarBlock | undefined)[]): number | undefined {
  const members = new Set<string>();
  for (const block of blocks) {
    if (!block) continue;
    for (const key of Object.keys(block)) {
      const suffix = /_member(\d+)$/.exec(key)?.[1];
      if (suffix) members.add(suffix);
    }
  }
  return members.size > 0 ? members.size : undefined;
}

export const openmeteoGetEnsembleTool = tool('openmeteo_get_ensemble', {
  description:
    'Probabilistic ensemble weather forecast — up to 64 ensemble members, up to 16 days ahead ' +
    "with optional past_days (0–92). Each member's values appear as separate columns named " +
    'with a member suffix (e.g. temperature_2m_member01, temperature_2m_member02). Use the spread ' +
    'across members to compute exceedance probabilities, quantify forecast uncertainty, and build ' +
    `decision thresholds. Available models: ${ENSEMBLE_MODEL_LIST}. Omit models to use the API ` +
    'default blend. A regional model returns no data outside the area it covers; that comes back ' +
    'as an input error naming the coverage gap, not a transient failure, so pick a global model ' +
    'or move the coordinate inside the region rather than retrying. A model name this list does ' +
    'not carry is still sent upstream, so a newly added one keeps working. ' +
    'Large multi-member, multi-day pulls produce thousands of records and spill to a DataCanvas ' +
    'when canvas is enabled, returning canvas_id and table_name with truncated: true — inspect ' +
    'the staged columns with openmeteo_dataframe_describe, then query the full set with ' +
    'openmeteo_dataframe_query. With canvas disabled they return a bounded preview instead. ' +
    'At least one of hourly_variables or daily_variables is required.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
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
      when: 'An unknown variable name or unsupported model was requested',
      recovery: `Check the variable name against Open-Meteo ensemble docs. Common hourly: temperature_2m, precipitation, wind_speed_10m. Common daily: temperature_2m_max, temperature_2m_min, precipitation_sum. Documented models: ${ENSEMBLE_MODEL_NAMES}.`,
      retryable: false,
    },
    {
      reason: 'variable_wrong_cadence',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A variable the ensemble API documents under one cadence was passed in the other cadence field — for example precipitation_sum in hourly_variables, or precipitation in daily_variables',
      recovery:
        'Move each variable the message names to the field the message names, or drop it — hourly_variables and daily_variables take separate ensemble variable sets, and the message lists the same-cadence alternatives when the endpoint publishes any.',
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
      recovery: `Narrow the request and retry: ${PAYLOAD_NARROWING}. Every requested name and the model are valid — the size of the request is what was rejected.`,
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
    hourly_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Hourly variables to fetch across all ensemble members (e.g., ["temperature_2m", "precipitation", "wind_speed_10m"]). Each variable appears as temperature_2m_member01, temperature_2m_member02, … in the output. Hourly names only — a daily-only aggregate such as precipitation_sum or wind_speed_10m_max belongs in daily_variables and is rejected here; temperature_2m_max and temperature_2m_min are an exception, published here as 3-hourly aggregations as well as daily. At least one of hourly_variables or daily_variables required.',
      ),
    daily_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Daily variables to fetch across all ensemble members (e.g., ["temperature_2m_max", "temperature_2m_min", "precipitation_sum"]). Each variable appears as temperature_2m_max_member01, … Daily names only — an hourly name such as precipitation or temperature_2m belongs in hourly_variables and is rejected here; for a daily summary use its published aggregate (precipitation_sum, temperature_2m_max). At least one of hourly_variables or daily_variables required.',
      ),
    models: z
      .string()
      .optional()
      .describe(
        `Ensemble model to use, one name: ${ENSEMBLE_MODEL_LIST}. Member counts include the control run. Omit to use the API default blend. A name outside this list is sent upstream rather than rejected here, so a model Open-Meteo adds later still works.`,
      ),
    forecast_days: z
      .number()
      .int()
      .min(1)
      .max(16)
      .default(7)
      .describe('Forecast horizon in days (1–16). Default 7.'),
    past_days: z
      .number()
      .int()
      .min(0)
      .max(92)
      .default(0)
      .describe('Include this many days of past ensemble data before today (0–92). Default 0.'),
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
    timezone: z
      .string()
      .default('auto')
      .describe(
        'IANA timezone (e.g., "America/Los_Angeles") or "auto" to use the location\'s local timezone. Default "auto".',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas token for large multi-member queries. When a result is too large to return inline — driven by total payload size, so a wide member fan-out can spill at any row count — it spills to this canvas: pass the returned token to openmeteo_dataframe_describe to list the staged table and its per-member columns, then to openmeteo_dataframe_query to run SQL against it. Omit to create a fresh canvas.',
      ),
  }),

  output: z.object({
    latitude: z.number().describe('Snapped latitude (Open-Meteo snaps to nearest grid point)'),
    longitude: z.number().describe('Snapped longitude'),
    elevation: z.number().describe('Terrain elevation at grid point (meters)'),
    timezone: z.string().describe('Resolved IANA timezone'),
    model: z
      .string()
      .optional()
      .describe(
        'Ensemble model used (e.g. "ecmwf_ifs025_ensemble") — echoes the requested models parameter. Absent when models was omitted (API default blend; the API reports no provenance).',
      ),
    member_count: z
      .number()
      .optional()
      .describe(
        'Number of distinct perturbed ensemble members in the response, counted from the _memberNN column suffixes. The unsuffixed base column (the control run) is not included in this count.',
      ),
    hourly: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Per-hour records with "time" (ISO 8601) + per-member columns for each requested variable (e.g., temperature_2m_member01, temperature_2m_member02). Absent when only daily_variables were requested. When truncated, contains a preview only — query canvas_id for the full dataset when one is present.',
      ),
    daily: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Per-day records with "time" (YYYY-MM-DD) + per-member columns (e.g., temperature_2m_max_member01). Absent when only hourly_variables were requested. When truncated, contains a preview only — query canvas_id for the full dataset when one is present.',
      ),
    hourly_units: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Variable → unit string for hourly data (e.g., {"temperature_2m_member01": "°C"}). Absent when no hourly_variables were requested.',
      ),
    daily_units: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Variable → unit string for daily data. Absent when no daily_variables were requested.',
      ),
    record_count: z
      .number()
      .describe(
        'Total number of records (hourly + daily rows) — the full upstream total when truncated is true, not the combined length of the hourly and daily previews.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas token for the staged full dataset. Present only when truncated is true AND DataCanvas is enabled (CANVAS_PROVIDER_TYPE=duckdb) — absent otherwise, in which case the preview is all this response carries. Pass to openmeteo_dataframe_describe to list the staged table and its per-member columns, then to openmeteo_dataframe_query to run SQL against it.',
      ),
    table_name: z
      .string()
      .optional()
      .describe(
        'DuckDB table name for the staged data — use as the FROM target in openmeteo_dataframe_query SQL; openmeteo_dataframe_describe lists its columns, which is the only way to learn the per-member suffixes this request produced. Present only alongside canvas_id.',
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
        'Everything this response needs to say beyond the data, composed into one advisory: variables the endpoint returned with the unit "undefined" across every member (a name the selected model does not carry); recognized variables whose requested window runs past the model\'s horizon, with the timestamps that do carry values; and, when the result spilled, either the canvas and table holding the full row set plus the two dataframe tools that read it, or — with DataCanvas disabled — why there is no canvas_id and how to reach the rows the preview omits.',
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
     * Reject a confident misplacement before the call. Upstream rejects a wrong-bucket
     * name as an unknown one: it names the value but not the field it belongs in, and
     * has no notion of a same-cadence alternative. The ensemble catalog is its own: this endpoint
     * publishes temperature_2m_max under both cadences, and a name in both is never
     * reported. Unknown names are not misplacements and go upstream untouched.
     */
    const mismatches = findCadenceMismatches(
      ENSEMBLE_CADENCE,
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
    const data = await service.getEnsemble(
      input.latitude,
      input.longitude,
      {
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
        frameInvalidVariableMessage(data.reason, 'variable or model'),
        ctx.recoveryFor('invalid_variable'),
      );
    }

    const rawHourlyUnits = toUnitsMap(data.hourly_units as Record<string, unknown> | undefined);
    const rawDailyUnits = toUnitsMap(data.daily_units as Record<string, unknown> | undefined);

    /*
     * Split the inline ceiling between the unit maps and the preview rows before
     * anything is measured against it. This is the tool the split exists for: a member
     * fan-out publishes a unit entry per member per variable, so the maps are a real
     * share of the response rather than a rounding error. The raw maps stay in scope —
     * they drive the analysis below, so an entry the payload had to drop is still
     * reported on.
     */
    const {
      units: [hourlyUnits, dailyUnits],
      omittedUnits,
      rowBudget,
    } = inlineBudget(undefined, rawHourlyUnits, rawDailyUnits);

    // One notice, composed — ctx.enrich.notice is last-write-wins on a single key.
    const notice = composeNotice(ctx);

    /*
     * Backstop for a name the catalog does not carry, and for one it does that the
     * chosen model does not run: the ensemble endpoint answers both with HTTP 200 and
     * an all-null column per member whose unit is the literal string "undefined".
     * temperature_2m_max is served by ecmwf_ifs025 and null under gfs025, so this is a
     * notice rather than a failure — the name may be valid and simply unavailable from
     * the selected model.
     */
    const emptyVariables = unservedVariables(rawHourlyUnits, rawDailyUnits);
    if (emptyVariables.length > 0) {
      notice.add(
        `${emptyVariables.join(', ')} returned no data on any member — Open-Meteo reported the unit as "undefined", which means ${input.models ?? 'the default blend'} does not carry that name in the cadence it was requested under. Try another models value, move it to the other cadence field, or drop it.`,
      );
    }

    /*
     * Temporal coverage, the case the check above cannot see: a model whose horizon is
     * shorter than forecast_days fills the remainder with nulls under a real unit —
     * ncep_gefs025 serves about ten days and returns °C nulls for the rest of a
     * sixteen-day window. Members are grouped back to the variable that was asked for,
     * so a 51-member fan-out reports one gap rather than fifty-one.
     */
    notice.add(
      describeCoverageGaps(
        findCoverageGaps('hourly', data.hourly, rawHourlyUnits, byEnsembleVariable),
        findCoverageGaps('daily', data.daily, rawDailyUnits, byEnsembleVariable),
      ),
    );
    notice.add(
      unitsTrimmedNotice(
        omittedUnits,
        'fewer hourly_variables / daily_variables, or a models value with fewer members',
      ),
    );

    const hourlyRecords = data.hourly ? reshapeColumnar(data.hourly) : undefined;
    const dailyRecords = data.daily ? reshapeColumnar(data.daily) : undefined;
    const allRecords = [...(hourlyRecords ?? []), ...(dailyRecords ?? [])];

    /*
     * The API envelope has no top-level model/member metadata: echo the requested
     * model and derive the member count from the per-member column names.
     */
    const model = input.models;
    const memberCount = countMembers(data.hourly, data.daily);

    // DataCanvas spillover for payloads too large to return inline
    if (exceedsInlineBudget(allRecords, rowBudget)) {
      const canvas = getCanvas();
      if (canvas) {
        const instance = await canvas.acquire(input.canvas_id, ctx);
        // Stage the full chronological set — spillover preserves source order on the
        // canvas. The inline preview is selected separately below (see #14).
        const handle = await stageSpill(instance, allRecords, ctx.signal);
        notice.add(canvasPointerNotice(handle.rowCount, handle.tableName, instance.canvasId));

        /*
         * Inline preview: one budget divided between the cadences, the same bound the
         * other three two-cadence tools apply — measuring each cadence against the whole
         * budget let a two-cadence ensemble response carry twice the inline ceiling of
         * every other tool, on the widest payload the server serves. Each cadence still
         * favors rows with data, which past_days responses need: they lead with all-null
         * placeholder rows the models don't hindcast, so a raw chronological head can be
         * entirely null. The canvas holds every row in chronological order regardless.
         */
        const preview = boundedPreviewByCadence(hourlyRecords, dailyRecords, rowBudget);

        return {
          latitude: data.latitude,
          longitude: data.longitude,
          elevation: data.elevation,
          timezone: data.timezone,
          model,
          member_count: memberCount,
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
       * multi-megabyte member fan-out. Same per-cadence preview selection the canvas
       * branch uses, so both paths return the same rows for the same records.
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
        model,
        member_count: memberCount,
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
      model,
      member_count: memberCount,
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
      '## Ensemble weather forecast',
      `**Location:** ${result.latitude}, ${result.longitude} | **Elevation:** ${result.elevation}m | **Timezone:** ${result.timezone}`,
    ];
    if (result.model || result.member_count != null) {
      lines.push(
        `**Model:** ${result.model ?? 'default blend'} | **Members:** ${result.member_count ?? 'unknown'}`,
      );
    }
    lines.push(`**Records:** ${result.record_count} | **Truncated:** ${result.truncated}`);

    if (result.truncated && result.canvas_id) {
      lines.push(
        `\n${canvasPointerLine(result.canvas_id, result.table_name ?? '')}`,
        `_Preview favors rows with data: any leading all-null rows (e.g. past_days placeholders the models don't hindcast) are omitted here but staged in full chronological order on the canvas._`,
      );
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
          ? `### Daily ensemble summary (preview — ${result.daily.length} shown of ${totalRows})`
          : `### Daily ensemble summary (${result.daily.length} records)`,
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
          ? `### Hourly ensemble (preview — ${result.hourly.length} shown of ${totalRows})`
          : `### Hourly ensemble (${result.hourly.length} records)`,
      );
      for (const rec of result.hourly) lines.push(formatRecord(rec));
    }

    lines.push('', '_Weather data by Open-Meteo.com_');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
