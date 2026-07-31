/**
 * @fileoverview Tests for openmeteo_get_marine tool.
 * @module tests/tools/get-marine.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoGetMarineTool } from '@/mcp-server/tools/definitions/get-marine.tool.js';
import { PREVIEW_CHARS } from '@/mcp-server/tools/spill-utils.js';

const mockGetMarine = vi.fn();
const mockSpillover = vi.fn();

vi.mock('@/services/open-meteo/open-meteo-service.js', () => ({
  getOpenMeteoService: () => ({ getMarine: mockGetMarine }),
}));

// Mock the canvas spillover helper — allows per-test control over spill behaviour.
// The real inferSchemaFromRows backs deriveSpillSchema, so the schema the handler
// hands to spillover() is genuinely derived, not stubbed.
vi.mock('@cyanheads/mcp-ts-core/canvas', async (importActual) => ({
  ...(await importActual<typeof import('@cyanheads/mcp-ts-core/canvas')>()),
  spillover: (...args: unknown[]) => mockSpillover(...args),
}));

// Canvas mock — returns undefined by default; individual tests can override
let mockCanvasInstance: unknown;

vi.mock('@/services/canvas-accessor.js', () => ({
  getCanvas: () => mockCanvasInstance,
}));

/** `count` consecutive hourly ISO timestamps from `from`. */
const hourlyTimes = (count: number, from = '2026-04-30T00:00'): string[] => {
  const start = new Date(`${from}:00Z`).getTime();
  return Array.from({ length: count }, (_, i) =>
    new Date(start + i * 3_600_000).toISOString().slice(0, 16),
  );
};

const MOCK_RESPONSE = {
  latitude: 47.8,
  longitude: -122.5,
  elevation: 0,
  utc_offset_seconds: -25200,
  timezone: 'America/Los_Angeles',
  timezone_abbreviation: 'GMT-7',
  generationtime_ms: 0.3,
  hourly_units: { time: 'iso8601', wave_height: 'm', wave_period: 's' },
  hourly: {
    time: ['2026-05-30T00:00', '2026-05-30T01:00'],
    wave_height: [0.5, 0.6],
    wave_period: [8.0, 8.5],
  },
};

describe('openmeteoGetMarineTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasInstance = undefined; // reset canvas to disabled state
    mockSpillover.mockResolvedValue({ spilled: false, previewRows: [] });
  });

  it('reshapes columnar marine response with exact per-timestamp alignment', async () => {
    mockGetMarine.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext();
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height', 'wave_period'],
    });
    const result = await openmeteoGetMarineTool.handler(input, ctx);

    expect(result.hourly).toHaveLength(2);
    expect(result.hourly![0]).toEqual({
      time: '2026-05-30T00:00',
      wave_height: 0.5,
      wave_period: 8.0,
    });
    expect(result.hourly![1]).toEqual({
      time: '2026-05-30T01:00',
      wave_height: 0.6,
      wave_period: 8.5,
    });
    expect(result.hourly_units).toMatchObject({ wave_height: 'm', wave_period: 's' });
    expect(result.record_count).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.canvas_id).toBeUndefined();
    expect(result.table_name).toBeUndefined();
  });

  it('preserves null values for ocean_current_velocity (non-open-ocean coordinates)', async () => {
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: { time: 'iso8601', wave_height: 'm', ocean_current_velocity: 'km/h' },
      hourly: {
        time: ['2026-05-30T00:00'],
        wave_height: [0.5],
        ocean_current_velocity: [null],
      },
    });
    const ctx = createMockContext();
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height', 'ocean_current_velocity'],
    });
    const result = await openmeteoGetMarineTool.handler(input, ctx);
    expect(result.hourly![0]?.ocean_current_velocity).toBeNull();
    expect(result.hourly![0]?.wave_height).toBe(0.5);
  });

  it('throws no_variables_requested with correct reason when none provided', async () => {
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
    });
    await expect(openmeteoGetMarineTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'no_variables_requested' },
    });
  });

  it('names a misplaced marine variable and its field in both directions (#26)', async () => {
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 54.5,
      longitude: 8.0,
      hourly_variables: ['wave_height', 'wave_height_max'],
      daily_variables: ['wave_height'],
    });

    await expect(openmeteoGetMarineTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining(
        'wave_height_max is not valid in hourly_variables — Open-Meteo publishes it as a daily variable.',
      ),
      data: { reason: 'variable_wrong_cadence' },
    });
    await expect(openmeteoGetMarineTool.handler(input, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('wave_height is not valid in daily_variables'),
    });
    expect(mockGetMarine).not.toHaveBeenCalled();
  });

  it('sends an unknown marine variable name upstream unrejected (#7)', async () => {
    mockGetMarine.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 54.5,
      longitude: 8.0,
      hourly_variables: ['wave_height', 'a_variable_open_meteo_added_later'],
    });

    await openmeteoGetMarineTool.handler(input, ctx);

    const callArgs = mockGetMarine.mock.calls[0]?.[2] as { hourly?: string[] };
    expect(callArgs?.hourly).toEqual(['wave_height', 'a_variable_open_meteo_added_later']);
  });

  it('notices an all-null column upstream reported with unit "undefined"', async () => {
    // The marine endpoint shares the forecast API's variable parser, so a weather or
    // air-quality name it does not serve comes back HTTP 200 with an all-null column
    // rather than an error — verified live with hourly=temperature_2m and hourly=pm2_5.
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: { time: 'iso8601', wave_height: 'm', temperature_2m: 'undefined' },
      hourly: {
        time: ['2026-05-30T00:00', '2026-05-30T01:00'],
        wave_height: [0.5, 0.6],
        temperature_2m: [null, null],
      },
    });
    const ctx = createMockContext();
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height', 'temperature_2m'],
    });

    await openmeteoGetMarineTool.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toContain('temperature_2m returned no data');
    expect(getEnrichment(ctx).notice).toContain('openmeteo_get_forecast');
  });

  it('stays quiet when every requested column carries a real unit', async () => {
    mockGetMarine.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext();
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height', 'wave_period'],
    });

    await openmeteoGetMarineTool.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('frames the upstream unknown-variable rejection with the offending name and recovery hint', async () => {
    // Real upstream reason shape from the live marine endpoint
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason:
        "Data corrupted at path ''. Cannot initialize SurfacePressureAndHeightVariable<VariableAndPreviousDay, VariableOrSpread<ForecastPressureVariable>, ForecastHeightVariable> from invalid String value bogus_wave.",
    });
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['bogus_wave'],
    });
    await expect(openmeteoGetMarineTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringMatching(/^Unknown variable name: bogus_wave\./),
      data: {
        reason: 'invalid_variable',
        recovery: { hint: expect.stringContaining('wave_height') },
      },
    });
  });

  it('reshapes daily marine variables when daily_variables provided', async () => {
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily_units: { time: 'iso8601', wave_height_max: 'm' },
      daily: {
        time: ['2026-05-30', '2026-05-31'],
        wave_height_max: [1.2, 0.9],
      },
    });
    const ctx = createMockContext();
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      daily_variables: ['wave_height_max'],
    });
    const result = await openmeteoGetMarineTool.handler(input, ctx);
    expect(result.daily).toHaveLength(2);
    expect(result.daily![0]).toEqual({ time: '2026-05-30', wave_height_max: 1.2 });
    expect(result.daily![1]).toEqual({ time: '2026-05-31', wave_height_max: 0.9 });
    expect(result.daily_units).toMatchObject({ wave_height_max: 'm' });
  });

  // --- Time window: forecast_days / past_days / date range -------------------

  it('accepts forecast_days up to 8 and rejects 9', () => {
    expect(() =>
      openmeteoGetMarineTool.input.parse({
        latitude: 47.8,
        longitude: -122.5,
        hourly_variables: ['wave_height'],
        forecast_days: 8,
      }),
    ).not.toThrow();
    expect(() =>
      openmeteoGetMarineTool.input.parse({
        latitude: 47.8,
        longitude: -122.5,
        hourly_variables: ['wave_height'],
        forecast_days: 9,
      }),
    ).toThrow();
  });

  it('forwards forecast_days and past_days as the forecast window', async () => {
    mockGetMarine.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext();
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height'],
      forecast_days: 8,
      past_days: 5,
    });
    await openmeteoGetMarineTool.handler(input, ctx);

    expect(mockGetMarine).toHaveBeenCalledWith(
      47.8,
      -122.5,
      expect.objectContaining({ forecast_days: 8, past_days: 5 }),
      ctx,
    );
  });

  it('forwards a date pair as the archive window and sends no forecast_days/past_days', async () => {
    // past_days: 0 is the schema default, and upstream rejects it alongside a date
    // range as a mutually exclusive parameter — so neither may ride along.
    mockGetMarine.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext();
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height'],
      start_date: '2024-07-01',
      end_date: '2024-07-02',
    });
    await openmeteoGetMarineTool.handler(input, ctx);

    const params = mockGetMarine.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(params).toMatchObject({ start_date: '2024-07-01', end_date: '2024-07-02' });
    expect(params).not.toHaveProperty('forecast_days');
    expect(params).not.toHaveProperty('past_days');
  });

  it.each([
    ['start_date only', { start_date: '2024-07-01' }, 'start_date'],
    ['end_date only', { end_date: '2024-07-02' }, 'end_date'],
  ])('throws date_range_incomplete with %s', async (_label, dates, named) => {
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height'],
      ...dates,
    });
    await expect(openmeteoGetMarineTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining(named),
      data: {
        reason: 'date_range_incomplete',
        recovery: { hint: expect.stringContaining('end_date') },
      },
    });
    expect(mockGetMarine).not.toHaveBeenCalled();
  });

  it.each([
    [
      'forecast_days + a paired range',
      { forecast_days: 7, start_date: '2024-07-01', end_date: '2024-07-02' },
    ],
    ['forecast_days + a lone start_date', { forecast_days: 7, start_date: '2024-07-01' }],
    [
      'past_days + a paired range',
      { past_days: 3, start_date: '2024-07-01', end_date: '2024-07-02' },
    ],
  ])('throws forecast_window_conflict for %s', async (_label, window) => {
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height'],
      ...window,
    });
    await expect(openmeteoGetMarineTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'forecast_window_conflict',
        recovery: { hint: expect.stringContaining('start_date') },
      },
    });
    expect(mockGetMarine).not.toHaveBeenCalled();
  });

  it('past_days at its 0 default does not conflict with a date range', async () => {
    mockGetMarine.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext();
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height'],
      start_date: '2024-07-01',
      end_date: '2024-07-02',
    });
    await expect(openmeteoGetMarineTool.handler(input, ctx)).resolves.toMatchObject({
      truncated: false,
    });
  });

  // --- DataCanvas spillover --------------------------------------------------

  it('spills to DataCanvas and sets truncated=true when the payload exceeds the inline budget', async () => {
    const rows = 2232; // past_days: 92 on the marine endpoint
    const time = hourlyTimes(rows);
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: {
        time,
        wave_height: time.map((_, i) => 1 + (i % 30) / 10),
        wave_period: time.map((_, i) => 8 + (i % 20) / 10),
      },
      daily_units: { time: 'iso8601', wave_height_max: 'm' },
      daily: { time: ['2026-04-30'], wave_height_max: [2.4] },
    });

    const previewRows = [
      { time: time[0], wave_height: 1, wave_period: 8 },
      { time: '2026-04-30', wave_height_max: 2.4 },
    ];
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: rows + 1, tableName: 'spilled_marine01' },
      previewRows,
    });

    const mockCanvas = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-marine-1' }) };
    mockCanvasInstance = mockCanvas;

    const ctx = createMockContext();
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height', 'wave_period'],
      daily_variables: ['wave_height_max'],
      past_days: 92,
    });
    const result = await openmeteoGetMarineTool.handler(input, ctx);

    expect(mockCanvas.acquire).toHaveBeenCalled();
    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBe('canvas-marine-1');
    expect(result.table_name).toBe('spilled_marine01');
    expect(result.record_count).toBe(rows + 1); // full staged total, not the preview length
    // Preview rows split back into their cadences by timestamp shape.
    expect(result.hourly).toEqual([previewRows[0]]);
    expect(result.daily).toEqual([previewRows[1]]);
  });

  it('passes the caller canvas_id through to acquire', async () => {
    const time = hourlyTimes(2232);
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: { time, wave_height: time.map((_, i) => 1 + (i % 30) / 10) },
    });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: time.length, tableName: 'spilled_reuse' },
      previewRows: [],
    });
    const acquire = vi.fn().mockResolvedValue({ canvasId: 'existingcv1' });
    mockCanvasInstance = { acquire };

    const ctx = createMockContext();
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height'],
      past_days: 92,
      canvas_id: 'existingcv1',
    });
    await openmeteoGetMarineTool.handler(input, ctx);
    expect(acquire).toHaveBeenCalledWith('existingcv1', ctx);
  });

  it('returns no canvas handles when spillover declines to stage a table', async () => {
    // The handler must never surface a canvas_id pointing at an empty canvas —
    // spilled.handle only exists on the spilled branch of the union.
    const time = hourlyTimes(2232);
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: { time, wave_height: time.map((_, i) => 1 + (i % 30) / 10) },
    });
    mockSpillover.mockResolvedValue({ spilled: false, previewRows: [] });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-unused' }) };

    const ctx = createMockContext();
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height'],
      past_days: 92,
    });
    const result = await openmeteoGetMarineTool.handler(input, ctx);

    expect(result.truncated).toBe(false);
    expect(result.canvas_id).toBeUndefined();
    expect(result.table_name).toBeUndefined();
    expect(result.record_count).toBe(time.length);
  });

  it('returns inline without touching a canvas when the payload fits', async () => {
    mockGetMarine.mockResolvedValue(MOCK_RESPONSE);
    const acquire = vi.fn();
    mockCanvasInstance = { acquire };

    const ctx = createMockContext();
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height'],
      forecast_days: 8,
    });
    const result = await openmeteoGetMarineTool.handler(input, ctx);

    expect(result.truncated).toBe(false);
    expect(result.record_count).toBe(2);
    // A result that fits must not mint a canvas — an acquired-but-unused canvas
    // holds a per-tenant slot the caller never learns about.
    expect(acquire).not.toHaveBeenCalled();
    expect(mockSpillover).not.toHaveBeenCalled();
  });

  it('bounds the preview and sets truncated=true when the payload is oversized and canvas is disabled', async () => {
    const time = hourlyTimes(2232);
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: {
        time,
        wave_height: time.map((_, i) => 1 + (i % 30) / 10),
        wave_period: time.map((_, i) => 8 + (i % 20) / 10),
      },
    });
    mockCanvasInstance = undefined; // CANVAS_PROVIDER_TYPE=none

    const ctx = createMockContext();
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height', 'wave_period'],
      past_days: 92,
    });
    const result = await openmeteoGetMarineTool.handler(input, ctx);

    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBeUndefined();
    expect(result.table_name).toBeUndefined();
    expect(mockSpillover).not.toHaveBeenCalled();
    expect(result.hourly!.length).toBeLessThan(time.length);
    expect(JSON.stringify(result.hourly).length).toBeLessThanOrEqual(PREVIEW_CHARS * 1.1);
    // record_count stays the full upstream total, not the preview length.
    expect(result.record_count).toBe(time.length);
  });

  it('carries daily rows in the canvas-less preview of a wide hourly window (#32)', async () => {
    // The live repro: past_days 92 + forecast_days 8 over nine hourly variables
    // serves 2,400 hourly and 100 daily rows. Hourly records lead the concatenated
    // set, so a single preview over it returns an empty daily summary.
    const time = hourlyTimes(2400);
    const dailyTime = Array.from(
      { length: 100 },
      (_, i) => `2026-0${Math.floor(i / 28) + 1}-${String((i % 28) + 1).padStart(2, '0')}`,
    );
    const hourlyBlock: Record<string, (number | null)[] | string[]> = { time };
    for (const variable of [
      'wave_height',
      'wave_direction',
      'wave_period',
      'wind_wave_height',
      'wind_wave_direction',
      'wind_wave_period',
      'swell_wave_height',
      'swell_wave_direction',
      'swell_wave_period',
    ]) {
      hourlyBlock[variable] = time.map((_, i) => 1 + (i % 30) / 10);
    }
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: hourlyBlock,
      daily_units: { time: 'iso8601', wave_height_max: 'm', wave_period_max: 's' },
      daily: {
        time: dailyTime,
        wave_height_max: dailyTime.map((_, i) => 2 + (i % 15) / 10),
        wave_direction_dominant: dailyTime.map((_, i) => 90 + (i % 40)),
        wave_period_max: dailyTime.map((_, i) => 9 + (i % 6)),
      },
    });
    mockCanvasInstance = undefined; // CANVAS_PROVIDER_TYPE=none

    const ctx = createMockContext();
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 36.8,
      longitude: -75.0,
      hourly_variables: ['wave_height', 'wave_direction', 'wave_period'],
      daily_variables: ['wave_height_max', 'wave_direction_dominant', 'wave_period_max'],
      past_days: 92,
      forecast_days: 8,
    });
    const result = await openmeteoGetMarineTool.handler(input, ctx);

    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBeUndefined();
    expect(result.daily).toHaveLength(dailyTime.length);
    expect(result.daily?.[0]).toMatchObject({ time: dailyTime[0], wave_height_max: 2 });
    expect(result.hourly?.length ?? 0).toBeGreaterThan(0);
    expect(
      JSON.stringify(result.hourly ?? []).length + JSON.stringify(result.daily ?? []).length,
    ).toBeLessThanOrEqual(PREVIEW_CHARS * 1.1);
    expect(result.record_count).toBe(time.length + dailyTime.length);

    // format() renders the daily section the empty array used to gate away.
    const text = openmeteoGetMarineTool.format!(result)[0]?.text ?? '';
    expect(text).toContain('### Daily marine summary (preview —');
    expect(text).toContain(`of ${time.length + dailyTime.length} total rows`);
  });

  // --- format() --------------------------------------------------------------

  it('formats output with attribution', () => {
    const blocks = openmeteoGetMarineTool.format!({
      latitude: 47.8,
      longitude: -122.5,
      timezone: 'America/Los_Angeles',
      record_count: 1,
      hourly: [{ time: '2026-05-30T00:00', wave_height: 0.5 }],
      hourly_units: { wave_height: 'm' },
      canvas_id: undefined,
      table_name: undefined,
      truncated: false,
    });
    expect(blocks[0]?.text).toContain('Marine');
    expect(blocks[0]?.text).toContain('Open-Meteo.com');
  });

  it('formats truncated result with the canvas and table handles', () => {
    const text =
      openmeteoGetMarineTool.format!({
        latitude: 47.8,
        longitude: -122.5,
        timezone: 'America/Los_Angeles',
        record_count: 2232,
        hourly: [{ time: '2026-04-30T00:00', wave_height: 1 }],
        hourly_units: { wave_height: 'm' },
        canvas_id: 'canvas-marine-1',
        table_name: 'spilled_marine01',
        truncated: true,
      })[0]?.text ?? '';
    expect(text).toContain('canvas-marine-1');
    expect(text).toContain('spilled_marine01');
    expect(text).toContain('1 shown of 2232 total rows on canvas');
  });

  it('names the disabled canvas and the narrowing levers in the truncated no-canvas format()', () => {
    const text =
      openmeteoGetMarineTool.format!({
        latitude: 47.8,
        longitude: -122.5,
        timezone: 'America/Los_Angeles',
        record_count: 2232,
        hourly: [{ time: '2026-04-30T00:00', wave_height: 1 }],
        hourly_units: { wave_height: 'm' },
        canvas_id: undefined,
        table_name: undefined,
        truncated: true,
      })[0]?.text ?? '';
    expect(text).toContain('CANVAS_PROVIDER_TYPE=none');
    expect(text).toContain('CANVAS_PROVIDER_TYPE=duckdb');
    expect(text).toContain('past_days');
    expect(text).toContain('start_date–end_date');
    // Heading reports the upstream total and does not claim a canvas holds it.
    expect(text).toContain('1 shown of 2232 total rows)');
    expect(text).not.toContain('total rows on canvas');
  });

  it('renders every hourly row in content[] with no cap or "…and N more" (format parity)', () => {
    // 50 rows is above the former 48-row render cap.
    const hourly = Array.from({ length: 50 }, (_, i) => ({
      time: `2026-05-30T00:00+${i}`,
      wave_height: 1000 + i,
    }));
    const text =
      openmeteoGetMarineTool.format!({
        latitude: 47.8,
        longitude: -122.5,
        timezone: 'America/Los_Angeles',
        record_count: 50,
        hourly,
        hourly_units: { wave_height: 'm' },
        canvas_id: undefined,
        table_name: undefined,
        truncated: false,
      })[0]?.text ?? '';
    expect(text).toContain('### Hourly marine (50 records)');
    expect(text).toContain('wave_height: 1000');
    expect(text).toContain('wave_height: 1049'); // last row — not sliced at 48
    expect(text).not.toMatch(/and \d+ more/);
  });
});
