/**
 * @fileoverview Tests for openmeteo_get_flood tool.
 * @module tests/tools/get-flood.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoGetFloodTool } from '@/mcp-server/tools/definitions/get-flood.tool.js';
import { INLINE_CHARS } from '@/mcp-server/tools/spill-utils.js';
import { firstText } from '../helpers/content.js';
import { rowBudgetFor, structuredSize } from '../helpers/inline-surface.js';

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
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
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
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
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
  ])(
    'throws forecast_days_conflict when forecast_days is combined with %s',
    async (_label, dates) => {
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
    },
  );

  it('accepts forecast_days alone and a paired range alone', async () => {
    mockGetFlood.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });

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

  // --- timezone (#38) --------------------------------------------------------

  it('rejects a blank timezone before the network call (#38)', async () => {
    // openMeteoUrl omits an empty value, so a blank timezone used to fall through to
    // upstream's GMT default rather than the documented "auto".
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
      timezone: '',
    });
    await expect(openmeteoGetFloodTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('timezone was blank'),
      data: {
        reason: 'invalid_timezone',
        recovery: { hint: expect.stringContaining('IANA') },
      },
    });
    expect(mockGetFlood).not.toHaveBeenCalled();
  });

  it('reclassifies the upstream Invalid timezone envelope away from invalid_variable (#38)', async () => {
    // Live upstream shape for an unknown zone: HTTP 400, {"reason":"Invalid timezone","error":true}.
    mockGetFlood.mockResolvedValue({ ...MOCK_RESPONSE, error: true, reason: 'Invalid timezone' });
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
      timezone: 'Mars/Olympus',
    });
    await expect(openmeteoGetFloodTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('Open-Meteo rejected the requested timezone'),
      data: {
        reason: 'invalid_timezone',
        recovery: { hint: expect.stringContaining('auto') },
      },
    });
  });

  it('still defaults an omitted timezone to auto (#38)', async () => {
    mockGetFlood.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
    });
    await openmeteoGetFloodTool.handler(input, ctx);
    expect(mockGetFlood).toHaveBeenCalledWith(
      47.6,
      -122.3,
      expect.objectContaining({ timezone: 'auto' }),
      ctx,
    );
  });

  it('passes a valid IANA zone through unchanged (#38)', async () => {
    mockGetFlood.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
      timezone: 'America/Los_Angeles',
    });
    await openmeteoGetFloodTool.handler(input, ctx);
    expect(mockGetFlood).toHaveBeenCalledWith(
      47.6,
      -122.3,
      expect.objectContaining({ timezone: 'America/Los_Angeles' }),
      ctx,
    );
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

  it('classifies the upstream too-much-data rejection as request_too_large (#50)', async () => {
    // A multi-decade reanalysis pull across every percentile: the names are valid and
    // the dates are in range, so neither the unknown-name nor the date branch fits.
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason:
        'Your API call requests too much data. Please reduce the number of variables, locations and/or weather models.',
    });
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge', 'river_discharge_p25', 'river_discharge_p75'],
      start_date: '1984-01-01',
      end_date: '2023-12-31',
    });

    const error = await Promise.resolve(openmeteoGetFloodTool.handler(input, ctx)).catch(
      (e: Error) => e,
    );

    if (!(error instanceof Error)) throw new Error('Expected the flood handler to reject');
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'request_too_large',
        recovery: { hint: expect.stringContaining('Narrow the request') },
      },
    });
    expect(error.message).toContain('too much data at once');
    expect(error.message).toContain('fewer daily_variables');
    expect(error.message).not.toMatch(/exact Open-Meteo API name/);
    // The date branch must not claim it: the reason carries neither "date" nor "range".
    expect(error.message).not.toMatch(/GloFAS range/);
  });

  it('returns empty daily array when API returns no daily block', async () => {
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily: undefined,
    });
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
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

    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
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
    // The preview is selected here, against this server's inline ceiling, rather than
    // read off spillover()'s own buffer — the two measure rows in different currencies.
    expect(result.daily.length).toBeGreaterThan(0);
    expect(result.daily.length).toBeLessThan(days);
    expect(result.daily).not.toEqual(previewRows);
  });

  it('starts the canvas-path preview at the first row carrying data', async () => {
    // The canvas branch used to echo spillover()'s chronological head, so a reanalysis
    // range opening before the coordinate's record began previewed nothing but nulls.
    // It now takes the same boundedPreview() selection the canvas-less branch does;
    // the staged table still holds every row in chronological order.
    const days = 15_000;
    const nullRun = 4_749; // 1984 → the coordinate's first reading, measured live
    const time = dailyDates(days);
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily: {
        time,
        river_discharge: time.map((_, i) => (i < nullRun ? null : 100 + (i % 40) + 0.5)),
      },
    });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: days, tableName: 'spilled_flood03' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-flood-3' }) };

    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
      start_date: '1984-01-01',
      end_date: '2026-07-15',
    });
    const result = await openmeteoGetFloodTool.handler(input, ctx);

    expect(result.daily[0]?.time).toBe(time[nullRun]);
    expect(result.daily.every((r) => r.river_discharge !== null)).toBe(true);
    expect(result.record_count).toBe(days); // skipped rows are still counted
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

    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
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

    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
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

  it('stages on its own budget decision rather than re-asking spillover (#41)', async () => {
    // spillover() measures rows by JSON length alone, where this server's ceiling also
    // charges the row separators and the wider markdown rendering. Handing it the same
    // budget would let it decline a set the ceiling already rejected and return the
    // whole thing inline under truncated: false — the overshoot the ceiling exists to
    // prevent. It is told to stage instead, and truncated follows the decision made here.
    const time = dailyDates(15_000);
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily: { time, river_discharge: time.map((_, i) => 100 + (i % 40) + 0.5) },
    });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: time.length, tableName: 'spilled_flood02' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-flood-2' }) };

    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
      start_date: '1984-01-01',
      end_date: '2026-07-15',
    });
    const result = await openmeteoGetFloodTool.handler(input, ctx);

    const [opts] = mockSpillover.mock.calls[0] as [{ previewChars: number }];
    expect(opts.previewChars).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBe('canvas-flood-2');
    expect(result.table_name).toBe('spilled_flood02');
    expect(result.record_count).toBe(time.length);
  });

  it('returns inline without touching a canvas when the payload fits', async () => {
    mockGetFlood.mockResolvedValue(MOCK_RESPONSE);
    const acquire = vi.fn();
    mockCanvasInstance = { acquire };

    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
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

  it('bounds the preview and sets truncated=true when the payload is oversized and canvas is disabled', async () => {
    // #28: the budget check used to act only inside the `if (canvas)` branch, so a
    // default deployment (CANVAS_PROVIDER_TYPE=none) fell through to an unbounded
    // inline return carrying truncated: false — the field a client reads to decide
    // whether anything is missing.
    const time = dailyDates(15_000);
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily: { time, river_discharge: time.map((_, i) => 100 + (i % 40) + 0.5) },
    });
    mockCanvasInstance = undefined; // CANVAS_PROVIDER_TYPE=none

    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
      start_date: '1984-01-01',
      end_date: '2026-07-15',
    });
    const result = await openmeteoGetFloodTool.handler(input, ctx);

    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBeUndefined();
    expect(result.table_name).toBeUndefined();
    expect(mockSpillover).not.toHaveBeenCalled();
    // Bounded by the same budget the canvas path measures against.
    expect(result.daily.length).toBeLessThan(time.length);
    expect(JSON.stringify(result.daily).length).toBeLessThanOrEqual(rowBudgetFor(result));
    // record_count stays the full upstream total, not the preview length.
    expect(result.record_count).toBe(time.length);
  });

  it('composes the no-canvas disclosure into the notice, not only into content[] (#51)', async () => {
    // The disclosure reached content[] through format() alone, so a structuredContent-only
    // client saw truncated: true with no canvas_id and nothing explaining either.
    const time = dailyDates(15_000);
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily: { time, river_discharge: time.map((_, i) => 100 + (i % 40) + 0.5) },
    });
    mockCanvasInstance = undefined; // CANVAS_PROVIDER_TYPE=none

    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const result = await openmeteoGetFloodTool.handler(
      openmeteoGetFloodTool.input.parse({
        latitude: 47.6,
        longitude: -122.3,
        daily_variables: ['river_discharge'],
        start_date: '1984-01-01',
        end_date: '2026-07-15',
      }),
      ctx,
    );

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('There is no canvas_id because DataCanvas is disabled');
    expect(notice).toContain('CANVAS_PROVIDER_TYPE=duckdb');
    expect(notice).toContain('fewer daily_variables');
    expect(firstText(openmeteoGetFloodTool.format!(result))).toContain('CANVAS_PROVIDER_TYPE=none');
  });

  it('names the disabled canvas and the narrowing levers in the truncated no-canvas format()', () => {
    const text = firstText(
      openmeteoGetFloodTool.format!({
        latitude: 47.6,
        longitude: -122.3,
        timezone: 'America/Los_Angeles',
        record_count: 15_000,
        daily: [{ time: '1984-01-01', river_discharge: 120.5 }],
        daily_units: { river_discharge: 'm³/s' },
        canvas_id: undefined,
        table_name: undefined,
        truncated: true,
      }),
    );
    expect(text).toContain('CANVAS_PROVIDER_TYPE=none');
    expect(text).toContain('CANVAS_PROVIDER_TYPE=duckdb');
    expect(text).toContain('fewer daily_variables');
    // Heading reports the upstream total and does not claim a canvas holds it.
    expect(text).toContain('1 shown of 15000 total rows)');
    expect(text).not.toContain('total rows on canvas');
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
    expect(firstText(blocks)).toContain('GloFAS');
    expect(firstText(blocks)).toContain('river_discharge');
    expect(firstText(blocks)).toContain('Open-Meteo.com');
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
    expect(firstText(blocks)).toContain('GloFAS coverage');
  });

  it('formats truncated result with the canvas and table handles', () => {
    const text = firstText(
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
      }),
    );
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
    const text = firstText(
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
      }),
    );
    expect(text).toContain('### Daily discharge (35 records)');
    expect(text).toContain('river_discharge: 1000');
    expect(text).toContain('river_discharge: 1034'); // last row — not sliced at 30
    expect(text).not.toMatch(/and \d+ more/);
  });
});

describe('openmeteoGetFloodTool unserved-variable notice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasInstance = undefined;
    mockSpillover.mockResolvedValue({ spilled: false, previewRows: [] });
  });

  it('notices an all-null column upstream reported with unit "undefined"', async () => {
    // GloFAS shares the forecast API's variable parser, so a weather name it does not
    // serve comes back HTTP 200 with an all-null column rather than an error —
    // verified live with daily=precipitation_sum.
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily_units: { time: 'iso8601', river_discharge: 'm³/s', precipitation_sum: 'undefined' },
      daily: {
        time: ['2026-06-03', '2026-06-04'],
        river_discharge: [120.5, 118.0],
        precipitation_sum: [null, null],
      },
    });
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge', 'precipitation_sum'],
    });

    await openmeteoGetFloodTool.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toContain('precipitation_sum returned no data');
    expect(getEnrichment(ctx).notice).toContain('openmeteo_get_forecast');
  });

  it('stays quiet when every requested column carries a real unit', async () => {
    mockGetFlood.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
    });

    await openmeteoGetFloodTool.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  // --- inline size ceiling (#41), canvas pointer (#44), coverage gaps (#40) ---

  const DISCHARGE_VARIABLES = [
    'river_discharge',
    'river_discharge_mean',
    'river_discharge_min',
    'river_discharge_max',
    'river_discharge_median',
    'river_discharge_p25',
    'river_discharge_p75',
  ];

  /** A multi-decade reanalysis pull across every discharge percentile. */
  const wideReanalysis = () => {
    const time = dailyDates(14_610);
    const daily: Record<string, (number | null)[] | string[]> = { time };
    const dailyUnits: Record<string, string> = { time: 'iso8601' };
    for (const variable of DISCHARGE_VARIABLES) {
      daily[variable] = time.map((_, row) => 100.25 + (row % 60));
      dailyUnits[variable] = 'm³/s';
    }
    return { time, daily, dailyUnits };
  };

  const wideInput = () =>
    openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: DISCHARGE_VARIABLES,
      start_date: '1984-01-01',
      end_date: '2023-12-31',
    });

  it('keeps both inline surfaces inside the ceiling when the spill stages (#41)', async () => {
    const { daily, dailyUnits } = wideReanalysis();
    mockGetFlood.mockResolvedValue({ ...MOCK_RESPONSE, daily_units: dailyUnits, daily });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: 14_610, tableName: 'spilled_fl41' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-fl-41' }) };

    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const result = await openmeteoGetFloodTool.handler(wideInput(), ctx);

    expect(result.truncated).toBe(true);
    expect(structuredSize(result, ctx)).toBeLessThanOrEqual(INLINE_CHARS);
    expect(firstText(openmeteoGetFloodTool.format!(result)).length).toBeLessThanOrEqual(
      INLINE_CHARS,
    );
  });

  it('keeps both inline surfaces inside the ceiling with canvas disabled (#41)', async () => {
    const { daily, dailyUnits } = wideReanalysis();
    mockGetFlood.mockResolvedValue({ ...MOCK_RESPONSE, daily_units: dailyUnits, daily });
    mockCanvasInstance = undefined;

    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const result = await openmeteoGetFloodTool.handler(wideInput(), ctx);

    expect(result.truncated).toBe(true);
    expect(structuredSize(result, ctx)).toBeLessThanOrEqual(INLINE_CHARS);
    expect(firstText(openmeteoGetFloodTool.format!(result)).length).toBeLessThanOrEqual(
      INLINE_CHARS,
    );
  });

  it('names openmeteo_dataframe_describe before openmeteo_dataframe_query on both surfaces (#44)', async () => {
    const { daily, dailyUnits } = wideReanalysis();
    mockGetFlood.mockResolvedValue({ ...MOCK_RESPONSE, daily_units: dailyUnits, daily });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: 14_610, tableName: 'spilled_fl44' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-fl-44' }) };

    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const result = await openmeteoGetFloodTool.handler(wideInput(), ctx);

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('spilled_fl44');
    expect(notice.indexOf('openmeteo_dataframe_describe')).toBeGreaterThanOrEqual(0);
    expect(notice.indexOf('openmeteo_dataframe_describe')).toBeLessThan(
      notice.indexOf('openmeteo_dataframe_query'),
    );

    const text = firstText(openmeteoGetFloodTool.format!(result));
    expect(text.indexOf('openmeteo_dataframe_describe')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('openmeteo_dataframe_describe')).toBeLessThan(
      text.indexOf('openmeteo_dataframe_query'),
    );
  });

  it('keeps the unserved-column warning when the canvas pointer fires in the same call (#44)', async () => {
    const { time, daily, dailyUnits } = wideReanalysis();
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily_units: { ...dailyUnits, precipitation_sum: 'undefined' },
      daily: { ...daily, precipitation_sum: time.map(() => null) },
    });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: 14_610, tableName: 'spilled_fl44b' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-fl-44b' }) };

    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    await openmeteoGetFloodTool.handler(
      openmeteoGetFloodTool.input.parse({
        latitude: 47.6,
        longitude: -122.3,
        daily_variables: [...DISCHARGE_VARIABLES, 'precipitation_sum'],
        start_date: '1984-01-01',
        end_date: '2023-12-31',
      }),
      ctx,
    );

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('precipitation_sum returned no data');
    expect(notice).toContain('openmeteo_dataframe_describe');
  });

  it('reports a reanalysis range that opens before the coordinate has a record (#40)', async () => {
    // A GloFAS range starting before the nearest river's record begins comes back
    // null until it does, with the real m³/s unit throughout.
    const time = dailyDates(30);
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily_units: { time: 'iso8601', river_discharge: 'm³/s' },
      daily: {
        time,
        river_discharge: time.map((_, row) => (row < 12 ? null : 120 + row)),
      },
    });

    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const result = await openmeteoGetFloodTool.handler(
      openmeteoGetFloodTool.input.parse({
        latitude: 47.6,
        longitude: -122.3,
        daily_variables: ['river_discharge'],
        start_date: '1984-01-01',
        end_date: '1984-01-30',
      }),
      ctx,
    );

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('Partial daily coverage for river_discharge');
    expect(notice).toContain(`data runs ${time[12]} to ${time[29]}`);
    expect(notice).toContain('12 of 30 rows are null');
    expect(result.record_count).toBe(30);
  });
});

describe('openmeteoGetFloodTool river-selection wording (#43)', () => {
  /*
   * GloFAS returns discharge for the LARGEST river within a 5 km area of the
   * coordinate, which is not always the closest one. Every surface that used to say
   * "snaps to the nearest river/stream" told a caller near a confluence or a pair of
   * parallel channels to trust a reach the API never promised.
   */
  const RIVER_SURFACES: [string, () => string][] = [
    ['tool description', () => openmeteoGetFloodTool.description],
    ['latitude input', () => openmeteoGetFloodTool.input.shape.latitude.description ?? ''],
    ['longitude input', () => openmeteoGetFloodTool.input.shape.longitude.description ?? ''],
    ['latitude output', () => openmeteoGetFloodTool.output.shape.latitude.description ?? ''],
    ['longitude output', () => openmeteoGetFloodTool.output.shape.longitude.description ?? ''],
  ];

  it.each(RIVER_SURFACES)('%s claims no nearest-river snap', (_surface, read) => {
    expect(read()).not.toMatch(/nearest (river|stream)/i);
  });

  it('the tool description states the largest-river-within-5-km rule', () => {
    const text = openmeteoGetFloodTool.description;
    expect(text).toMatch(/largest/i);
    expect(text).toMatch(/5\s?km/i);
    expect(text).toMatch(/not (always|necessarily) the closest/i);
    expect(text).toMatch(/confluence/i);
  });

  it('the tool description carries Open-Meteo’s ±0.1° coordinate-variation guidance', () => {
    const text = openmeteoGetFloodTool.description;
    expect(text).toMatch(/0\.1°/);
    expect(text).toMatch(/vary|varying/i);
  });

  it.each([
    ['latitude', () => openmeteoGetFloodTool.input.shape.latitude.description ?? ''],
    ['longitude', () => openmeteoGetFloodTool.input.shape.longitude.description ?? ''],
  ])('the %s input description states the selection rule', (_field, read) => {
    const text = read();
    expect(text).toMatch(/largest/i);
    expect(text).toMatch(/5\s?km/i);
  });

  it('the snapped output coordinates are described as the selected river’s grid point', () => {
    expect(openmeteoGetFloodTool.output.shape.latitude.description ?? '').toMatch(
      /selected river/i,
    );
  });

  it('keeps the out-of-coverage null statement distinct from river selection', () => {
    // Two different situations: a returned-but-possibly-wrong river, and no river at all.
    expect(openmeteoGetFloodTool.description).toMatch(/without GloFAS coverage/i);
    expect(openmeteoGetFloodTool.output.shape.daily.description ?? '').toMatch(
      /outside GloFAS coverage/i,
    );
  });

  it('leaves the error contract untouched — no new reason for river selection', () => {
    // Advisory guidance only: GloFAS answers a mis-selected river with HTTP 200.
    const reasons = openmeteoGetFloodTool.errors?.map((e) => e.reason) ?? [];
    expect(reasons).toEqual([
      'no_variables_requested',
      'date_range_incomplete',
      'forecast_days_conflict',
      'date_order_invalid',
      'date_out_of_range',
      'invalid_variable',
      'invalid_timezone',
      'request_too_large',
    ]);
  });
});
