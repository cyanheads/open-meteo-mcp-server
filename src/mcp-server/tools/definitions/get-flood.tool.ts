/**
 * @fileoverview Tool: openmeteo_get_flood — GloFAS river discharge forecast and reanalysis.
 * Returns daily ensemble river discharge (m³/s) for up to ~7 months ahead, with reanalysis
 * history back to 1984. Coordinate-based — snaps to nearest river automatically. Wide
 * reanalysis ranges spill to DataCanvas when canvas is enabled, and return a bounded
 * preview with truncated: true when it is not.
 * @module mcp-server/tools/definitions/get-flood
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';
import { toUnitsMap } from '@/services/open-meteo/types.js';
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
const PAYLOAD_NARROWING = 'a shorter start_date–end_date range, or fewer daily_variables';

export const openmeteoGetFloodTool = tool('openmeteo_get_flood', {
  description:
    'GloFAS (Global Flood Awareness System) river discharge forecast and historical reanalysis. ' +
    'Returns daily ensemble river discharge (m³/s) for the river nearest to the given coordinates ' +
    '— no river ID needed, the API snaps to the nearest stream. Forecast horizon up to 210 days ' +
    'ahead; reanalysis history back to 1984-01-01. One mode per call: forecast_days for the ' +
    'future outlook, or start_date and end_date together for reanalysis history. The two modes ' +
    'are mutually exclusive, and a date range needs both ends — a lone start_date or end_date is ' +
    'rejected. Available daily variables: "river_discharge" (ensemble mean), "river_discharge_mean", ' +
    '"river_discharge_min", "river_discharge_max", "river_discharge_median", ' +
    '"river_discharge_p25" (25th percentile), "river_discharge_p75" (75th percentile). ' +
    'Returns null for coordinates far from any river or in areas without GloFAS coverage. ' +
    'A wide reanalysis range produces thousands of daily records and spills to a DataCanvas when ' +
    'canvas is enabled, returning canvas_id and table_name with truncated: true — inspect the ' +
    'staged columns with openmeteo_dataframe_describe, then query the full set with ' +
    'openmeteo_dataframe_query. With canvas disabled it returns a bounded preview instead.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'no_variables_requested',
      code: JsonRpcErrorCode.ValidationError,
      when: 'daily_variables was not provided or is empty',
      recovery:
        'Provide daily_variables with at least one discharge variable (e.g., ["river_discharge", "river_discharge_p25", "river_discharge_p75"]).',
      retryable: false,
    },
    {
      reason: 'date_range_incomplete',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Only one of start_date / end_date was provided — GloFAS requires the pair together',
      recovery:
        'Provide both start_date and end_date to pull a historical range, or omit both and use forecast_days for the forecast outlook.',
      retryable: false,
    },
    {
      reason: 'forecast_days_conflict',
      code: JsonRpcErrorCode.ValidationError,
      when: 'forecast_days was combined with start_date or end_date',
      recovery:
        'Drop forecast_days to pull the historical range, or drop start_date and end_date to pull the forecast — GloFAS accepts one mode per call, never both.',
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
      reason: 'date_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'start_date predates 1984-01-01 or date range is otherwise invalid',
      recovery: 'Use start_date >= 1984-01-01. GloFAS reanalysis covers from 1984-01-01 onward.',
      retryable: false,
    },
    {
      reason: 'invalid_variable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An unknown discharge variable name was requested',
      recovery:
        'Valid variables: river_discharge, river_discharge_mean, river_discharge_min, river_discharge_max, river_discharge_median, river_discharge_p25, river_discharge_p75.',
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
        'Latitude in decimal degrees. The API snaps to the nearest river — no river ID required. Use openmeteo_search_locations to resolve a place name.',
      ),
    longitude: z.number().min(-180).max(180).describe('Longitude in decimal degrees.'),
    daily_variables: z
      .array(z.string())
      .max(20)
      .optional()
      .describe(
        'Daily discharge variables to fetch (e.g., ["river_discharge", "river_discharge_p25", "river_discharge_p75", "river_discharge_min", "river_discharge_max"]). Required.',
      ),
    forecast_days: z
      .number()
      .int()
      .min(1)
      .max(210)
      .optional()
      .describe(
        'Number of forecast days ahead (1–210). Mutually exclusive with start_date/end_date — omit it entirely when pulling a historical range.',
      ),
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'Start date for historical reanalysis (YYYY-MM-DD, e.g., "2023-01-01"). GloFAS reanalysis covers from 1984-01-01. Requires end_date — the pair must be sent together, and neither combines with forecast_days.',
      ),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'End date for historical reanalysis (YYYY-MM-DD, inclusive). Must be on or after start_date. Requires start_date — the pair must be sent together, and neither combines with forecast_days.',
      ),
    timezone: z.string().default('auto').describe('IANA timezone or "auto". Default "auto".'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas token for wide reanalysis queries. When a result is too large to return inline — driven by total payload size, so a multi-variable pull can spill at any row count — it spills to this canvas: pass the returned token to openmeteo_dataframe_describe to list the staged table and its columns, then to openmeteo_dataframe_query to run SQL against it. Omit to create a fresh canvas.',
      ),
  }),

  output: z.object({
    latitude: z.number().describe('Snapped latitude (nearest river grid point)'),
    longitude: z.number().describe('Snapped longitude'),
    timezone: z.string().describe('Resolved IANA timezone'),
    record_count: z
      .number()
      .describe(
        'Total number of daily discharge records — the full staged count when truncated is true, not the length of the daily preview.',
      ),
    daily: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Per-day records with "time" (YYYY-MM-DD) + one key per requested variable containing discharge in m³/s, or null for coordinates outside GloFAS coverage. When truncated, contains only a preview — query canvas_id for the full dataset when one is present.',
      ),
    daily_units: z
      .record(z.string(), z.string())
      .optional()
      .describe('Variable → unit string for daily data (e.g., {"river_discharge": "m³/s"}).'),
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
        'Everything this response needs to say beyond the data, composed into one advisory: columns GloFAS returned with the unit "undefined" (a name it parsed but does not serve); recognized variables whose requested range falls outside the coordinate\'s discharge record, with the dates that do carry values; and, when the result spilled, either the canvas and table holding the full row set plus the two dataframe tools that read it, or — with DataCanvas disabled — why there is no canvas_id and how to reach the rows the preview omits.',
      ),
  },

  async handler(input, ctx) {
    const dailyVariables = input.daily_variables;
    if (!dailyVariables || dailyVariables.length === 0) {
      throw ctx.fail(
        'no_variables_requested',
        'Provide daily_variables with at least one discharge variable.',
        ctx.recoveryFor('no_variables_requested'),
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
        ctx.recoveryFor('forecast_days_conflict'),
      );
    }

    if (hasStart !== hasEnd) {
      throw ctx.fail(
        'date_range_incomplete',
        `GloFAS needs start_date and end_date together — only ${hasStart ? 'start_date' : 'end_date'} was provided.`,
        ctx.recoveryFor('date_range_incomplete'),
      );
    }

    if (input.start_date && input.end_date && input.end_date < input.start_date) {
      throw ctx.fail(
        'date_order_invalid',
        `end_date (${input.end_date}) is before start_date (${input.start_date}).`,
        ctx.recoveryFor('date_order_invalid'),
      );
    }

    if (input.start_date && input.start_date < '1984-01-01') {
      throw ctx.fail(
        'date_out_of_range',
        `start_date ${input.start_date} predates GloFAS reanalysis coverage (1984-01-01).`,
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
    const data = await service.getFlood(
      input.latitude,
      input.longitude,
      {
        daily: dailyVariables,
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
          reason || 'Date out of GloFAS range.',
          ctx.recoveryFor('date_out_of_range'),
        );
      }
      throw ctx.fail(
        'invalid_variable',
        frameInvalidVariableMessage(data.reason, 'discharge variable'),
        ctx.recoveryFor('invalid_variable'),
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
    } = inlineBudget(rawDailyUnits);

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
     * Temporal coverage, the case the check above cannot see: a reanalysis range
     * opening before the nearest river's record begins comes back null with the real
     * m³/s unit until it does, which the null column alone cannot distinguish from a
     * coordinate outside GloFAS coverage entirely.
     */
    notice.add(describeCoverageGaps(findCoverageGaps('daily', data.daily, rawDailyUnits)));
    notice.add(unitsTrimmedNotice(omittedUnits, 'fewer daily_variables'));

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
       * No canvas (CANVAS_PROVIDER_TYPE=none, the default): bound the preview anyway.
       * Falling through to the full inline return would report truncated: false on a
       * multi-decade reanalysis pull.
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
      '## GloFAS river discharge forecast',
      `**Location:** ${result.latitude}, ${result.longitude} | **Timezone:** ${result.timezone}`,
      `**Records:** ${result.record_count} | **Truncated:** ${result.truncated}`,
    ];

    if (result.truncated && result.canvas_id) {
      lines.push(`\n${canvasPointerLine(result.canvas_id, result.table_name ?? '')}`);
    } else if (result.truncated) {
      lines.push(`\n${noCanvasNotice(PAYLOAD_NARROWING)}`);
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
