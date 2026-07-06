/**
 * @fileoverview Tool: openmeteo_get_ensemble — probabilistic ensemble weather forecast.
 * Returns per-member hourly/daily time series from NWP ensemble models (up to 51 members,
 * 16 days ahead). Large multi-member pulls spill to DataCanvas when canvas is enabled.
 * @module mcp-server/tools/definitions/get-ensemble
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';
import { type ColumnarBlock, toUnitsMap } from '@/services/open-meteo/types.js';
import { formatRecord, formatUnits, reshapeColumnar } from '../reshape-utils.js';
import { frameInvalidVariableMessage } from '../upstream-error.js';

/** Inline record limit before DataCanvas spillover. */
const INLINE_LIMIT = 500;

/** Character budget for the inline preview — mirrors the spillover previewChars budget. */
const PREVIEW_CHARS = 80_000;

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

/** True when a record carries a non-null value in any column other than `time`. */
function hasNonNullValue(record: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'time' && value != null) return true;
  }
  return false;
}

/**
 * Build a byte-bounded inline preview that begins at the first record carrying data.
 *
 * Ensemble responses with past_days lead with all-null placeholder rows — the models
 * don't hindcast — so the chronological head that spillover()'s byte-drain returns can
 * be entirely null while the staged canvas holds the useful forecast rows. Skip the
 * leading all-null run for the *preview only*; spillover still stages every row in
 * chronological order on the canvas.
 */
function selectPreviewRows(records: Record<string, unknown>[]): Record<string, unknown>[] {
  const firstUseful = records.findIndex(hasNonNullValue);
  const start = firstUseful < 0 ? 0 : firstUseful;
  const rows: Record<string, unknown>[] = [];
  let chars = 0;
  for (const row of records.slice(start)) {
    chars += JSON.stringify(row).length;
    if (chars > PREVIEW_CHARS && rows.length > 0) break;
    rows.push(row);
  }
  return rows;
}

export const openmeteoGetEnsembleTool = tool('openmeteo_get_ensemble', {
  description:
    'Probabilistic ensemble weather forecast — up to 51 ensemble members, up to 16 days ahead ' +
    "with optional past_days (0–92). Each member's values appear as separate columns named " +
    'with a member suffix (e.g. temperature_2m_member01, temperature_2m_member02). Use the spread ' +
    'across members to compute exceedance probabilities, quantify forecast uncertainty, and build ' +
    'decision thresholds. Available models: "ecmwf_ifs025" (51 members, global, 0.25°), ' +
    '"gfs025" (31 members, global, 0.25°), "icon_seamless" (40 members, global/Europe blend), ' +
    '"gem_global" (21 members, global, 0.25°). Omit models to use the API default blend. ' +
    'Large multi-member, multi-day pulls produce thousands of records and spill to DataCanvas ' +
    'when canvas is enabled. At least one of hourly_variables or daily_variables is required.',
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
      recovery:
        'Check the variable name against Open-Meteo ensemble docs. Common hourly: temperature_2m, precipitation, wind_speed_10m. Common daily: temperature_2m_max, temperature_2m_min, precipitation_sum. Valid models: ecmwf_ifs025, gfs025, icon_seamless, gem_global.',
      retryable: false,
    },
  ],

  input: z.object({
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .describe(
        'Latitude in decimal degrees. Use openmeteo_geocode to resolve a place name to coordinates.',
      ),
    longitude: z.number().min(-180).max(180).describe('Longitude in decimal degrees.'),
    hourly_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Hourly variables to fetch across all ensemble members (e.g., ["temperature_2m", "precipitation", "wind_speed_10m"]). Each variable appears as temperature_2m_member01, temperature_2m_member02, … in the output. At least one of hourly_variables or daily_variables required.',
      ),
    daily_variables: z
      .array(z.string())
      .max(50)
      .optional()
      .describe(
        'Daily variables to fetch across all ensemble members (e.g., ["temperature_2m_max", "temperature_2m_min", "precipitation_sum"]). Each variable appears as temperature_2m_max_member01, … At least one of hourly_variables or daily_variables required.',
      ),
    models: z
      .string()
      .optional()
      .describe(
        'Ensemble model to use: "ecmwf_ifs025" (51 members, global 0.25°), "gfs025" (31 members), "icon_seamless" (40 members), "gem_global" (21 members). Omit to use the API default blend.',
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
        'DataCanvas token for large multi-member queries. When records exceed ~500, results spill to this canvas for SQL querying. Omit to create a fresh canvas.',
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
        'Ensemble model used (e.g. "ecmwf_ifs025") — echoes the requested models parameter. Absent when models was omitted (API default blend; the API reports no provenance).',
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
        'Per-hour records with "time" (ISO 8601) + per-member columns for each requested variable (e.g., temperature_2m_member01, temperature_2m_member02). Absent when only daily_variables were requested. When truncated, contains a preview only; query canvas_id for the full dataset.',
      ),
    daily: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'Per-day records with "time" (YYYY-MM-DD) + per-member columns (e.g., temperature_2m_max_member01). Absent when only hourly_variables were requested. When truncated, contains a preview only; query canvas_id for the full dataset.',
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
      .describe('Total number of records (hourly + daily rows) in this response'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas token — present only when truncated is true (data spilled). Query with SQL using this token.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when the response exceeded the inline record limit and data spilled to canvas_id. Query the canvas for the full dataset.',
      ),
  }),

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
      throw ctx.fail(
        'invalid_variable',
        frameInvalidVariableMessage(data.reason, 'variable or model'),
        ctx.recoveryFor('invalid_variable'),
      );
    }

    const hourlyRecords = data.hourly ? reshapeColumnar(data.hourly) : undefined;
    const dailyRecords = data.daily ? reshapeColumnar(data.daily) : undefined;
    const totalRecords = (hourlyRecords?.length ?? 0) + (dailyRecords?.length ?? 0);

    /*
     * The API envelope has no top-level model/member metadata: echo the requested
     * model and derive the member count from the per-member column names.
     */
    const model = input.models;
    const memberCount = countMembers(data.hourly, data.daily);

    // DataCanvas spillover for large multi-member datasets
    if (totalRecords > INLINE_LIMIT) {
      const canvas = getCanvas();
      if (canvas) {
        const instance = await canvas.acquire(input.canvas_id, ctx);
        const allRecords = [...(hourlyRecords ?? []), ...(dailyRecords ?? [])];
        // Stage the full chronological set — spillover preserves source order on the
        // canvas. The inline preview is selected separately below (see #14).
        const spilled = await spillover({
          canvas: instance,
          source: allRecords,
          previewChars: PREVIEW_CHARS,
          signal: ctx.signal,
        });

        // Inline preview: when spilled, favor rows with data — past_days responses
        // lead with all-null placeholder rows, so a raw chronological head can be
        // entirely null. When not spilled the whole set fit inline, so return it
        // complete. Either way the canvas holds every row in chronological order.
        const hourlyPreview = spilled.spilled
          ? selectPreviewRows(hourlyRecords ?? [])
          : (hourlyRecords ?? []);
        const dailyPreview = spilled.spilled
          ? selectPreviewRows(dailyRecords ?? [])
          : (dailyRecords ?? []);

        return {
          latitude: data.latitude,
          longitude: data.longitude,
          elevation: data.elevation,
          timezone: data.timezone,
          model,
          member_count: memberCount,
          record_count: spilled.spilled ? spilled.handle.rowCount : allRecords.length,
          hourly: hourlyPreview,
          daily: dailyPreview,
          hourly_units: toUnitsMap(data.hourly_units as Record<string, unknown> | undefined),
          daily_units: toUnitsMap(data.daily_units as Record<string, unknown> | undefined),
          // Only point at the canvas when data actually spilled — spillover()
          // stages a table only past its byte threshold, so a canvas_id on the
          // non-spilled path would reference an empty canvas.
          canvas_id: spilled.spilled ? instance.canvasId : undefined,
          truncated: spilled.spilled,
        };
      }
    }

    return {
      latitude: data.latitude,
      longitude: data.longitude,
      elevation: data.elevation,
      timezone: data.timezone,
      model,
      member_count: memberCount,
      record_count: totalRecords,
      hourly: hourlyRecords,
      daily: dailyRecords,
      hourly_units: toUnitsMap(data.hourly_units as Record<string, unknown> | undefined),
      daily_units: toUnitsMap(data.daily_units as Record<string, unknown> | undefined),
      canvas_id: undefined,
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
        `\n⚠️ Large result — full data staged on canvas \`${result.canvas_id}\`. Query with SQL via dataframe_query.`,
        `_Preview favors rows with data: any leading all-null rows (e.g. past_days placeholders the models don't hindcast) are omitted here but staged in full chronological order on the canvas._`,
      );
    }

    if (result.hourly_units) lines.push(`\n**Hourly units:** ${formatUnits(result.hourly_units)}`);
    if (result.daily_units) lines.push(`**Daily units:** ${formatUnits(result.daily_units)}`);

    if (result.daily && result.daily.length > 0) {
      lines.push('', '### Daily ensemble summary (first 16)');
      for (const rec of result.daily.slice(0, 16)) lines.push(formatRecord(rec));
    }

    if (result.hourly && result.hourly.length > 0) {
      const shown = Math.min(result.hourly.length, 24);
      // When truncated, result.hourly is a preview slice — its length is NOT the
      // dataset size. Reference record_count (the full staged total).
      lines.push(
        '',
        result.truncated
          ? `### Hourly ensemble (preview — ${shown} shown of ${result.record_count} total rows on canvas)`
          : `### Hourly ensemble (first ${shown} of ${result.hourly.length})`,
      );
      for (const rec of result.hourly.slice(0, shown)) lines.push(formatRecord(rec));
      if (!result.truncated && result.hourly.length > shown) {
        lines.push(`_...and ${result.hourly.length - shown} more hourly records._`);
      }
    }

    lines.push('', '_Weather data by Open-Meteo.com_');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
