/**
 * @fileoverview Tests for openmeteo_get_flood tool.
 * @module tests/tools/get-flood.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoGetFloodTool } from '@/mcp-server/tools/definitions/get-flood.tool.js';

const mockGetFlood = vi.fn();
const mockSpillover = vi.fn();

vi.mock('@/services/open-meteo/open-meteo-service.js', () => ({
  getOpenMeteoService: () => ({ getFlood: mockGetFlood }),
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

/** Column type by name from the schema the handler handed to spillover(). */
const spilledSchemaType = (name: string): string | undefined => {
  const [opts] = mockSpillover.mock.calls[0] as [{ schema?: { name: string; type: string }[] }];
  return opts.schema?.find((c) => c.name === name)?.type;
};

/** `count` consecutive ISO dates from `from`. */
const dailyDates = (count: number, from = '1984-01-01'): string[] =>
  Array.from({ length: count }, (_, i) => {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    return d.toISOString().slice(0, 10);
  });

const MOCK_RESPONSE = {
  latitude: 47.6,
  longitude: -122.3,
  utc_offset_seconds: -25200,
  timezone: 'America/Los_Angeles',
  timezone_abbreviation: 'GMT-7',
  generationtime_ms: 1.1,
  daily_units: { time: 'iso8601', river_discharge: 'm³/s', river_discharge_p25: 'm³/s' },
  daily: {
    time: ['2026-06-03', '2026-06-04'],
    river_discharge: [120.5, 118.0],
    river_discharge_p25: [95.0, 92.5],
  },
};

describe('openmeteoGetFloodTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasInstance = undefined; // reset canvas to disabled state
    // Default spillover mock: fit result (no spill) — overridden per test
    mockSpillover.mockResolvedValue({
      spilled: false,
      previewRows: [],
    });
  });

  it('reshapes daily discharge response into per-date records', async () => {
    mockGetFlood.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext();
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge', 'river_discharge_p25'],
    });
    const result = await openmeteoGetFloodTool.handler(input, ctx);

    expect(result.daily).toHaveLength(2);
    expect(result.daily[0]).toEqual({
      time: '2026-06-03',
      river_discharge: 120.5,
      river_discharge_p25: 95.0,
    });
    expect(result.daily[1]).toEqual({
      time: '2026-06-04',
      river_discharge: 118.0,
      river_discharge_p25: 92.5,
    });
    expect(result.daily_units).toMatchObject({ river_discharge: 'm³/s' });
    expect(result.record_count).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.canvas_id).toBeUndefined();
    expect(result.table_name).toBeUndefined();
  });

  it('preserves null values for coordinates outside GloFAS coverage', async () => {
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily: {
        time: ['2026-06-03'],
        river_discharge: [null],
      },
    });
    const ctx = createMockContext();
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 0,
      longitude: 0,
      daily_variables: ['river_discharge'],
    });
    const result = await openmeteoGetFloodTool.handler(input, ctx);
    expect(result.daily[0]?.river_discharge).toBeNull();
  });

  it('throws no_variables_requested (reason + recovery hint) when daily_variables is empty', async () => {
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    // Schema now accepts [] (optional, .min(1) dropped), so the input parses and the
    // declared recovery fires instead of a generic Zod rejection — no bypass needed.
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: [],
    });
    await expect(openmeteoGetFloodTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'no_variables_requested',
        recovery: { hint: expect.stringContaining('daily_variables') },
      },
    });
  });

  it('throws no_variables_requested when daily_variables is omitted entirely', async () => {
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
    });
    await expect(openmeteoGetFloodTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'no_variables_requested' },
    });
  });

  /**
   * #25 — GloFAS requires start_date and end_date together and rejects forecast_days
   * alongside either. Each combination below is the live API's documented behaviour;
   * before the guards, every one of them reached upstream and came back classified as
   * date_out_of_range with a recovery about the 1984 coverage floor — advice that
   * fixes none of them.
   */
  it('throws date_range_incomplete when only start_date is provided', async () => {
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
      start_date: '2024-01-01',
    });
    await expect(openmeteoGetFloodTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('start_date'),
      data: {
        reason: 'date_range_incomplete',
        recovery: { hint: expect.stringContaining('end_date') },
      },
    });
    expect(mockGetFlood).not.toHaveBeenCalled();
  });

  it('throws date_range_incomplete when only end_date is provided', async () => {
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
      end_date: '2024-01-02',
    });
    await expect(openmeteoGetFloodTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('end_date'),
      data: { reason: 'date_range_incomplete' },
    });
    expect(mockGetFlood).not.toHaveBeenCalled();
  });

  it.each([
    ['start_date only', { start_date: '2024-01-01' }],
    ['end_date only', { end_date: '2024-01-02' }],
    ['a correctly paired range', { start_date: '2024-01-01', end_date: '2024-01-02' }],
  ])('throws forecast_days_conflict when forecast_days is combined with %s', async (_label, dates) => {
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
      forecast_days: 7,
      ...dates,
    });
    await expect(openmeteoGetFloodTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'forecast_days_conflict',
        recovery: { hint: expect.stringContaining('forecast_days') },
      },
    });
    expect(mockGetFlood).not.toHaveBeenCalled();
  });

  it('accepts forecast_days alone and a paired range alone', async () => {
    mockGetFlood.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext();

    const forecastOnly = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
      forecast_days: 7,
    });
    await expect(openmeteoGetFloodTool.handler(forecastOnly, ctx)).resolves.toMatchObject({
      truncated: false,
    });

    const rangeOnly = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
      start_date: '2024-01-01',
      end_date: '2024-01-02',
    });
    await expect(openmeteoGetFloodTool.handler(rangeOnly, ctx)).resolves.toMatchObject({
      truncated: false,
    });
    expect(mockGetFlood).toHaveBeenCalledTimes(2);
  });

  it('throws date_order_invalid when end_date before start_date', async () => {
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
      start_date: '2023-07-10',
      end_date: '2023-07-01',
    });
    await expect(openmeteoGetFloodTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'date_order_invalid' },
    });
  });

  it('throws date_out_of_range when start_date before 1984', async () => {
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
      start_date: '1980-01-01',
      end_date: '1980-12-31',
    });
    await expect(openmeteoGetFloodTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'date_out_of_range' },
    });
  });

  it('throws date_out_of_range when API error envelope has date-related reason', async () => {
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason: 'start_date is out of allowed date range.',
    });
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
    });
    await expect(openmeteoGetFloodTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'date_out_of_range' },
    });
  });

  it('frames the upstream unknown-variable rejection with the offending name and recovery hint', async () => {
    // Real upstream reason shape from the live flood endpoint (Swift type-init jargon).
    // Non-date reasons must route to invalid_variable, not date_out_of_range.
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason:
        "Data corrupted at path ''. Cannot initialize ForecastVariableDaily from invalid String value bogus_discharge.",
    });
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['bogus_discharge'],
    });
    await expect(openmeteoGetFloodTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringMatching(/^Unknown discharge variable name: bogus_discharge\./),
      data: {
        reason: 'invalid_variable',
        recovery: { hint: expect.stringContaining('river_discharge') },
      },
    });
  });

  it('returns empty daily array when API returns no daily block', async () => {
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily: undefined,
    });
    const ctx = createMockContext();
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 0,
      longitude: 0,
      daily_variables: ['river_discharge'],
    });
    const result = await openmeteoGetFloodTool.handler(input, ctx);
    expect(result.daily).toHaveLength(0);
    expect(result.record_count).toBe(0);
  });

  /**
   * #19 — a full 1984→present reanalysis pull is ~15.5k daily records (~285 KB) and
   * had no retrieval path: every row came back inline with no canvas handle. Spill
   * eligibility is payload size, never row count — see spill-utils.
   */
  it('spills to DataCanvas and sets truncated=true when the payload exceeds the inline budget', async () => {
    const days = 15_537; // 1984-01-01 → present, the full GloFAS reanalysis span
    const time = dailyDates(days);
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily: {
        time,
        river_discharge: time.map((_, i) => 100 + (i % 40) + 0.5),
        river_discharge_p25: time.map((_, i) => 80 + (i % 30) + 0.5),
      },
    });

    const previewRows = time.slice(0, 5).map((t, i) => ({
      time: t,
      river_discharge: 100 + i,
      river_discharge_p25: 80 + i,
    }));
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: days, tableName: 'spilled_flood01' },
      previewRows,
    });

    const mockInstance = { canvasId: 'canvas-flood-123' };
    const mockCanvas = { acquire: vi.fn().mockResolvedValue(mockInstance) };
    mockCanvasInstance = mockCanvas;

    const ctx = createMockContext();
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge', 'river_discharge_p25'],
      start_date: '1984-01-01',
      end_date: '2026-07-15',
    });
    const result = await openmeteoGetFloodTool.handler(input, ctx);

    expect(mockCanvas.acquire).toHaveBeenCalled();
    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBe('canvas-flood-123');
    expect(result.table_name).toBe('spilled_flood01');
    expect(result.record_count).toBe(days); // full staged total, not the preview length
    expect(result.daily).toEqual(previewRows);
  });

  it('passes the caller canvas_id through to acquire', async () => {
    const time = dailyDates(15_000);
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily: { time, river_discharge: time.map((_, i) => 100 + (i % 40) + 0.5) },
    });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: time.length, tableName: 'spilled_reuse' },
      previewRows: [],
    });
    const acquire = vi.fn().mockResolvedValue({ canvasId: 'existingcv1' });
    mockCanvasInstance = { acquire };

    const ctx = createMockContext();
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
      start_date: '1984-01-01',
      end_date: '2026-07-15',
      canvas_id: 'existingcv1',
    });
    await openmeteoGetFloodTool.handler(input, ctx);
    expect(acquire).toHaveBeenCalledWith('existingcv1', ctx);
  });

  it('types discharge columns from every staged row, not a leading window', async () => {
    // A coordinate outside GloFAS coverage is null down its whole column, and
    // discharge readings that open on whole numbers must not type as integers —
    // the appender would truncate every fractional reading that follows.
    const time = dailyDates(15_000);
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily: {
        time,
        river_discharge: time.map((_, i) => (i < 3 ? 100 : 100 + (i % 40) + 0.5)),
        river_discharge_p25: time.map(() => null),
      },
    });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: time.length, tableName: 'spilled_types' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-types' }) };

    const ctx = createMockContext();
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge', 'river_discharge_p25'],
      start_date: '1984-01-01',
      end_date: '2026-07-15',
    });
    await openmeteoGetFloodTool.handler(input, ctx);

    expect(spilledSchemaType('river_discharge')).toBe('DOUBLE');
    expect(spilledSchemaType('time')).toBe('VARCHAR');
    // No non-null evidence anywhere in an out-of-coverage column — VARCHAR is the
    // framework's documented fallback, and every cell in it is null regardless.
    expect(spilledSchemaType('river_discharge_p25')).toBe('VARCHAR');
  });

  it('returns no canvas handles when spillover declines to stage a table', async () => {
    // The handler must never surface a canvas_id pointing at an empty canvas —
    // spilled.handle only exists on the spilled branch of the union.
    const time = dailyDates(15_000);
    const records = time.map((t, i) => ({ time: t, river_discharge: 100 + (i % 40) + 0.5 }));
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily: { time, river_discharge: time.map((_, i) => 100 + (i % 40) + 0.5) },
    });
    mockSpillover.mockResolvedValue({ spilled: false, previewRows: records });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-unused' }) };

    const ctx = createMockContext();
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
      start_date: '1984-01-01',
      end_date: '2026-07-15',
    });
    const result = await openmeteoGetFloodTool.handler(input, ctx);

    expect(result.truncated).toBe(false);
    expect(result.canvas_id).toBeUndefined();
    expect(result.table_name).toBeUndefined();
    expect(result.record_count).toBe(time.length);
  });

  it('returns inline without touching a canvas when the payload fits', async () => {
    mockGetFlood.mockResolvedValue(MOCK_RESPONSE);
    const acquire = vi.fn();
    mockCanvasInstance = { acquire };

    const ctx = createMockContext();
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
      forecast_days: 210,
    });
    const result = await openmeteoGetFloodTool.handler(input, ctx);

    expect(result.truncated).toBe(false);
    expect(result.record_count).toBe(2);
    // A result that fits must not mint a canvas — an acquired-but-unused canvas
    // holds a per-tenant slot the caller never learns about.
    expect(acquire).not.toHaveBeenCalled();
    expect(mockSpillover).not.toHaveBeenCalled();
  });

  it('returns data inline when the payload is oversized but canvas is disabled', async () => {
    const time = dailyDates(15_000);
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily: { time, river_discharge: time.map((_, i) => 100 + (i % 40) + 0.5) },
    });
    mockCanvasInstance = undefined; // CANVAS_PROVIDER_TYPE=none

    const ctx = createMockContext();
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
      start_date: '1984-01-01',
      end_date: '2026-07-15',
    });
    const result = await openmeteoGetFloodTool.handler(input, ctx);

    expect(result.truncated).toBe(false);
    expect(result.canvas_id).toBeUndefined();
    expect(result.daily).toHaveLength(time.length);
    expect(result.record_count).toBe(time.length);
  });

  it('formats output with GloFAS label and attribution', () => {
    const blocks = openmeteoGetFloodTool.format!({
      latitude: 47.6,
      longitude: -122.3,
      timezone: 'America/Los_Angeles',
      record_count: 1,
      daily: [{ time: '2026-06-03', river_discharge: 120.5 }],
      daily_units: { river_discharge: 'm³/s' },
      canvas_id: undefined,
      table_name: undefined,
      truncated: false,
    });
    expect(blocks[0]?.text).toContain('GloFAS');
    expect(blocks[0]?.text).toContain('river_discharge');
    expect(blocks[0]?.text).toContain('Open-Meteo.com');
  });

  it('formats empty result with coverage notice', () => {
    const blocks = openmeteoGetFloodTool.format!({
      latitude: 0,
      longitude: 0,
      timezone: 'UTC',
      record_count: 0,
      daily: [],
      canvas_id: undefined,
      table_name: undefined,
      truncated: false,
    });
    expect(blocks[0]?.text).toContain('GloFAS coverage');
  });

  it('formats truncated result with the canvas and table handles', () => {
    const text =
      openmeteoGetFloodTool.format!({
        latitude: 47.6,
        longitude: -122.3,
        timezone: 'America/Los_Angeles',
        record_count: 15_537,
        daily: [{ time: '1984-01-01', river_discharge: 120.5 }],
        daily_units: { time: 'iso8601', river_discharge: 'm³/s' },
        canvas_id: 'canvas-flood-123',
        table_name: 'spilled_flood01',
        truncated: true,
      })[0]?.text ?? '';
    expect(text).toContain('canvas-flood-123');
    expect(text).toContain('spilled_flood01');
    expect(text).toContain('openmeteo_dataframe_query');
    expect(text).toContain('**Truncated:** true');
    // The truncated heading reports record_count, not the 1-row preview length —
    // text-only clients must not read the preview size as the dataset total.
    expect(text).toContain('1 shown of 15537 total');
  });

  it('renders every daily row in content[] with no cap or "…and N more" (format parity)', () => {
    // 35 rows is above the former 30-row render cap.
    const daily = Array.from({ length: 35 }, (_, i) => ({
      time: `2026-06-${String(i + 1).padStart(2, '0')}`,
      river_discharge: 1000 + i,
    }));
    const text =
      openmeteoGetFloodTool.format!({
        latitude: 47.6,
        longitude: -122.3,
        timezone: 'America/Los_Angeles',
        record_count: 35,
        daily,
        daily_units: { river_discharge: 'm³/s' },
        canvas_id: undefined,
        table_name: undefined,
        truncated: false,
      })[0]?.text ?? '';
    expect(text).toContain('### Daily discharge (35 records)');
    expect(text).toContain('river_discharge: 1000');
    expect(text).toContain('river_discharge: 1034'); // last row — not sliced at 30
    expect(text).not.toMatch(/and \d+ more/);
  });
});
