/**
 * @fileoverview Tests for openmeteo_get_air_quality tool.
 * @module tests/tools/get-air-quality.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoGetAirQualityTool } from '@/mcp-server/tools/definitions/get-air-quality.tool.js';
import { INLINE_CHARS } from '@/mcp-server/tools/spill-utils.js';
import { firstText } from '../helpers/content.js';
import { rowBudgetFor, structuredSize } from '../helpers/inline-surface.js';

const mockGetAirQuality = vi.fn();
const mockSpillover = vi.fn();

vi.mock('@/services/open-meteo/open-meteo-service.js', () => ({
  getOpenMeteoService: () => ({ getAirQuality: mockGetAirQuality }),
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
  latitude: 47.595562,
  longitude: -122.32443,
  elevation: 0,
  utc_offset_seconds: -25200,
  timezone: 'America/Los_Angeles',
  timezone_abbreviation: 'GMT-7',
  generationtime_ms: 0.4,
  hourly_units: { time: 'iso8601', pm2_5: 'μg/m³', european_aqi: 'EAQI' },
  hourly: {
    time: ['2026-05-30T00:00', '2026-05-30T01:00'],
    pm2_5: [3.2, 3.5],
    european_aqi: [10, 11],
  },
};

describe('openmeteoGetAirQualityTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasInstance = undefined; // reset canvas to disabled state
    mockSpillover.mockResolvedValue({ spilled: false, previewRows: [] });
  });

  it('reshapes columnar air quality response with exact alignment', async () => {
    mockGetAirQuality.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5', 'european_aqi'],
    });
    const result = await openmeteoGetAirQualityTool.handler(input, ctx);

    expect(result.hourly).toHaveLength(2);
    // Exact position check for both records
    expect(result.hourly![0]).toEqual({
      time: '2026-05-30T00:00',
      pm2_5: 3.2,
      european_aqi: 10,
    });
    expect(result.hourly![1]).toEqual({
      time: '2026-05-30T01:00',
      pm2_5: 3.5,
      european_aqi: 11,
    });
    expect(result.data_source).toBe('CAMS');
    expect(result.hourly_units).toMatchObject({ pm2_5: 'μg/m³', european_aqi: 'EAQI' });
    expect(result.record_count).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.canvas_id).toBeUndefined();
    expect(result.table_name).toBeUndefined();
  });

  it('throws no_variables_requested with correct reason when hourly_variables not provided', async () => {
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
    });
    await expect(openmeteoGetAirQualityTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'no_variables_requested' },
    });
  });

  // --- timezone (#38) --------------------------------------------------------

  it('rejects a blank timezone before the network call (#38)', async () => {
    // openMeteoUrl omits an empty value, so a blank timezone used to fall through to
    // upstream's GMT default rather than the documented "auto".
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5'],
      timezone: '',
    });
    await expect(openmeteoGetAirQualityTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('timezone was blank'),
      data: {
        reason: 'invalid_timezone',
        recovery: { hint: expect.stringContaining('IANA') },
      },
    });
    expect(mockGetAirQuality).not.toHaveBeenCalled();
  });

  it('reclassifies the upstream Invalid timezone envelope away from invalid_variable (#38)', async () => {
    // Live upstream shape for an unknown zone: HTTP 400, {"reason":"Invalid timezone","error":true}.
    mockGetAirQuality.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason: 'Invalid timezone',
    });
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5'],
      timezone: 'Mars/Olympus',
    });
    await expect(openmeteoGetAirQualityTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('Open-Meteo rejected the requested timezone'),
      data: {
        reason: 'invalid_timezone',
        recovery: { hint: expect.stringContaining('auto') },
      },
    });
  });

  it('still defaults an omitted timezone to auto (#38)', async () => {
    mockGetAirQuality.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5'],
    });
    await openmeteoGetAirQualityTool.handler(input, ctx);
    expect(mockGetAirQuality).toHaveBeenCalledWith(
      47.6062,
      -122.3321,
      expect.objectContaining({ timezone: 'auto' }),
      ctx,
    );
  });

  it('passes a valid IANA zone through unchanged (#38)', async () => {
    mockGetAirQuality.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5'],
      timezone: 'America/Los_Angeles',
    });
    await openmeteoGetAirQualityTool.handler(input, ctx);
    expect(mockGetAirQuality).toHaveBeenCalledWith(
      47.6062,
      -122.3321,
      expect.objectContaining({ timezone: 'America/Los_Angeles' }),
      ctx,
    );
  });

  it('frames the upstream unknown-variable rejection with the offending name and recovery hint', async () => {
    // Real upstream reason shape from the live air-quality endpoint
    mockGetAirQuality.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason:
        "Data corrupted at path ''. Cannot initialize SurfacePressureAndHeightVariable<VariableAndPreviousDay, VariableOrSpread<ForecastPressureVariable>, ForecastHeightVariable> from invalid String value bogus_aqi.",
    });
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['bogus_aqi'],
    });
    await expect(openmeteoGetAirQualityTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringMatching(/^Unknown variable name: bogus_aqi\./),
      data: {
        reason: 'invalid_variable',
        recovery: { hint: expect.stringContaining('pm2_5') },
      },
    });
  });

  it('notices an all-null column upstream reported with unit "undefined"', async () => {
    // The endpoint shares the forecast API's hourly variable parser, so a weather
    // variable it does not serve comes back HTTP 200 with an all-null column rather
    // than an error.
    mockGetAirQuality.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: { time: 'iso8601', pm2_5: 'μg/m³', temperature_2m_max: 'undefined' },
      hourly: {
        time: ['2026-05-30T00:00', '2026-05-30T01:00'],
        pm2_5: [3.2, 3.5],
        temperature_2m_max: [null, null],
      },
    });
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5', 'temperature_2m_max'],
    });

    await openmeteoGetAirQualityTool.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toContain('temperature_2m_max returned no data');
    expect(getEnrichment(ctx).notice).toContain('openmeteo_get_forecast');
  });

  it('stays quiet when every requested column carries a real unit', async () => {
    mockGetAirQuality.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5', 'european_aqi'],
    });

    await openmeteoGetAirQualityTool.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('always includes data_source: CAMS in output regardless of variables requested', async () => {
    mockGetAirQuality.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5'],
    });
    const result = await openmeteoGetAirQualityTool.handler(input, ctx);
    expect(result.data_source).toBe('CAMS');
  });

  // --- Time window: forecast_days / past_days / date range -------------------

  it('rejects forecast_days above the upstream cap of 7', () => {
    expect(() =>
      openmeteoGetAirQualityTool.input.parse({
        latitude: 47.6062,
        longitude: -122.3321,
        hourly_variables: ['pm2_5'],
        forecast_days: 8,
      }),
    ).toThrow();
  });

  it('forwards forecast_days and past_days as the forecast window', async () => {
    mockGetAirQuality.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5'],
      forecast_days: 7,
      past_days: 7,
    });
    await openmeteoGetAirQualityTool.handler(input, ctx);

    expect(mockGetAirQuality).toHaveBeenCalledWith(
      47.6062,
      -122.3321,
      expect.objectContaining({ forecast_days: 7, past_days: 7 }),
      ctx,
    );
  });

  it('forwards a date pair as the archive window and sends no forecast_days/past_days', async () => {
    // past_days: 0 is the schema default, and upstream rejects it alongside a date
    // range as a mutually exclusive parameter — so neither may ride along.
    mockGetAirQuality.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5'],
      start_date: '2024-07-01',
      end_date: '2024-07-03',
    });
    await openmeteoGetAirQualityTool.handler(input, ctx);

    const params = mockGetAirQuality.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(params).toMatchObject({ start_date: '2024-07-01', end_date: '2024-07-03' });
    expect(params).not.toHaveProperty('forecast_days');
    expect(params).not.toHaveProperty('past_days');
  });

  it.each([
    ['start_date only', { start_date: '2024-07-01' }, 'start_date'],
    ['end_date only', { end_date: '2024-07-03' }, 'end_date'],
  ])('throws date_range_incomplete with %s', async (_label, dates, named) => {
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5'],
      ...dates,
    });
    await expect(openmeteoGetAirQualityTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining(named),
      data: {
        reason: 'date_range_incomplete',
        recovery: { hint: expect.stringContaining('end_date') },
      },
    });
    expect(mockGetAirQuality).not.toHaveBeenCalled();
  });

  it.each([
    [
      'forecast_days + a paired range',
      { forecast_days: 5, start_date: '2024-07-01', end_date: '2024-07-03' },
    ],
    ['forecast_days + a lone end_date', { forecast_days: 5, end_date: '2024-07-03' }],
    [
      'past_days + a paired range',
      { past_days: 3, start_date: '2024-07-01', end_date: '2024-07-03' },
    ],
  ])('throws forecast_window_conflict for %s', async (_label, window) => {
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5'],
      ...window,
    });
    await expect(openmeteoGetAirQualityTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'forecast_window_conflict',
        recovery: { hint: expect.stringContaining('start_date') },
      },
    });
    expect(mockGetAirQuality).not.toHaveBeenCalled();
  });

  it('throws date_order_invalid for a reversed archive range (#39)', async () => {
    // Upstream answers a reversed range with a bare `{"error":true,"reason":"Bad Request"}`,
    // which the post-call branch frames as an unknown variable name — advice that fixes
    // nothing. The three sibling tools already reject the pair locally.
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5'],
      start_date: '2024-07-02',
      end_date: '2024-07-01',
    });
    await expect(openmeteoGetAirQualityTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('end_date (2024-07-01) is before start_date (2024-07-02)'),
      data: {
        reason: 'date_order_invalid',
        recovery: { hint: 'Ensure end_date is on or after start_date.' },
      },
    });
    expect(mockGetAirQuality).not.toHaveBeenCalled();
  });

  it('accepts a single-day range where start_date equals end_date (#39)', async () => {
    // Confirmed live to still resolve upstream — the order check must not reject it.
    mockGetAirQuality.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5'],
      start_date: '2024-07-01',
      end_date: '2024-07-01',
    });
    await expect(openmeteoGetAirQualityTool.handler(input, ctx)).resolves.toMatchObject({
      truncated: false,
    });
    expect(mockGetAirQuality).toHaveBeenCalledWith(
      47.6062,
      -122.3321,
      expect.objectContaining({ start_date: '2024-07-01', end_date: '2024-07-01' }),
      ctx,
    );
  });

  it('reports the window conflict, not the order, when a reversed range rides a forecast window (#39)', async () => {
    // Validation order is unchanged: forecast_window_conflict still outranks the pair
    // checks, so a caller who supplied both windows hears about the choice they made.
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5'],
      forecast_days: 5,
      start_date: '2024-07-02',
      end_date: '2024-07-01',
    });
    await expect(openmeteoGetAirQualityTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'forecast_window_conflict' },
    });
  });

  it('past_days at its 0 default does not conflict with a date range', async () => {
    mockGetAirQuality.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5'],
      start_date: '2024-07-01',
      end_date: '2024-07-03',
    });
    await expect(openmeteoGetAirQualityTool.handler(input, ctx)).resolves.toMatchObject({
      truncated: false,
    });
  });

  it('preserves null values for an archive range that predates CAMS coverage', async () => {
    mockGetAirQuality.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: { time: ['2022-08-01T00:00', '2022-08-01T01:00'], pm2_5: [null, null] },
    });
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5'],
      start_date: '2022-08-01',
      end_date: '2022-08-01',
    });
    const result = await openmeteoGetAirQualityTool.handler(input, ctx);
    expect(result.hourly![0]?.pm2_5).toBeNull();
    expect(result.record_count).toBe(2);
    // #40: real unit, no values — the response has to say so, or a 2-record success
    // is indistinguishable from a populated one.
    expect(getEnrichment(ctx).notice).toContain('No hourly data for pm2_5');
  });

  // --- coverage gaps (#40) ---------------------------------------------------

  it('names the all-null variable and the partial one separately in the same response (#40)', async () => {
    // Live at 47.6062,-122.3321 for 2022-08-01…03: pm2_5 is null until
    // 2022-08-03T17:00 and carries values from there, while us_aqi has none in the
    // window at all. Both report the real units μg/m³ and USAQI.
    const time = hourlyTimes(72, '2022-08-01T00:00');
    mockGetAirQuality.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: { time: 'iso8601', pm2_5: 'μg/m³', us_aqi: 'USAQI' },
      hourly: {
        time,
        pm2_5: time.map((_, row) => (row < 65 ? null : 4.1 + row / 100)),
        us_aqi: time.map(() => null),
      },
    });
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const result = await openmeteoGetAirQualityTool.handler(
      openmeteoGetAirQualityTool.input.parse({
        latitude: 47.6062,
        longitude: -122.3321,
        hourly_variables: ['pm2_5', 'us_aqi'],
        start_date: '2022-08-01',
        end_date: '2022-08-03',
      }),
      ctx,
    );

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('Partial hourly coverage for pm2_5');
    expect(notice).toContain(`data runs ${time[65]} to ${time[71]}`);
    expect(notice).toContain('65 of 72 rows are null');
    expect(notice).toContain('No hourly data for us_aqi');
    expect(notice).toContain('units are real');
    // record_count reports rows, not non-null values.
    expect(result.record_count).toBe(72);
  });

  it('stays quiet about coverage when every requested variable carries data (#40)', async () => {
    mockGetAirQuality.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    await openmeteoGetAirQualityTool.handler(
      openmeteoGetAirQualityTool.input.parse({
        latitude: 47.6062,
        longitude: -122.3321,
        hourly_variables: ['pm2_5', 'european_aqi'],
      }),
      ctx,
    );
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('leaves an unserved name to its own notice rather than reporting it twice (#40)', async () => {
    // A column upstream marked with the unit "undefined" is all-null by construction.
    // The unserved-name notice already names it; the coverage classifier skips it.
    mockGetAirQuality.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: { time: 'iso8601', pm2_5: 'μg/m³', temperature_2m_max: 'undefined' },
      hourly: {
        time: ['2026-05-30T00:00', '2026-05-30T01:00'],
        pm2_5: [3.2, 3.5],
        temperature_2m_max: [null, null],
      },
    });
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    await openmeteoGetAirQualityTool.handler(
      openmeteoGetAirQualityTool.input.parse({
        latitude: 47.6062,
        longitude: -122.3321,
        hourly_variables: ['pm2_5', 'temperature_2m_max'],
      }),
      ctx,
    );

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('temperature_2m_max returned no data');
    expect(notice).not.toContain('No hourly data for temperature_2m_max');
  });

  // --- inline size ceiling (#41) and canvas pointer (#44) --------------------

  const wideArchive = () => {
    const time = hourlyTimes(2232);
    const block: Record<string, (number | null)[] | string[]> = { time };
    const units: Record<string, string> = { time: 'iso8601' };
    for (const variable of [
      'pm2_5',
      'pm10',
      'ozone',
      'nitrogen_dioxide',
      'sulphur_dioxide',
      'carbon_monoxide',
      'dust',
      'european_aqi',
      'us_aqi',
    ]) {
      block[variable] = time.map((_, row) => 10.25 + (row % 40));
      units[variable] = 'μg/m³';
    }
    return { time, block, units };
  };

  const wideInput = () =>
    openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: [
        'pm2_5',
        'pm10',
        'ozone',
        'nitrogen_dioxide',
        'sulphur_dioxide',
        'carbon_monoxide',
        'dust',
        'european_aqi',
        'us_aqi',
      ],
      past_days: 92,
    });

  it('keeps both inline surfaces inside the ceiling when the spill stages (#41)', async () => {
    const { block, units } = wideArchive();
    mockGetAirQuality.mockResolvedValue({ ...MOCK_RESPONSE, hourly_units: units, hourly: block });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: 2232, tableName: 'spilled_aq41' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-aq-41' }) };

    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const result = await openmeteoGetAirQualityTool.handler(wideInput(), ctx);

    expect(result.truncated).toBe(true);
    expect(structuredSize(result, ctx)).toBeLessThanOrEqual(INLINE_CHARS);
    expect(firstText(openmeteoGetAirQualityTool.format!(result)).length).toBeLessThanOrEqual(
      INLINE_CHARS,
    );
  });

  it('keeps both inline surfaces inside the ceiling with canvas disabled (#41)', async () => {
    const { block, units } = wideArchive();
    mockGetAirQuality.mockResolvedValue({ ...MOCK_RESPONSE, hourly_units: units, hourly: block });
    mockCanvasInstance = undefined;

    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const result = await openmeteoGetAirQualityTool.handler(wideInput(), ctx);

    expect(result.truncated).toBe(true);
    expect(structuredSize(result, ctx)).toBeLessThanOrEqual(INLINE_CHARS);
    expect(firstText(openmeteoGetAirQualityTool.format!(result)).length).toBeLessThanOrEqual(
      INLINE_CHARS,
    );
  });

  it('names openmeteo_dataframe_describe before openmeteo_dataframe_query on both surfaces (#44)', async () => {
    const { block, units } = wideArchive();
    mockGetAirQuality.mockResolvedValue({ ...MOCK_RESPONSE, hourly_units: units, hourly: block });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: 2232, tableName: 'spilled_aq44' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-aq-44' }) };

    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const result = await openmeteoGetAirQualityTool.handler(wideInput(), ctx);

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('spilled_aq44');
    expect(notice.indexOf('openmeteo_dataframe_describe')).toBeGreaterThanOrEqual(0);
    expect(notice.indexOf('openmeteo_dataframe_describe')).toBeLessThan(
      notice.indexOf('openmeteo_dataframe_query'),
    );

    const text = firstText(openmeteoGetAirQualityTool.format!(result));
    expect(text.indexOf('openmeteo_dataframe_describe')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('openmeteo_dataframe_describe')).toBeLessThan(
      text.indexOf('openmeteo_dataframe_query'),
    );
  });

  it('keeps the unserved-column warning when the canvas pointer fires in the same call (#44)', async () => {
    const { time, block, units } = wideArchive();
    mockGetAirQuality.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: { ...units, temperature_2m_max: 'undefined' },
      hourly: { ...block, temperature_2m_max: time.map(() => null) },
    });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: 2232, tableName: 'spilled_aq44b' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-aq-44b' }) };

    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    await openmeteoGetAirQualityTool.handler(wideInput(), ctx);

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('temperature_2m_max returned no data');
    expect(notice).toContain('openmeteo_dataframe_describe');
  });

  // --- DataCanvas spillover --------------------------------------------------

  it('spills to DataCanvas and sets truncated=true when the payload exceeds the inline budget', async () => {
    const rows = 2232; // past_days: 92 on the air-quality endpoint
    const time = hourlyTimes(rows);
    mockGetAirQuality.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: {
        time,
        pm2_5: time.map((_, i) => 3 + (i % 40) / 10),
        european_aqi: time.map((_, i) => 10 + (i % 30)),
      },
    });

    const previewRows = [{ time: time[0], pm2_5: 3, european_aqi: 10 }];
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: rows, tableName: 'spilled_aq01' },
      previewRows,
    });

    const mockCanvas = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-aq-123' }) };
    mockCanvasInstance = mockCanvas;

    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5', 'european_aqi'],
      past_days: 92,
    });
    const result = await openmeteoGetAirQualityTool.handler(input, ctx);

    expect(mockCanvas.acquire).toHaveBeenCalled();
    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBe('canvas-aq-123');
    expect(result.table_name).toBe('spilled_aq01');
    expect(result.record_count).toBe(rows); // full staged total, not the preview length
    // The preview is selected here, against this server's inline ceiling, rather than
    // read off spillover()'s own buffer — the two measure rows in different currencies.
    expect(result.hourly?.length ?? 0).toBeGreaterThan(0);
    expect(result.hourly?.length ?? 0).toBeLessThan(rows);
    expect(result.hourly?.[0]).toMatchObject({ time: time[0] });
    expect(result.hourly).not.toEqual(previewRows);
    expect(result.data_source).toBe('CAMS');
  });

  it('passes the caller canvas_id through to acquire', async () => {
    const time = hourlyTimes(2232);
    mockGetAirQuality.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: { time, pm2_5: time.map((_, i) => 3 + (i % 40) / 10) },
    });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: time.length, tableName: 'spilled_reuse' },
      previewRows: [],
    });
    const acquire = vi.fn().mockResolvedValue({ canvasId: 'existingcv1' });
    mockCanvasInstance = { acquire };

    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5'],
      past_days: 92,
      canvas_id: 'existingcv1',
    });
    await openmeteoGetAirQualityTool.handler(input, ctx);
    expect(acquire).toHaveBeenCalledWith('existingcv1', ctx);
  });

  it('stages on its own budget decision rather than re-asking spillover (#41)', async () => {
    // spillover() measures rows by JSON length alone, where this server's ceiling also
    // charges the row separators and the wider markdown rendering. Handing it the same
    // budget would let it decline a set the ceiling already rejected and return the
    // whole thing inline under truncated: false — the overshoot the ceiling exists to
    // prevent. It is told to stage instead, and truncated follows the decision made here.
    const time = hourlyTimes(2232);
    mockGetAirQuality.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: { time, pm2_5: time.map((_, i) => 3 + (i % 40) / 10) },
    });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: time.length, tableName: 'spilled_aq02' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-aq-2' }) };

    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5'],
      past_days: 92,
    });
    const result = await openmeteoGetAirQualityTool.handler(input, ctx);

    const [opts] = mockSpillover.mock.calls[0] as [{ previewChars: number }];
    expect(opts.previewChars).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBe('canvas-aq-2');
    expect(result.table_name).toBe('spilled_aq02');
    expect(result.record_count).toBe(time.length);
  });

  it('returns inline without touching a canvas when the payload fits', async () => {
    mockGetAirQuality.mockResolvedValue(MOCK_RESPONSE);
    const acquire = vi.fn();
    mockCanvasInstance = { acquire };

    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5'],
      forecast_days: 7,
    });
    const result = await openmeteoGetAirQualityTool.handler(input, ctx);

    expect(result.truncated).toBe(false);
    expect(result.record_count).toBe(2);
    // A result that fits must not mint a canvas — an acquired-but-unused canvas
    // holds a per-tenant slot the caller never learns about.
    expect(acquire).not.toHaveBeenCalled();
    expect(mockSpillover).not.toHaveBeenCalled();
  });

  it('bounds the preview and sets truncated=true when the payload is oversized and canvas is disabled', async () => {
    const time = hourlyTimes(2232);
    mockGetAirQuality.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: {
        time,
        pm2_5: time.map((_, i) => 3 + (i % 40) / 10),
        european_aqi: time.map((_, i) => 10 + (i % 30)),
      },
    });
    mockCanvasInstance = undefined; // CANVAS_PROVIDER_TYPE=none

    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5', 'european_aqi'],
      past_days: 92,
    });
    const result = await openmeteoGetAirQualityTool.handler(input, ctx);

    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBeUndefined();
    expect(result.table_name).toBeUndefined();
    expect(mockSpillover).not.toHaveBeenCalled();
    expect(result.hourly!.length).toBeLessThan(time.length);
    expect(JSON.stringify(result.hourly).length).toBeLessThanOrEqual(rowBudgetFor(result));
    // record_count stays the full upstream total, not the preview length.
    expect(result.record_count).toBe(time.length);
  });

  // --- format() --------------------------------------------------------------

  it('formats output with CAMS source attribution', () => {
    const blocks = openmeteoGetAirQualityTool.format!({
      latitude: 47.6,
      longitude: -122.3,
      timezone: 'America/Los_Angeles',
      record_count: 1,
      hourly: [{ time: '2026-05-30T00:00', pm2_5: 3.2 }],
      hourly_units: { pm2_5: 'μg/m³' },
      data_source: 'CAMS',
      canvas_id: undefined,
      table_name: undefined,
      truncated: false,
    });
    expect(firstText(blocks)).toContain('CAMS');
    expect(firstText(blocks)).toContain('Open-Meteo.com');
  });

  it('formats truncated result with the canvas and table handles', () => {
    const text = firstText(
      openmeteoGetAirQualityTool.format!({
        latitude: 47.6,
        longitude: -122.3,
        timezone: 'America/Los_Angeles',
        record_count: 2232,
        hourly: [{ time: '2026-04-30T00:00', pm2_5: 3.2 }],
        hourly_units: { pm2_5: 'μg/m³' },
        data_source: 'CAMS',
        canvas_id: 'canvas-aq-123',
        table_name: 'spilled_aq01',
        truncated: true,
      }),
    );
    expect(text).toContain('canvas-aq-123');
    expect(text).toContain('spilled_aq01');
    expect(text).toContain('1 shown of 2232 total rows on canvas');
  });

  it('names the disabled canvas and the narrowing levers in the truncated no-canvas format()', () => {
    const text = firstText(
      openmeteoGetAirQualityTool.format!({
        latitude: 47.6,
        longitude: -122.3,
        timezone: 'America/Los_Angeles',
        record_count: 2232,
        hourly: [{ time: '2026-04-30T00:00', pm2_5: 3.2 }],
        hourly_units: { pm2_5: 'μg/m³' },
        data_source: 'CAMS',
        canvas_id: undefined,
        table_name: undefined,
        truncated: true,
      }),
    );
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
      pm2_5: 1000 + i,
    }));
    const text = firstText(
      openmeteoGetAirQualityTool.format!({
        latitude: 47.6,
        longitude: -122.3,
        timezone: 'America/Los_Angeles',
        record_count: 50,
        hourly,
        hourly_units: { pm2_5: 'μg/m³' },
        data_source: 'CAMS',
        canvas_id: undefined,
        table_name: undefined,
        truncated: false,
      }),
    );
    expect(text).toContain('### Hourly air quality (50 records)');
    expect(text).toContain('pm2_5: 1000');
    expect(text).toContain('pm2_5: 1049'); // last row — not sliced at 48
    expect(text).not.toMatch(/and \d+ more/);
  });
});
