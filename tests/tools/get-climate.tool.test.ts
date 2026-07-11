/**
 * @fileoverview Tests for openmeteo_get_climate tool.
 * @module tests/tools/get-climate.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoGetClimateTool } from '@/mcp-server/tools/definitions/get-climate.tool.js';

const mockGetClimate = vi.fn();
const mockSpillover = vi.fn();

vi.mock('@/services/open-meteo/open-meteo-service.js', () => ({
  getOpenMeteoService: () => ({ getClimate: mockGetClimate }),
}));

// Mock the canvas spillover helper — allows per-test control over spill behaviour
vi.mock('@cyanheads/mcp-ts-core/canvas', () => ({
  spillover: (...args: unknown[]) => mockSpillover(...args),
}));

// Canvas mock — returns undefined by default; individual tests can override
let mockCanvasInstance: unknown;

vi.mock('@/services/canvas-accessor.js', () => ({
  getCanvas: () => mockCanvasInstance,
}));

/**
 * Live multi-model response shape (2049-01-01…05, models=CMCC_CM2_VHR4,MRI_AGCM3_2_S,
 * daily=temperature_2m_max): each variable appears once per model with the model
 * name as column suffix, in both the daily block and daily_units.
 */
const MOCK_MULTI_MODEL_RESPONSE = {
  latitude: 47.600006,
  longitude: -122.3,
  generationtime_ms: 148.4,
  utc_offset_seconds: 0,
  timezone: 'GMT',
  timezone_abbreviation: 'GMT',
  elevation: 17.0,
  daily_units: {
    time: 'iso8601',
    temperature_2m_max_CMCC_CM2_VHR4: '°C',
    temperature_2m_max_MRI_AGCM3_2_S: '°C',
  },
  daily: {
    time: ['2049-01-01', '2049-01-02', '2049-01-03', '2049-01-04', '2049-01-05'],
    temperature_2m_max_CMCC_CM2_VHR4: [10.1, 8.9, 14.1, 14.5, 10.2],
    temperature_2m_max_MRI_AGCM3_2_S: [5.3, 10.8, 11.1, 13.7, 14.8],
  },
};

/**
 * Live single-model response shape: no model suffix on columns. Includes a
 * sparse column — CMCC_CM2_VHR4 does not carry shortwave_radiation_sum, so
 * upstream returns null for every entry.
 */
const MOCK_SINGLE_MODEL_RESPONSE = {
  latitude: 47.600006,
  longitude: -122.3,
  generationtime_ms: 340.8,
  utc_offset_seconds: 0,
  timezone: 'GMT',
  timezone_abbreviation: 'GMT',
  elevation: 17.0,
  daily_units: {
    time: 'iso8601',
    temperature_2m_max: '°C',
    precipitation_sum: 'mm',
    shortwave_radiation_sum: 'MJ/m²',
  },
  daily: {
    time: ['2049-01-01', '2049-01-02'],
    temperature_2m_max: [10.1, 8.9],
    precipitation_sum: [18.63, 6.56],
    shortwave_radiation_sum: [null, null],
  },
};

describe('openmeteoGetClimateTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasInstance = undefined; // reset canvas to disabled state
    // Default spillover mock: fit result (no spill) — overridden per test
    mockSpillover.mockResolvedValue({
      spilled: false,
      previewRows: [],
    });
  });

  it('reshapes multi-model data into per-date records with per-model suffixed columns', async () => {
    mockGetClimate.mockResolvedValue(MOCK_MULTI_MODEL_RESPONSE);
    const ctx = createMockContext();
    const input = openmeteoGetClimateTool.input.parse({
      latitude: 47.6,
      longitude: -122.33,
      start_date: '2049-01-01',
      end_date: '2049-01-05',
      daily_variables: ['temperature_2m_max'],
      models: ['CMCC_CM2_VHR4', 'MRI_AGCM3_2_S'],
    });
    const result = await openmeteoGetClimateTool.handler(input, ctx);

    expect(result.daily).toHaveLength(5);
    // Exact position check — one column per model at each date
    expect(result.daily[0]).toEqual({
      time: '2049-01-01',
      temperature_2m_max_CMCC_CM2_VHR4: 10.1,
      temperature_2m_max_MRI_AGCM3_2_S: 5.3,
    });
    expect(result.daily[4]).toEqual({
      time: '2049-01-05',
      temperature_2m_max_CMCC_CM2_VHR4: 10.2,
      temperature_2m_max_MRI_AGCM3_2_S: 14.8,
    });
    expect(result.models).toEqual(['CMCC_CM2_VHR4', 'MRI_AGCM3_2_S']);
    expect(result.daily_units).toEqual({
      time: 'iso8601',
      temperature_2m_max_CMCC_CM2_VHR4: '°C',
      temperature_2m_max_MRI_AGCM3_2_S: '°C',
    });
    expect(result.date_range).toEqual({ start: '2049-01-01', end: '2049-01-05' });
    expect(result.record_count).toBe(5);
    expect(result.truncated).toBe(false);
    expect(result.canvas_id).toBeUndefined();
  });

  it('returns unsuffixed columns and preserves upstream nulls for a single model', async () => {
    mockGetClimate.mockResolvedValue(MOCK_SINGLE_MODEL_RESPONSE);
    const ctx = createMockContext();
    const input = openmeteoGetClimateTool.input.parse({
      latitude: 47.6,
      longitude: -122.33,
      start_date: '2049-01-01',
      end_date: '2049-01-02',
      daily_variables: ['temperature_2m_max', 'precipitation_sum', 'shortwave_radiation_sum'],
      models: ['CMCC_CM2_VHR4'],
    });
    const result = await openmeteoGetClimateTool.handler(input, ctx);

    expect(result.daily[0]).toEqual({
      time: '2049-01-01',
      temperature_2m_max: 10.1,
      precipitation_sum: 18.63,
      shortwave_radiation_sum: null, // model does not carry this variable — stays null
    });
    expect(result.models).toEqual(['CMCC_CM2_VHR4']);
  });

  it('omits models from output when models was not requested', async () => {
    mockGetClimate.mockResolvedValue(MOCK_SINGLE_MODEL_RESPONSE);
    const ctx = createMockContext();
    const input = openmeteoGetClimateTool.input.parse({
      latitude: 47.6,
      longitude: -122.33,
      start_date: '2049-01-01',
      end_date: '2049-01-02',
      daily_variables: ['temperature_2m_max'],
    });
    const result = await openmeteoGetClimateTool.handler(input, ctx);
    expect(result.models).toBeUndefined();
  });

  it('throws date_order_invalid with correct reason when end before start', async () => {
    const ctx = createMockContext({ errors: openmeteoGetClimateTool.errors });
    const input = openmeteoGetClimateTool.input.parse({
      latitude: 47.6,
      longitude: -122.33,
      start_date: '2049-06-01',
      end_date: '2049-01-01',
      daily_variables: ['temperature_2m_max'],
    });
    await expect(openmeteoGetClimateTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'date_order_invalid' },
    });
  });

  it('throws date_out_of_range with correct reason when start_date before 1950', async () => {
    const ctx = createMockContext({ errors: openmeteoGetClimateTool.errors });
    const input = openmeteoGetClimateTool.input.parse({
      latitude: 47.6,
      longitude: -122.33,
      start_date: '1949-12-31',
      end_date: '1950-01-05',
      daily_variables: ['temperature_2m_max'],
    });
    await expect(openmeteoGetClimateTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'date_out_of_range',
        recovery: { hint: expect.stringContaining('1950-01-01') },
      },
    });
  });

  it('throws date_out_of_range with correct reason when end_date after 2050', async () => {
    const ctx = createMockContext({ errors: openmeteoGetClimateTool.errors });
    const input = openmeteoGetClimateTool.input.parse({
      latitude: 47.6,
      longitude: -122.33,
      start_date: '2050-12-01',
      end_date: '2051-01-01',
      daily_variables: ['temperature_2m_max'],
    });
    await expect(openmeteoGetClimateTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'date_out_of_range' },
    });
  });

  it('throws no_variables_requested (reason + recovery hint) when daily_variables is empty', async () => {
    const ctx = createMockContext({ errors: openmeteoGetClimateTool.errors });
    // Schema now accepts [] (optional, .min(1) dropped), so the input parses and the
    // declared recovery fires instead of a generic Zod rejection — no bypass needed.
    const input = openmeteoGetClimateTool.input.parse({
      latitude: 47.6,
      longitude: -122.33,
      start_date: '2049-01-01',
      end_date: '2049-01-02',
      daily_variables: [],
    });
    await expect(openmeteoGetClimateTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'no_variables_requested',
        recovery: { hint: expect.stringContaining('daily_variables') },
      },
    });
  });

  it('throws no_variables_requested when daily_variables is omitted entirely', async () => {
    const ctx = createMockContext({ errors: openmeteoGetClimateTool.errors });
    const input = openmeteoGetClimateTool.input.parse({
      latitude: 47.6,
      longitude: -122.33,
      start_date: '2049-01-01',
      end_date: '2049-01-02',
    });
    await expect(openmeteoGetClimateTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'no_variables_requested' },
    });
  });

  it('throws invalid_variable with framed message when API rejects an unknown model', async () => {
    // Real upstream reason shape from the live climate endpoint for models=BOGUS_MODEL.
    mockGetClimate.mockResolvedValue({
      ...MOCK_MULTI_MODEL_RESPONSE,
      error: true,
      reason:
        "Data corrupted at path ''. Cannot initialize MultiDomains from invalid String value BOGUS_MODEL.",
    });
    const ctx = createMockContext({ errors: openmeteoGetClimateTool.errors });
    const input = openmeteoGetClimateTool.input.parse({
      latitude: 47.6,
      longitude: -122.33,
      start_date: '2049-01-01',
      end_date: '2049-01-02',
      daily_variables: ['temperature_2m_max'],
      models: ['BOGUS_MODEL'],
    });
    await expect(openmeteoGetClimateTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringMatching(/^Unknown variable or model name: BOGUS_MODEL\./),
      data: {
        reason: 'invalid_variable',
        recovery: { hint: expect.stringContaining('CMCC_CM2_VHR4') },
      },
    });
  });

  it('throws invalid_variable with framed message when API rejects an unknown variable', async () => {
    // Real upstream reason shape from the live climate endpoint for daily=bogus_var.
    mockGetClimate.mockResolvedValue({
      ...MOCK_MULTI_MODEL_RESPONSE,
      error: true,
      reason:
        "Data corrupted at path ''. Cannot initialize ForecastVariableDaily from invalid String value bogus_var.",
    });
    const ctx = createMockContext({ errors: openmeteoGetClimateTool.errors });
    const input = openmeteoGetClimateTool.input.parse({
      latitude: 47.6,
      longitude: -122.33,
      start_date: '2049-01-01',
      end_date: '2049-01-02',
      daily_variables: ['bogus_var'],
    });
    await expect(openmeteoGetClimateTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringMatching(/^Unknown variable or model name: bogus_var\./),
      data: { reason: 'invalid_variable' },
    });
  });

  it('throws date_out_of_range when API returns the "Invalid date" error envelope', async () => {
    // Real upstream reason for dates past 2050-12-31.
    mockGetClimate.mockResolvedValue({
      ...MOCK_MULTI_MODEL_RESPONSE,
      error: true,
      reason: 'Invalid date',
    });
    const ctx = createMockContext({ errors: openmeteoGetClimateTool.errors });
    const input = openmeteoGetClimateTool.input.parse({
      latitude: 47.6,
      longitude: -122.33,
      start_date: '2049-01-01',
      end_date: '2049-01-02',
      daily_variables: ['temperature_2m_max'],
    });
    await expect(openmeteoGetClimateTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'date_out_of_range' },
    });
  });

  it('throws date_out_of_range when API error reason contains "range"', async () => {
    // Real upstream reason for start_date before 1950-01-01.
    mockGetClimate.mockResolvedValue({
      ...MOCK_MULTI_MODEL_RESPONSE,
      error: true,
      reason: "Parameter 'start_date' is out of allowed range from 1950-01-01 to 2050-12-31",
    });
    const ctx = createMockContext({ errors: openmeteoGetClimateTool.errors });
    const input = openmeteoGetClimateTool.input.parse({
      latitude: 47.6,
      longitude: -122.33,
      start_date: '2049-01-01',
      end_date: '2049-01-02',
      daily_variables: ['temperature_2m_max'],
    });
    await expect(openmeteoGetClimateTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'date_out_of_range' },
    });
  });

  it('spills to DataCanvas and sets truncated=true when records exceed INLINE_LIMIT', async () => {
    // Build a response with 502 daily records (> INLINE_LIMIT of 500)
    const days = 502;
    const time = Array.from({ length: days }, (_, i) => {
      const d = new Date('2049-01-01');
      d.setDate(d.getDate() + i);
      return d.toISOString().slice(0, 10);
    });
    const temperature_2m_max_CMCC_CM2_VHR4 = Array.from({ length: days }, (_, i) => 10 + (i % 20));
    const temperature_2m_max_MRI_AGCM3_2_S = Array.from({ length: days }, (_, i) => 8 + (i % 20));

    mockGetClimate.mockResolvedValue({
      ...MOCK_MULTI_MODEL_RESPONSE,
      daily: { time, temperature_2m_max_CMCC_CM2_VHR4, temperature_2m_max_MRI_AGCM3_2_S },
    });

    // Configure spillover mock to simulate a successful spill
    const previewRows = time.slice(0, 5).map((t, i) => ({
      time: t,
      temperature_2m_max_CMCC_CM2_VHR4: 10 + i,
      temperature_2m_max_MRI_AGCM3_2_S: 8 + i,
    }));
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: days, tableName: 'spilled_abc123' },
      previewRows,
    });

    // Enable canvas
    const mockInstance = { canvasId: 'canvas-test-123' };
    const mockCanvas = { acquire: vi.fn().mockResolvedValue(mockInstance) };
    mockCanvasInstance = mockCanvas;

    const ctx = createMockContext();
    const input = openmeteoGetClimateTool.input.parse({
      latitude: 47.6,
      longitude: -122.33,
      start_date: '2049-01-01',
      end_date: '2050-05-17',
      daily_variables: ['temperature_2m_max'],
      models: ['CMCC_CM2_VHR4', 'MRI_AGCM3_2_S'],
    });

    const result = await openmeteoGetClimateTool.handler(input, ctx);

    expect(mockCanvas.acquire).toHaveBeenCalled();
    expect(mockSpillover).toHaveBeenCalled();
    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBe('canvas-test-123');
    expect(result.record_count).toBe(days);
    expect(result.daily).toEqual(previewRows);
    expect(result.table_name).toBe('spilled_abc123'); // #18: exact staged table name surfaced
  });

  it('omits canvas_id when records exceed INLINE_LIMIT but spillover stays under its byte threshold', async () => {
    // Regression parity with get-historical: 500–~2000 records trigger the spillover
    // path but can stay under the ~80 KB preview threshold, so nothing is staged
    // (spilled: false). The handler must not return a canvas_id pointing at an
    // empty canvas.
    const days = 502;
    const time = Array.from({ length: days }, (_, i) => {
      const d = new Date('2049-01-01');
      d.setDate(d.getDate() + i);
      return d.toISOString().slice(0, 10);
    });
    const temperature_2m_max = Array.from({ length: days }, (_, i) => 10 + (i % 20));

    mockGetClimate.mockResolvedValue({
      ...MOCK_MULTI_MODEL_RESPONSE,
      daily_units: { time: 'iso8601', temperature_2m_max: '°C' },
      daily: { time, temperature_2m_max },
    });

    // Everything fit inline — previewRows carry the full dataset, no table staged
    mockSpillover.mockResolvedValue({
      spilled: false,
      previewRows: time.map((t, i) => ({ time: t, temperature_2m_max: 10 + (i % 20) })),
    });

    const mockInstance = { canvasId: 'canvas-unused-1' };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext();
    const input = openmeteoGetClimateTool.input.parse({
      latitude: 47.6,
      longitude: -122.33,
      start_date: '2049-01-01',
      end_date: '2050-05-17',
      daily_variables: ['temperature_2m_max'],
    });

    const result = await openmeteoGetClimateTool.handler(input, ctx);
    expect(result.truncated).toBe(false);
    expect(result.canvas_id).toBeUndefined();
    expect(result.record_count).toBe(days);
    expect(result.daily).toHaveLength(days);
    expect(result.table_name).toBeUndefined(); // #18: no table name when spillover did not spill
  });

  it('formats output with models line and attribution', () => {
    const blocks = openmeteoGetClimateTool.format!({
      latitude: 47.6,
      longitude: -122.3,
      elevation: 17,
      timezone: 'GMT',
      models: ['CMCC_CM2_VHR4', 'MRI_AGCM3_2_S'],
      date_range: { start: '2049-01-01', end: '2049-01-05' },
      record_count: 5,
      daily: [
        {
          time: '2049-01-01',
          temperature_2m_max_CMCC_CM2_VHR4: 10.1,
          temperature_2m_max_MRI_AGCM3_2_S: 5.3,
        },
      ],
      daily_units: { temperature_2m_max_CMCC_CM2_VHR4: '°C' },
      canvas_id: undefined,
      truncated: false,
    });
    expect(blocks[0]?.text).toContain('CMIP6');
    expect(blocks[0]?.text).toContain('CMCC_CM2_VHR4, MRI_AGCM3_2_S');
    expect(blocks[0]?.text).toContain('Open-Meteo.com');
  });

  it('formats truncated result with canvas_id notice and default-model label', () => {
    const blocks = openmeteoGetClimateTool.format!({
      latitude: 47.6,
      longitude: -122.3,
      elevation: 17,
      timezone: 'GMT',
      models: undefined,
      date_range: { start: '2020-01-01', end: '2050-12-31' },
      record_count: 11322,
      daily: [{ time: '2020-01-01', temperature_2m_max: 5.0 }],
      daily_units: { temperature_2m_max: '°C' },
      canvas_id: 'canvas-xyz-789',
      table_name: 'spilled_clim789',
      truncated: true,
    });
    expect(blocks[0]?.text).toContain('canvas-xyz-789');
    expect(blocks[0]?.text).toContain('spilled_clim789'); // #18: table name named in the hint
    expect(blocks[0]?.text).toContain('API default');
    // Format uses bold label: **Truncated:** true
    expect(blocks[0]?.text).toContain('Truncated:');
    expect(blocks[0]?.text).toContain('true');
    // #13: the truncated heading reports record_count (11322), not the 1-row preview
    // length — text-only clients must not read the preview size as the dataset total.
    expect(blocks[0]?.text).toContain('1 shown of 11322 total');
    expect(blocks[0]?.text).not.toMatch(/### Daily projections \(first \d+ of 1\)/);
  });

  it('renders every daily row in content[] with no cap or "…and N more" (format parity)', () => {
    // 35 rows is above the former 30-row render cap.
    const daily = Array.from({ length: 35 }, (_, i) => ({
      time: `2049-01-${String(i + 1).padStart(2, '0')}`,
      temperature_2m_max: 1000 + i,
    }));
    const text =
      openmeteoGetClimateTool.format!({
        latitude: 47.6,
        longitude: -122.3,
        elevation: 17,
        timezone: 'GMT',
        models: undefined,
        date_range: { start: '2049-01-01', end: '2049-02-04' },
        record_count: 35,
        daily,
        daily_units: { temperature_2m_max: '°C' },
        canvas_id: undefined,
        table_name: undefined,
        truncated: false,
      })[0]?.text ?? '';
    expect(text).toContain('### Daily projections (35 records)');
    expect(text).toContain('temperature_2m_max: 1000');
    expect(text).toContain('temperature_2m_max: 1034'); // last row — not sliced at 30
    expect(text).not.toMatch(/and \d+ more/);
  });
});
