/**
 * @fileoverview Tool: openmeteo_get_climate — bias-corrected daily CMIP6 climate projections.
 * Covers 1950-01-01 to 2050-12-31 across up to seven high-resolution climate models.
 * Reshapes columnar response into per-date records. Multi-decade, multi-model pulls
 * spill to DataCanvas when canvas is enabled.
 * @module mcp-server/tools/definitions/get-climate
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';
import { toUnitsMap } from '@/services/open-meteo/types.js';
import { formatRecord, formatUnits, reshapeColumnar } from '../reshape-utils.js';
import { deriveSpillSchema, exceedsInlineBudget, PREVIEW_CHARS } from '../spill-utils.js';
import { frameInvalidVariableMessage } from '../upstream-error.js';

export const openmeteoGetClimateTool = tool('openmeteo_get_climate', {
  description:
    'Long-range climate projections from bias-corrected daily CMIP6 models, covering ' +
    '1950-01-01 to 2050-12-31 at any coordinate. Answers "what will conditions look like ' +
    'through 2050?" — the future-projection counterpart to openmeteo_get_historical (ERA5, ' +
    'what happened). Daily resolution only. Available models: "CMCC_CM2_VHR4", "FGOALS_f3_H", ' +
    '"HiRAM_SIT_HR", "MRI_AGCM3_2_S", "EC_Earth3P_HR", "MPI_ESM1_2_XR", "NICAM16_8S". ' +
    'With 2+ models each variable appears once per model with the model name as suffix ' +
    '(e.g. temperature_2m_max_CMCC_CM2_VHR4); a single or omitted model returns plain ' +
    'variable names. Not all models carry all variables — missing combinations return null. ' +
    'Multi-decade daily pulls across several models produce thousands of records and spill ' +
    'to DataCanvas for SQL querying when canvas is enabled.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'date_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'start_date predates 1950-01-01 or end_date is after 2050-12-31',
      recovery:
        'Use dates between 1950-01-01 and 2050-12-31 — the CMIP6 projection coverage. For observed history before 1950 limits, use openmeteo_get_historical (ERA5, from 1940).',
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
      recovery:
        'Check names against Open-Meteo Climate API docs. Common daily variables: temperature_2m_max, temperature_2m_min, temperature_2m_mean, precipitation_sum, rain_sum, snowfall_sum, wind_speed_10m_mean, wind_speed_10m_max, shortwave_radiation_sum, cloud_cover_mean. Valid models: CMCC_CM2_VHR4, FGOALS_f3_H, HiRAM_SIT_HR, MRI_AGCM3_2_S, EC_Earth3P_HR, MPI_ESM1_2_XR, NICAM16_8S.',
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
        'CMIP6 models to include: "CMCC_CM2_VHR4", "FGOALS_f3_H", "HiRAM_SIT_HR", "MRI_AGCM3_2_S", "EC_Earth3P_HR", "MPI_ESM1_2_XR", "NICAM16_8S". With 2+ models each variable column is suffixed with the model name (e.g. temperature_2m_max_MRI_AGCM3_2_S). Omit to use the API default (a single model, unsuffixed columns).',
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
        'DataCanvas token for multi-decade or multi-model queries. When a result is too large to return inline — driven by total payload size, so a wide multi-model pull can spill at any row count — it spills to this canvas for SQL querying. Omit to create a fresh canvas.',
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
    record_count: z.number().describe('Total number of daily records in this response'),
    daily: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Per-day records with "time" (YYYY-MM-DD) + one key per requested variable — per-model suffixed keys when 2+ models were requested (e.g. temperature_2m_max_CMCC_CM2_VHR4). Null values mean the model does not carry that variable. When truncated, contains only a preview; query canvas_id for the full dataset.',
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
        'DataCanvas token — present only when truncated is true (data spilled). Query with SQL using this token.',
      ),
    table_name: z
      .string()
      .optional()
      .describe(
        'DuckDB table name for the staged data — pass to openmeteo_dataframe_query. Present only when truncated is true.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when the response was too large to return inline and data spilled to canvas_id. Query the canvas for the full dataset.',
      ),
  }),

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
      if (reason.toLowerCase().includes('date') || reason.toLowerCase().includes('range')) {
        throw ctx.fail(
          'date_out_of_range',
          reason || 'Date out of CMIP6 projection range.',
          ctx.recoveryFor('date_out_of_range'),
        );
      }
      throw ctx.fail(
        'invalid_variable',
        frameInvalidVariableMessage(data.reason, 'variable or model'),
        ctx.recoveryFor('invalid_variable'),
      );
    }

    const dailyRecords = data.daily ? reshapeColumnar(data.daily) : [];
    const models = input.models && input.models.length > 0 ? input.models : undefined;
    const dateRange = {
      start: (dailyRecords[0]?.time as string) ?? input.start_date,
      end: (dailyRecords[dailyRecords.length - 1]?.time as string) ?? input.end_date,
    };

    // DataCanvas spillover for payloads too large to return inline
    if (exceedsInlineBudget(dailyRecords)) {
      const canvas = getCanvas();
      if (canvas) {
        const instance = await canvas.acquire(input.canvas_id, ctx);
        // Explicit schema over every staged row — a variable a model doesn't carry is
        // null for that model's whole column. See deriveSpillSchema.
        const spilled = await spillover({
          canvas: instance,
          source: dailyRecords,
          schema: deriveSpillSchema(dailyRecords),
          previewChars: PREVIEW_CHARS,
          signal: ctx.signal,
        });

        return {
          latitude: data.latitude,
          longitude: data.longitude,
          elevation: data.elevation,
          timezone: data.timezone,
          models,
          date_range: dateRange,
          record_count: spilled.spilled ? spilled.handle.rowCount : dailyRecords.length,
          daily: spilled.previewRows as Record<string, unknown>[],
          daily_units: toUnitsMap(data.daily_units as Record<string, unknown> | undefined),
          // Only point at the canvas when data actually spilled — spillover()
          // stages a table only past its byte threshold, so a canvas_id on the
          // non-spilled path would reference an empty canvas.
          canvas_id: spilled.spilled ? instance.canvasId : undefined,
          table_name: spilled.spilled ? spilled.handle.tableName : undefined,
          truncated: spilled.spilled,
        };
      }
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
      daily_units: toUnitsMap(data.daily_units as Record<string, unknown> | undefined),
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
      lines.push(
        `\n⚠️ Large result — full data staged on canvas \`${result.canvas_id}\`, table \`${result.table_name}\`. Query with SQL via openmeteo_dataframe_query.`,
      );
    }

    if (result.daily_units) lines.push(`\n**Daily units:** ${formatUnits(result.daily_units)}`);

    if (result.daily.length > 0) {
      // When truncated, result.daily is the spillover preview array — render all of
      // it so content[] matches structuredContent.daily; the heading references
      // record_count (the full staged total), not the preview length.
      lines.push(
        '',
        result.truncated
          ? `### Daily projections (preview — ${result.daily.length} shown of ${result.record_count} total rows on canvas)`
          : `### Daily projections (${result.daily.length} records)`,
      );
      for (const rec of result.daily) lines.push(formatRecord(rec));
    }

    lines.push('', '_Weather data by Open-Meteo.com_');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
