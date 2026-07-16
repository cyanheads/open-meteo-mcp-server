/**
 * @fileoverview Tests for openmeteo_get_historical tool.
 * @module tests/tools/get-historical.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoGetHistoricalTool } from '@/mcp-server/tools/definitions/get-historical.tool.js';

const mockGetHistorical = vi.fn();
const mockSpillover = vi.fn();

vi.mock('@/services/open-meteo/open-meteo-service.js', () => ({
  getOpenMeteoService: () => ({ getHistorical: mockGetHistorical }),
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

/** The schema the handler handed to spillover(). */
const spilledSchema = (): { name: string; type: string }[] => {
  const [opts] = mockSpillover.mock.calls[0] as [{ schema?: { name: string; type: string }[] }];
  return opts.schema ?? [];
};

const spilledSchemaType = (name: string) => spilledSchema().find((c) => c.name === name)?.type;

/** `count` consecutive ISO dates from `from`. */
const dailyDates = (count: number, from = '2022-01-01'): string[] =>
  Array.from({ length: count }, (_, i) => {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    return d.toISOString().slice(0, 10);
  });

/** `count` consecutive hourly ISO timestamps from `from`. */
const hourlyTimes = (count: number, from = '2023-01-01T00:00'): string[] =>
  Array.from({ length: count }, (_, i) => {
    const d = new Date(from);
    d.setHours(d.getHours() + i);
    return d.toISOString().slice(0, 16);
  });

vi.mock('@/services/canvas-accessor.js', () => ({
  getCanvas: () => mockCanvasInstance,
}));

const MOCK_RESPONSE = {
  latitude: 47.595562,
  longitude: -122.32443,
  elevation: 59.0,
  utc_offset_seconds: -25200,
  timezone: 'America/Los_Angeles',
  timezone_abbreviation: 'GMT-7',
  generationtime_ms: 1.2,
  daily_units: { time: 'iso8601', temperature_2m_max: '°C', precipitation_sum: 'mm' },
  daily: {
    time: ['2024-07-01', '2024-07-02'],
    temperature_2m_max: [22.5, 20.1],
    precipitation_sum: [0.0, 1.2],
  },
};

describe('openmeteoGetHistoricalTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasInstance = undefined; // reset canvas to disabled state
    // Default spillover mock: fit result (no spill) — overridden per test
    mockSpillover.mockResolvedValue({
      spilled: false,
      previewRows: [],
    });
  });

  it('reshapes daily ERA5 data into per-date records with exact values', async () => {
    mockGetHistorical.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext();
    const input = openmeteoGetHistoricalTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      start_date: '2024-07-01',
      end_date: '2024-07-02',
      daily_variables: ['temperature_2m_max', 'precipitation_sum'],
    });
    const result = await openmeteoGetHistoricalTool.handler(input, ctx);

    expect(result.daily).toHaveLength(2);
    // Exact position check — both variables at each date
    expect(result.daily![0]).toEqual({
      time: '2024-07-01',
      temperature_2m_max: 22.5,
      precipitation_sum: 0.0,
    });
    expect(result.daily![1]).toEqual({
      time: '2024-07-02',
      temperature_2m_max: 20.1,
      precipitation_sum: 1.2,
    });
    expect(result.truncated).toBe(false);
    expect(result.record_count).toBe(2);
  });

  it('throws no_variables_requested with correct reason when none provided', async () => {
    const ctx = createMockContext({ errors: openmeteoGetHistoricalTool.errors });
    const input = openmeteoGetHistoricalTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      start_date: '2024-07-01',
      end_date: '2024-07-02',
    });
    await expect(openmeteoGetHistoricalTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'no_variables_requested' },
    });
  });

  it('throws date_order_invalid with correct reason when end before start', async () => {
    const ctx = createMockContext({ errors: openmeteoGetHistoricalTool.errors });
    const input = openmeteoGetHistoricalTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      start_date: '2024-07-10',
      end_date: '2024-07-01',
      daily_variables: ['temperature_2m_max'],
    });
    await expect(openmeteoGetHistoricalTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'date_order_invalid' },
    });
  });

  it('throws date_out_of_range with correct reason when start_date before 1940', async () => {
    const ctx = createMockContext({ errors: openmeteoGetHistoricalTool.errors });
    const input = openmeteoGetHistoricalTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      start_date: '1900-01-01',
      end_date: '1900-12-31',
      daily_variables: ['temperature_2m_max'],
    });
    await expect(openmeteoGetHistoricalTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'date_out_of_range',
        recovery: { hint: expect.stringContaining('past_days') },
      },
    });
  });

  it('throws date_out_of_range when API returns error envelope with date-related reason', async () => {
    mockGetHistorical.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason: 'start_date is out of allowed date range.',
    });
    const ctx = createMockContext({ errors: openmeteoGetHistoricalTool.errors });
    const input = openmeteoGetHistoricalTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      start_date: '2024-07-01',
      end_date: '2024-07-02',
      daily_variables: ['temperature_2m_max'],
    });
    await expect(openmeteoGetHistoricalTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'date_out_of_range' },
    });
  });

  it('throws invalid_variable (not date_out_of_range) when API error envelope has non-date reason', async () => {
    // Regression: the handler catch-all previously mapped ALL API errors to date_out_of_range,
    // including invalid variable names. Non-date errors must produce invalid_variable.
    // Real upstream reason shape from the live archive endpoint (Swift type-init jargon).
    const upstreamReason =
      "Data corrupted at path ''. Cannot initialize SurfacePressureAndHeightVariable<VariableAndPreviousDay, VariableOrSpread<ForecastPressureVariable>, ForecastHeightVariable> from invalid String value bogus_historical_var.";
    mockGetHistorical.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason: upstreamReason,
    });
    const ctx = createMockContext({ errors: openmeteoGetHistoricalTool.errors });
    const input = openmeteoGetHistoricalTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      start_date: '2024-07-01',
      end_date: '2024-07-02',
      hourly_variables: ['bogus_historical_var'],
    });
    await expect(openmeteoGetHistoricalTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringMatching(/^Unknown variable name: bogus_historical_var\./),
      data: {
        reason: 'invalid_variable',
        recovery: { hint: expect.stringContaining('Open-Meteo docs') },
      },
    });
  });

  it('throws date_out_of_range when API error reason contains "range"', async () => {
    // Verifies the "range" keyword path is also classified correctly.
    mockGetHistorical.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason: 'Parameter start_date is out of allowed range from 1940-01-01 to 2026-05-30.',
    });
    const ctx = createMockContext({ errors: openmeteoGetHistoricalTool.errors });
    const input = openmeteoGetHistoricalTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      start_date: '2024-07-01',
      end_date: '2024-07-02',
      daily_variables: ['temperature_2m_max'],
    });
    await expect(openmeteoGetHistoricalTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'date_out_of_range' },
    });
  });

  it('spills to DataCanvas and sets truncated=true when the payload exceeds the inline budget', async () => {
    const days = 2000;
    const time = dailyDates(days);
    const temperature_2m_max = Array.from({ length: days }, (_, i) => 10 + (i % 20) + 0.5);

    mockGetHistorical.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily_units: { time: 'iso8601', temperature_2m_max: '°C' },
      daily: { time, temperature_2m_max },
    });

    // Configure spillover mock to simulate a successful spill
    const previewRows = time.slice(0, 5).map((t, i) => ({ time: t, temperature_2m_max: 10 + i }));
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
    const input = openmeteoGetHistoricalTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      start_date: '2022-01-01',
      end_date: '2023-05-17',
      daily_variables: ['temperature_2m_max'],
    });

    const result = await openmeteoGetHistoricalTool.handler(input, ctx);

    expect(mockCanvas.acquire).toHaveBeenCalled();
    expect(mockSpillover).toHaveBeenCalled();
    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBe('canvas-test-123');
    expect(result.record_count).toBe(days);
    expect(result.table_name).toBe('spilled_abc123'); // #18: exact staged table name surfaced
  });

  it('returns no canvas handles when spillover declines to stage a table', async () => {
    // The handler must never surface a canvas_id pointing at an empty canvas —
    // spilled.handle only exists on the spilled branch of the union.
    const days = 2000;
    const time = dailyDates(days);
    const temperature_2m_max = Array.from({ length: days }, (_, i) => 10 + (i % 20) + 0.5);

    mockGetHistorical.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily_units: { time: 'iso8601', temperature_2m_max: '°C' },
      daily: { time, temperature_2m_max },
    });

    mockSpillover.mockResolvedValue({
      spilled: false,
      previewRows: time.map((t, i) => ({ time: t, temperature_2m_max: 10 + (i % 20) + 0.5 })),
    });

    const mockInstance = { canvasId: 'canvas-unused-1' };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext();
    const input = openmeteoGetHistoricalTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      start_date: '2022-01-01',
      end_date: '2027-06-23',
      daily_variables: ['temperature_2m_max'],
    });

    const result = await openmeteoGetHistoricalTool.handler(input, ctx);
    expect(result.truncated).toBe(false);
    expect(result.canvas_id).toBeUndefined();
    expect(result.record_count).toBe(days);
    expect(result.daily).toHaveLength(days);
    expect(result.table_name).toBeUndefined(); // #18: no table name when spillover did not spill
  });

  it('returns inline without touching a canvas when the payload fits', async () => {
    const days = 500;
    const time = dailyDates(days, '2023-01-01');
    const temperature_2m_max = Array.from({ length: days }, () => 15.0);

    mockGetHistorical.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily_units: { time: 'iso8601', temperature_2m_max: '°C' },
      daily: { time, temperature_2m_max },
    });

    const acquire = vi.fn();
    mockCanvasInstance = { acquire };

    const ctx = createMockContext();
    const input = openmeteoGetHistoricalTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      start_date: '2023-01-01',
      end_date: '2024-05-15',
      daily_variables: ['temperature_2m_max'],
    });

    const result = await openmeteoGetHistoricalTool.handler(input, ctx);
    expect(result.truncated).toBe(false);
    expect(result.canvas_id).toBeUndefined();
    expect(result.record_count).toBe(500);
    expect(result.daily).toHaveLength(500);
    expect(result.table_name).toBeUndefined(); // #18: no table name on the non-spill path
    // A result that fits must not mint a canvas — an acquired-but-unused canvas
    // holds a per-tenant slot the caller never learns about.
    expect(acquire).not.toHaveBeenCalled();
  });

  it('spills a wide multi-variable pull that sits below 500 rows', async () => {
    // #23: 480 hourly rows × 18 variables — the old row-count gate let this return
    // ~188 KB inline with no canvas_id and no retrieval path.
    const rows = 480;
    const time = hourlyTimes(rows);
    const hourly: Record<string, unknown> = { time };
    for (let v = 0; v < 18; v++) {
      hourly[`weather_variable_number_${v}`] = time.map((_, i) => 100.5 + v + (i % 7));
    }

    mockGetHistorical.mockResolvedValue({ ...MOCK_RESPONSE, daily: undefined, hourly });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: rows, tableName: 'spilled_wide' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-wide' }) };

    const ctx = createMockContext();
    const input = openmeteoGetHistoricalTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      start_date: '2023-01-01',
      end_date: '2023-01-20',
      hourly_variables: ['temperature_2m'],
    });

    const result = await openmeteoGetHistoricalTool.handler(input, ctx);
    expect(rows).toBeLessThan(500);
    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBe('canvas-wide');
    expect(result.table_name).toBe('spilled_wide');
  });

  it('covers both cadences in the spill schema when hourly and daily are requested', async () => {
    // #22: hourly records are concatenated ahead of daily ones, so a preview-sized
    // sniff window never reaches a daily row and precipitation_sum is never created.
    const hourlyTime = hourlyTimes(2160);
    const dailyTime = dailyDates(90, '2023-01-01');

    mockGetHistorical.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: { time: 'iso8601', temperature_2m: '°C' },
      daily_units: { time: 'iso8601', precipitation_sum: 'mm', sunrise: 'iso8601' },
      hourly: { time: hourlyTime, temperature_2m: hourlyTime.map((_, i) => 3.5 + (i % 10)) },
      daily: {
        time: dailyTime,
        // Live shape: precipitation is mostly whole zeros with fractional readings
        // mixed in, and sunrise is an ISO 8601 string rather than a number.
        precipitation_sum: dailyTime.map((_, i) => (i % 3 === 0 ? 0.5 : 0)),
        sunrise: dailyTime.map((d) => `${d}T08:57`),
      },
    });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: hourlyTime.length + dailyTime.length, tableName: 'spilled_union' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-union' }) };

    const ctx = createMockContext();
    const input = openmeteoGetHistoricalTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      start_date: '2023-01-01',
      end_date: '2023-04-01',
      hourly_variables: ['temperature_2m'],
      daily_variables: ['precipitation_sum', 'sunrise'],
    });
    await openmeteoGetHistoricalTool.handler(input, ctx);

    const columns = spilledSchema().map((c) => c.name);
    expect(columns).toEqual(['time', 'temperature_2m', 'precipitation_sum', 'sunrise']);
    expect(spilledSchemaType('temperature_2m')).toBe('DOUBLE');
    // Daily-only column survives, and keeps a numeric type despite its leading zeros.
    expect(spilledSchemaType('precipitation_sum')).toBe('DOUBLE');
    // A genuinely string-valued daily variable stays VARCHAR.
    expect(spilledSchemaType('sunrise')).toBe('VARCHAR');
  });

  it('formats output with attribution', () => {
    const blocks = openmeteoGetHistoricalTool.format!({
      latitude: 47.6,
      longitude: -122.3,
      elevation: 59,
      timezone: 'America/Los_Angeles',
      date_range: { start: '2024-07-01', end: '2024-07-02' },
      record_count: 2,
      daily: [{ time: '2024-07-01', temperature_2m_max: 22.5 }],
      hourly_units: undefined,
      daily_units: { temperature_2m_max: '°C' },
      canvas_id: undefined,
      truncated: false,
    });
    expect(blocks[0]?.text).toContain('ERA5');
    expect(blocks[0]?.text).toContain('Open-Meteo.com');
  });

  it('formats truncated result with canvas_id notice', () => {
    const blocks = openmeteoGetHistoricalTool.format!({
      latitude: 47.6,
      longitude: -122.3,
      elevation: 59,
      timezone: 'America/Los_Angeles',
      date_range: { start: '2020-01-01', end: '2025-12-31' },
      record_count: 43800,
      daily: [{ time: '2020-01-01', temperature_2m_max: 5.0 }],
      hourly_units: undefined,
      daily_units: { temperature_2m_max: '°C' },
      canvas_id: 'canvas-xyz-789',
      table_name: 'spilled_hist789',
      truncated: true,
    });
    expect(blocks[0]?.text).toContain('canvas-xyz-789');
    expect(blocks[0]?.text).toContain('spilled_hist789'); // #18: table name named in the hint
    // Format uses bold label: **Truncated:** true
    expect(blocks[0]?.text).toContain('Truncated:');
    expect(blocks[0]?.text).toContain('true');
  });

  it('reports the staged total (record_count), not the preview length, in the truncated hourly heading', () => {
    // #13: with truncation, result.hourly is a preview slice — the heading must not
    // read the preview length as the dataset size. A 2-row preview of a 2184-row
    // staged table should say "of 2184 total", never "of 2".
    const blocks = openmeteoGetHistoricalTool.format!({
      latitude: 47.6,
      longitude: -122.3,
      elevation: 59,
      timezone: 'America/Los_Angeles',
      date_range: { start: '2024-01-01', end: '2024-03-31' },
      record_count: 2184,
      hourly: [
        { time: '2024-01-01T00:00', temperature_2m: 5.2 },
        { time: '2024-01-01T01:00', temperature_2m: 4.8 },
      ],
      daily: undefined,
      hourly_units: { temperature_2m: '°C' },
      daily_units: undefined,
      canvas_id: 'canvas-hist-1',
      table_name: 'spilled_hist1',
      truncated: true,
    });
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('2 shown of 2184 total');
    expect(text).not.toMatch(/### Hourly \(first \d+ of 2\)/);
  });

  it('renders every hourly row (non-truncated) with no cap or "…and N more" (format parity)', () => {
    // 60 rows is above the former 48-row render cap.
    const hourly = Array.from({ length: 60 }, (_, i) => ({
      time: `2024-07-01T00:00+${i}`,
      temperature_2m: 1000 + i,
    }));
    const text =
      openmeteoGetHistoricalTool.format!({
        latitude: 47.6,
        longitude: -122.3,
        elevation: 59,
        timezone: 'America/Los_Angeles',
        date_range: { start: '2024-07-01', end: '2024-07-03' },
        record_count: 60,
        hourly,
        daily: undefined,
        hourly_units: { temperature_2m: '°C' },
        daily_units: undefined,
        canvas_id: undefined,
        table_name: undefined,
        truncated: false,
      })[0]?.text ?? '';
    expect(text).toContain('### Hourly (60 records)');
    expect(text).toContain('temperature_2m: 1000');
    expect(text).toContain('temperature_2m: 1059'); // last row — not sliced at 48
    expect(text).not.toMatch(/and \d+ more/);
  });

  it('renders the full spillover preview (truncated) — shown count is the preview length, not the old 48 cap', () => {
    // 60-row preview of a 5000-row staged table: every preview row renders and the
    // heading reports the staged total (record_count), not the preview length.
    const hourly = Array.from({ length: 60 }, (_, i) => ({
      time: `2024-07-01T00:00+${i}`,
      temperature_2m: 2000 + i,
    }));
    const text =
      openmeteoGetHistoricalTool.format!({
        latitude: 47.6,
        longitude: -122.3,
        elevation: 59,
        timezone: 'America/Los_Angeles',
        date_range: { start: '2024-01-01', end: '2024-12-31' },
        record_count: 5000,
        hourly,
        daily: undefined,
        hourly_units: { temperature_2m: '°C' },
        daily_units: undefined,
        canvas_id: 'canvas-hist-big',
        table_name: 'spilled_histbig',
        truncated: true,
      })[0]?.text ?? '';
    expect(text).toContain('### Hourly (preview — 60 shown of 5000 total rows on canvas)');
    expect(text).toContain('temperature_2m: 2000');
    expect(text).toContain('temperature_2m: 2059'); // full preview rendered, not capped at 48
    expect(text).toContain('spilled_histbig'); // #18: table name in the hint
    expect(text).not.toMatch(/and \d+ more/);
  });
});
