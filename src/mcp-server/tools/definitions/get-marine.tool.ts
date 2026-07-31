/**
 * @fileoverview Tool: openmeteo_get_marine — marine wave and ocean forecast plus archive.
 * Reshapes columnar response into per-timestamp records. Serves either the forecast
 * window (forecast_days + past_days) or an archive range (start_date + end_date), which
 * upstream treats as mutually exclusive. A wide window reaches the same payload class as
 * the other spill-capable tools, so it carries the shared spillover pattern: spill to
 * DataCanvas when canvas is enabled, bounded preview with truncated: true when it is not.
 * @module mcp-server/tools/definitions/get-marine
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';
import {
  getOpenMeteoService,
  type MarineParams,
} from '@/services/open-meteo/open-meteo-service.js';
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
  MARINE_CADENCE,
  undefinedUnitColumns,
} from '../variable-cadence.js';

export const openmeteoGetMarineTool = tool('openmeteo_get_marine', {
  description:
    'Marine wave and ocean conditions for a coastal or ocean coordinate: wave height, wave period, ' +
    'wave direction, wind-wave height, swell height, sea-surface temperature. Forecast horizon up to ' +
    '8 days, with optional past_days (up to 92) for recent history — or start_date and end_date ' +
    'together for an archive range, which returns real wave values back to at least 2022. One window ' +
    'per call: a date range is mutually exclusive with forecast_days and past_days, and needs both ' +
    'ends — a lone start_date or end_date is rejected. ' +
    'Returns per-timestamp records — each entry contains a "time" field plus one key per requested variable. Best for open-ocean ' +
    'and coastal exposed points — sheltered inland waters return near-zero wave values. ' +
    'Common hourly variables: wave_height, wave_direction, wave_period, wind_wave_height, ' +
    'wind_wave_direction, wind_wave_period, swell_wave_height, swell_wave_direction, ' +
    'swell_wave_period. Common daily: wave_height_max, wave_direction_dominant, wave_period_max. ' +
    'Note: ocean_current_velocity is null for non-open-ocean coordinates. ' +
    'A wide window — a large past_days or date range plus many variables — produces thousands of ' +
    'records; these spill to DataCanvas for SQL querying when canvas is enabled, and return a ' +
    'bounded preview with truncated: true when it is not.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'invalid_variable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An unknown marine variable name was requested',
      recovery:
        'Check variable names against Open-Meteo marine docs. Common: wave_height, wave_direction, wave_period, wind_wave_height, swell_wave_height, wave_height_max.',
      retryable: false,
    },
    {
      reason: 'variable_wrong_cadence',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A variable Open-Meteo documents under one cadence was passed in the other cadence field — for example wave_height in daily_variables, or wave_height_max in hourly_variables',
      recovery:
        'Move each variable the message names to the field the message names, or drop it — hourly_variables and daily_variables take separate marine variable sets, and the message lists the same-cadence alternatives when the endpoint publishes any.',
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
      reason: 'date_range_incomplete',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Only one of start_date / end_date was provided — the marine archive requires the pair together',
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
        'Latitude of a coastal or ocean point. Use openmeteo_search_locations to resolve a place name. Inland points return near-zero wave values.',
      ),
    longitude: z.number().min(-180).max(180).describe('Longitude in decimal degrees.'),
    hourly_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Hourly marine variables (e.g., ["wave_height", "wave_direction", "wave_period", "wind_wave_height", "swell_wave_height"]). Hourly names only — a daily aggregate such as wave_height_max or wave_direction_dominant belongs in daily_variables and is rejected here. At least one of hourly_variables or daily_variables required.',
      ),
    daily_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Daily marine summary variables (e.g., ["wave_height_max", "wave_direction_dominant", "wave_period_max"]). Daily names only — an hourly name such as wave_height belongs in hourly_variables and is rejected here; for a daily summary use its published aggregate (wave_height_max). At least one of hourly_variables or daily_variables required.',
      ),
    forecast_days: z
      .number()
      .int()
      .min(1)
      .max(8)
      .optional()
      .describe(
        'Forecast horizon in days (1–8). Omit for the upstream default of 7. Mutually exclusive with start_date/end_date — omit it entirely when pulling an archive range.',
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
        'Start date for the archive range (YYYY-MM-DD, e.g., "2024-07-01"). Real wave values go back to at least 2022. Requires end_date — the pair must be sent together, and neither combines with forecast_days or past_days.',
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
        'Total number of records (hourly + daily rows) — the full upstream total when truncated is true, not the combined length of the hourly and daily previews.',
      ),
    hourly: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Per-hour records with "time" (ISO 8601) + one key per requested variable (e.g., wave_height in meters, wave_direction in degrees, wave_period in seconds). Absent when only daily_variables were requested. When truncated, contains only a preview — query canvas_id for the full dataset when one is present.',
      ),
    daily: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Per-day summary records with "time" (YYYY-MM-DD) + variable keys (e.g., wave_height_max in meters, wave_direction_dominant in degrees, wave_period_max in seconds). When truncated, contains only a preview — query canvas_id for the full dataset when one is present.',
      ),
    hourly_units: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Variable → unit string for hourly data (e.g., {"wave_height": "m", "wave_period": "s"}). Absent when no hourly_variables were requested.',
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
        'Warning that a requested variable came back with no data — names each column whose unit is "undefined", which is how the endpoint reports a name it parsed but does not serve.',
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
     * marine variable with a 400 that echoes the entire encoded list — valid siblings
     * included, so the offender is never isolated. Unknown names are not misplacements
     * and go upstream untouched.
     */
    const mismatches = findCadenceMismatches(
      MARINE_CADENCE,
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

    /**
     * The marine endpoint takes the forecast window or an archive range, never both,
     * and rejects a half-specified range. Guarding here rather than letting upstream
     * reject keeps both cases off the post-call invalid_variable branch, which frames
     * every rejection as an unknown variable name — advice that fixes neither.
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
        'forecast_days/past_days cannot be combined with start_date/end_date — the marine endpoint serves either the forecast window or an archive range, not both.',
        ctx.recoveryFor('forecast_window_conflict'),
      );
    }

    if (hasStart !== hasEnd) {
      throw ctx.fail(
        'date_range_incomplete',
        `The marine archive needs start_date and end_date together — only ${hasStart ? 'start_date' : 'end_date'} was provided.`,
        ctx.recoveryFor('date_range_incomplete'),
      );
    }

    // past_days: 0 is the schema default, not an opt-in — sending it alongside a date
    // range is exactly the combination upstream rejects, so the two windows are built
    // as disjoint parameter sets rather than merged.
    const window: MarineParams = hasStart
      ? { start_date: input.start_date, end_date: input.end_date }
      : { forecast_days: input.forecast_days, past_days: input.past_days };

    const service = getOpenMeteoService();
    const data = await service.getMarine(
      input.latitude,
      input.longitude,
      {
        hourly: input.hourly_variables,
        daily: input.daily_variables,
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
    const dailyUnits = toUnitsMap(data.daily_units as Record<string, unknown> | undefined);

    /*
     * Backstop for a name the catalog does not carry: the marine endpoint shares the
     * forecast API's variable parser, so a weather or air-quality name it does not
     * serve — temperature_2m, pm2_5 — comes back as HTTP 200 with an all-null column
     * whose unit is the literal string "undefined" rather than a rejection. Left unsaid
     * that reads as a genuine data gap. Only a name the parser cannot resolve at all is
     * rejected upstream.
     */
    const emptyColumns = undefinedUnitColumns(hourlyUnits, dailyUnits);
    if (emptyColumns.length > 0) {
      ctx.enrich.notice(
        `${emptyColumns.join(', ')} returned no data — Open-Meteo reported the unit as "undefined", which means the marine endpoint does not serve that name. Check it against the marine variable list (wave_height, wave_period, swell_wave_height, sea_surface_temperature, …); weather variables belong in openmeteo_get_forecast.`,
      );
    }

    const hourlyRecords = data.hourly ? reshapeColumnar(data.hourly) : undefined;
    const dailyRecords = data.daily ? reshapeColumnar(data.daily) : undefined;
    const allRecords = [...(hourlyRecords ?? []), ...(dailyRecords ?? [])];

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
          timezone: data.timezone,
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
       * 92-day hourly window. Split by timestamp shape the same way the canvas branch
       * splits spillover()'s preview rows, so both paths return the same preview for
       * the same records.
       */
      const preview = splitByCadence(boundedPreview(allRecords));
      return {
        latitude: data.latitude,
        longitude: data.longitude,
        timezone: data.timezone,
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
      timezone: data.timezone,
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
      '## Marine conditions',
      `**Location:** ${result.latitude}, ${result.longitude} | **Timezone:** ${result.timezone}`,
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
          'fewer past_days / forecast_days or a shorter start_date–end_date range, or fewer hourly_variables / daily_variables',
        ),
        '',
      );
    }

    if (result.hourly_units) lines.push(`**Hourly units:** ${formatUnits(result.hourly_units)}`);
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
          ? `### Daily marine summary (preview — ${result.daily.length} shown of ${totalRows})`
          : '### Daily marine summary',
      );
      for (const rec of result.daily) lines.push(formatRecord(rec));
    }

    if (result.hourly && result.hourly.length > 0) {
      lines.push(
        '',
        result.truncated
          ? `### Hourly marine (preview — ${result.hourly.length} shown of ${totalRows})`
          : `### Hourly marine (${result.hourly.length} records)`,
      );
      for (const rec of result.hourly) lines.push(formatRecord(rec));
    }

    lines.push('', '_Weather data by Open-Meteo.com_');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
