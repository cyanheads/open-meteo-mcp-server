/**
 * @fileoverview Tests for openmeteo_get_marine tool.
 * @module tests/tools/get-marine.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoGetMarineTool } from '@/mcp-server/tools/definitions/get-marine.tool.js';
import { MARINE_MODEL_NAMES, MARINE_MODELS } from '@/mcp-server/tools/model-catalog.js';
import { renderNotice } from '@/mcp-server/tools/response-notice.js';
import { INLINE_CHARS, inlineBudget } from '@/mcp-server/tools/spill-utils.js';
import { firstText } from '../helpers/content.js';
import { rowBudgetFor, structuredSize } from '../helpers/inline-surface.js';
import { expectNoCanvasDisclosureOnce } from '../helpers/no-canvas.js';
import { type WireError, wireError } from '../helpers/wire-error.js';

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
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
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
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
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
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
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
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height', 'wave_period'],
    });

    await openmeteoGetMarineTool.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  // --- timezone (#38) --------------------------------------------------------

  it('rejects a blank timezone before the network call (#38)', async () => {
    // openMeteoUrl omits an empty value, so a blank timezone used to fall through to
    // upstream's GMT default rather than the documented "auto".
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height'],
      timezone: '',
    });
    await expect(wireError(openmeteoGetMarineTool, input)).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('timezone was blank'),
      data: {
        reason: 'invalid_timezone',
        recovery: { hint: expect.stringContaining('IANA') },
      },
    });
    expect(mockGetMarine).not.toHaveBeenCalled();
  });

  it('reclassifies the upstream Invalid timezone envelope away from invalid_variable (#38)', async () => {
    // Live upstream shape for an unknown zone: HTTP 400, {"reason":"Invalid timezone","error":true}.
    mockGetMarine.mockResolvedValue({ ...MOCK_RESPONSE, error: true, reason: 'Invalid timezone' });
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height'],
      timezone: 'Mars/Olympus',
    });
    await expect(wireError(openmeteoGetMarineTool, input)).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('Open-Meteo rejected the requested timezone'),
      data: {
        reason: 'invalid_timezone',
        recovery: { hint: expect.stringContaining('auto') },
      },
    });
  });

  it('still defaults an omitted timezone to auto (#38)', async () => {
    mockGetMarine.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height'],
    });
    await openmeteoGetMarineTool.handler(input, ctx);
    expect(mockGetMarine).toHaveBeenCalledWith(
      47.8,
      -122.5,
      expect.objectContaining({ timezone: 'auto' }),
      ctx,
    );
  });

  it('passes a valid IANA zone through unchanged (#38)', async () => {
    mockGetMarine.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height'],
      timezone: 'America/Los_Angeles',
    });
    await openmeteoGetMarineTool.handler(input, ctx);
    expect(mockGetMarine).toHaveBeenCalledWith(
      47.8,
      -122.5,
      expect.objectContaining({ timezone: 'America/Los_Angeles' }),
      ctx,
    );
  });

  it('frames the upstream unknown-variable rejection with the offending name and recovery hint', async () => {
    // Real upstream reason shape from the live marine endpoint
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason:
        'Invalid value: Cannot initialize SurfacePressureAndHeightVariable<VariableAndPreviousDay, VariableOrSpread<ForecastPressureVariable>, ForecastHeightVariable> from invalid String value bogus_wave.',
    });
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['bogus_wave'],
    });
    await expect(wireError(openmeteoGetMarineTool, input)).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringMatching(/^Unknown variable name: bogus_wave\./),
      data: {
        reason: 'invalid_variable',
        recovery: { hint: expect.stringContaining('wave_height') },
      },
    });
  });

  it('classifies the upstream too-much-data rejection as request_too_large (#50)', async () => {
    // A window wide enough to trip the volume limit: the names are all valid, so the
    // unknown-name framing pointed the caller at spelling rather than at narrowing.
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason:
        'Your API call requests too much data. Please reduce the number of variables, locations and/or weather models.',
    });
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height', 'wave_period'],
      past_days: 92,
    });
    const error = await wireError(openmeteoGetMarineTool, input);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'request_too_large',
        recovery: { hint: expect.stringContaining('Narrow the request') },
      },
    });
    expect(error.message).toContain('too much data at once');
    expect(error.message).toContain('fewer current_variables / hourly_variables / daily_variables');
    expect(error.message).not.toMatch(/exact Open-Meteo API name/);
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
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
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

  it('returns unchanged output for a call that names no current or unit input (#81)', async () => {
    // Characterization of both surfaces, so the additive inputs provably leave an
    // existing call's answer alone.
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily_units: { time: 'iso8601', wave_height_max: 'm' },
      daily: { time: ['2026-05-30'], wave_height_max: [1.2] },
    });
    const result = await runToolContract(openmeteoGetMarineTool, {
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height', 'wave_period'],
      daily_variables: ['wave_height_max'],
    });

    // Through a JSON round trip, as the wire carries it: undefined keys drop out.
    expect(JSON.parse(JSON.stringify(result.structuredContent))).toStrictEqual({
      latitude: 47.8,
      longitude: -122.5,
      timezone: 'America/Los_Angeles',
      record_count: 3,
      hourly: [
        { time: '2026-05-30T00:00', wave_height: 0.5, wave_period: 8.0 },
        { time: '2026-05-30T01:00', wave_height: 0.6, wave_period: 8.5 },
      ],
      daily: [{ time: '2026-05-30', wave_height_max: 1.2 }],
      hourly_units: { time: 'iso8601', wave_height: 'm', wave_period: 's' },
      daily_units: { time: 'iso8601', wave_height_max: 'm' },
      truncated: false,
    });
    expect(firstText(result.content)).toBe(
      [
        '## Marine conditions',
        '**Location:** 47.8, -122.5 | **Timezone:** America/Los_Angeles',
        '**Records:** 3 | **Truncated:** false',
        '',
        '**Hourly units:** time: iso8601 | wave_height: m | wave_period: s',
        '**Daily units:** time: iso8601 | wave_height_max: m',
        '',
        '### Daily marine summary',
        '**2026-05-30** — wave_height_max: 1.2',
        '',
        '### Hourly marine (2 records)',
        '**2026-05-30T00:00** — wave_height: 0.5 | wave_period: 8',
        '**2026-05-30T01:00** — wave_height: 0.6 | wave_period: 8.5',
        '',
        '_Weather data by Open-Meteo.com_',
      ].join('\n'),
    );
    expect(mockGetMarine.mock.calls[0]?.[2]).toEqual({
      hourly: ['wave_height', 'wave_period'],
      daily: ['wave_height_max'],
      past_days: 0,
      timezone: 'auto',
    });
  });

  // --- Time window: forecast_days / past_days / date range -------------------

  it('accepts forecast_days up to 16 and rejects 17, advertising the ceiling (#104)', async () => {
    // Live: forecast_days=17 answers HTTP 400 "Forecast days is invalid. Allowed range 0 to 16."
    expect(() =>
      openmeteoGetMarineTool.input.parse({
        latitude: 47.8,
        longitude: -122.5,
        hourly_variables: ['wave_height'],
        forecast_days: 16,
      }),
    ).not.toThrow();

    const error = await wireError(openmeteoGetMarineTool, {
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height'],
      forecast_days: 17,
    });
    expect(error.code).toBe(-32602);
    expect(error.message).toContain('forecast_days');
    expect(mockGetMarine).not.toHaveBeenCalled();

    const advertised = openmeteoGetMarineTool.input['~standard'].jsonSchema.input({
      target: 'draft-2020-12',
    }) as { properties: Record<string, { maximum?: number }> };
    expect(advertised.properties.forecast_days?.maximum).toBe(16);
  });

  it('forwards forecast_days and past_days as the forecast window', async () => {
    mockGetMarine.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
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
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
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
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height'],
      ...dates,
    });
    await expect(wireError(openmeteoGetMarineTool, input)).resolves.toMatchObject({
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
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height'],
      ...window,
    });
    await expect(wireError(openmeteoGetMarineTool, input)).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'forecast_window_conflict',
        recovery: { hint: expect.stringContaining('start_date') },
      },
    });
    expect(mockGetMarine).not.toHaveBeenCalled();
  });

  it('throws date_order_invalid for a reversed archive range (#39)', async () => {
    // Upstream answers a reversed range with a bare `{"error":true,"reason":"Bad Request"}`,
    // which the post-call branch frames as an unknown variable name — advice that fixes
    // nothing. The three sibling tools already reject the pair locally.
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height'],
      start_date: '2024-07-02',
      end_date: '2024-07-01',
    });
    await expect(wireError(openmeteoGetMarineTool, input)).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('end_date (2024-07-01) is before start_date (2024-07-02)'),
      data: {
        reason: 'date_order_invalid',
        recovery: { hint: 'Ensure end_date is on or after start_date.' },
      },
    });
    expect(mockGetMarine).not.toHaveBeenCalled();
  });

  it('accepts a single-day range where start_date equals end_date (#39)', async () => {
    // Confirmed live to still resolve upstream — the order check must not reject it.
    mockGetMarine.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height'],
      start_date: '2024-07-01',
      end_date: '2024-07-01',
    });
    await expect(openmeteoGetMarineTool.handler(input, ctx)).resolves.toMatchObject({
      truncated: false,
    });
    expect(mockGetMarine).toHaveBeenCalledWith(
      47.8,
      -122.5,
      expect.objectContaining({ start_date: '2024-07-01', end_date: '2024-07-01' }),
      ctx,
    );
  });

  it('reports the window conflict, not the order, when a reversed range rides a forecast window (#39)', async () => {
    // Validation order is unchanged: forecast_window_conflict still outranks the pair
    // checks, so a caller who supplied both windows hears about the choice they made.
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height'],
      forecast_days: 7,
      start_date: '2024-07-02',
      end_date: '2024-07-01',
    });
    await expect(openmeteoGetMarineTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'forecast_window_conflict' },
    });
  });

  it('past_days at its 0 default does not conflict with a date range', async () => {
    mockGetMarine.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
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

    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: rows + 1, tableName: 'spilled_marine01' },
      previewRows: [
        { time: time[0], wave_height: 1, wave_period: 8 },
        { time: '2026-04-30', wave_height_max: 2.4 },
      ],
    });

    const mockCanvas = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-marine-1' }) };
    mockCanvasInstance = mockCanvas;

    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
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
    // The preview is bounded from the source records rather than read off
    // spillover()'s previewRows: both cadences carry rows, inside one budget.
    expect(result.hourly?.[0]).toMatchObject({ time: time[0] });
    expect(result.daily).toEqual([{ time: '2026-04-30', wave_height_max: 2.4 }]);
    expect(
      JSON.stringify(result.hourly ?? []).length + JSON.stringify(result.daily ?? []).length,
    ).toBeLessThanOrEqual(rowBudgetFor(result));
  });

  it('carries daily rows in the canvas-branch preview of a wide hourly window (#36)', async () => {
    /*
     * The live repro: 9 hourly variables over past_days 92 + forecast_days 8 serves
     * 2,400 hourly rows against 100 daily. spillover() drains its previewRows from the
     * head of the concatenated set, so every one of them is hourly — splitting them by
     * timestamp shape returned an empty daily summary while the staged table held all
     * 100 daily rows.
     */
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
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: time.length + dailyTime.length, tableName: 'spilled_marine_mix' },
      previewRows: time.slice(0, 300).map((t) => ({ time: t, wave_height: 1 })),
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-marine-mix' }) };

    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
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
    expect(result.canvas_id).toBe('canvas-marine-mix');
    expect(result.daily?.length ?? 0).toBeGreaterThan(0);
    expect(result.daily?.[0]).toMatchObject({ time: dailyTime[0], wave_height_max: 2 });
    expect(result.hourly?.length ?? 0).toBeGreaterThan(0);
    // One shared budget across both cadences.
    expect(
      JSON.stringify(result.hourly ?? []).length + JSON.stringify(result.daily ?? []).length,
    ).toBeLessThanOrEqual(rowBudgetFor(result));
    expect(result.record_count).toBe(time.length + dailyTime.length);

    const text = firstText(openmeteoGetMarineTool.format!(result));
    expect(text).toContain('### Daily marine summary (preview —');
    expect(text).toContain(`of ${time.length + dailyTime.length} total rows on canvas`);
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
    const acquire = vi.fn().mockResolvedValue({ canvasId: 'existCv001' });
    mockCanvasInstance = { acquire };

    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height'],
      past_days: 92,
      canvas_id: 'existCv001',
    });
    await openmeteoGetMarineTool.handler(input, ctx);
    expect(acquire).toHaveBeenCalledWith('existCv001', ctx);
  });

  it('stages on its own budget decision rather than re-asking spillover (#41)', async () => {
    // spillover() measures rows by JSON length alone, where this server's ceiling also
    // charges the row separators and the wider markdown rendering. Handing it the same
    // budget would let it decline a set the ceiling already rejected and return the
    // whole thing inline under truncated: false — the overshoot the ceiling exists to
    // prevent. It is told to stage instead, and truncated follows the decision made here.
    const time = hourlyTimes(2232);
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: { time, wave_height: time.map((_, i) => 1 + (i % 30) / 10) },
    });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: time.length, tableName: 'spilled_marine02' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-marine-2' }) };

    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height'],
      past_days: 92,
    });
    const result = await openmeteoGetMarineTool.handler(input, ctx);

    const [opts] = mockSpillover.mock.calls[0] as [{ previewChars: number }];
    expect(opts.previewChars).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBe('canvas-marine-2');
    expect(result.table_name).toBe('spilled_marine02');
    expect(result.record_count).toBe(time.length);
  });

  it('returns inline without touching a canvas when the payload fits', async () => {
    mockGetMarine.mockResolvedValue(MOCK_RESPONSE);
    const acquire = vi.fn();
    mockCanvasInstance = { acquire };

    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
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

    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
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
    expect(JSON.stringify(result.hourly).length).toBeLessThanOrEqual(rowBudgetFor(result));
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

    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
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
    ).toBeLessThanOrEqual(rowBudgetFor(result));
    expect(result.record_count).toBe(time.length + dailyTime.length);

    // format() renders the daily section the empty array used to gate away.
    const text = firstText(openmeteoGetMarineTool.format!(result));
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
    expect(firstText(blocks)).toContain('Marine');
    expect(firstText(blocks)).toContain('Open-Meteo.com');
  });

  it('formats truncated result with the canvas and table handles', () => {
    const text = firstText(
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
      }),
    );
    expect(text).toContain('canvas-marine-1');
    expect(text).toContain('spilled_marine01');
    expect(text).toContain('1 shown of 2232 total rows on canvas');
  });

  it('names the disabled canvas and the narrowing levers in the truncated no-canvas format()', () => {
    const text = firstText(
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
      }),
    );
    // The short line only (#55) — the full disclosure reaches content[] via the notice trailer.
    expect(text).toContain('bounded preview only; no canvas_id (DataCanvas disabled)');
    expect(text).not.toContain('CANVAS_PROVIDER_TYPE');
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
    const text = firstText(
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
      }),
    );
    expect(text).toContain('### Hourly marine (50 records)');
    expect(text).toContain('wave_height: 1000');
    expect(text).toContain('wave_height: 1049'); // last row — not sliced at 48
    expect(text).not.toMatch(/and \d+ more/);
  });

  // --- inline size ceiling (#41), canvas pointer (#44), coverage gaps (#40) ---

  /** A 92-day past_days window: nine hourly wave variables plus a daily summary. */
  const wideWindow = () => {
    const hourlyTime = hourlyTimes(2400);
    const dailyTime = Array.from({ length: 100 }, (_, i) => {
      const d = new Date('2026-04-30T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    });
    const hourly: Record<string, (number | null)[] | string[]> = { time: hourlyTime };
    const hourlyUnits: Record<string, string> = { time: 'iso8601' };
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
      hourly[variable] = hourlyTime.map((_, row) => 1 + (row % 30) / 10);
      hourlyUnits[variable] = 'm';
    }
    const daily: Record<string, (number | null)[] | string[]> = {
      time: dailyTime,
      wave_height_max: dailyTime.map((_, row) => 2 + (row % 15) / 10),
      wave_direction_dominant: dailyTime.map((_, row) => 90 + (row % 40)),
    };
    return {
      hourly,
      hourlyUnits,
      daily,
      dailyUnits: { time: 'iso8601', wave_height_max: 'm', wave_direction_dominant: '°' },
    };
  };

  const wideInput = () =>
    openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: [
        'wave_height',
        'wave_direction',
        'wave_period',
        'wind_wave_height',
        'wind_wave_direction',
        'wind_wave_period',
        'swell_wave_height',
        'swell_wave_direction',
        'swell_wave_period',
      ],
      daily_variables: ['wave_height_max', 'wave_direction_dominant'],
      past_days: 92,
    });

  it('keeps both inline surfaces inside the ceiling when the spill stages (#41)', async () => {
    const { hourly, hourlyUnits, daily, dailyUnits } = wideWindow();
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: hourlyUnits,
      daily_units: dailyUnits,
      hourly,
      daily,
    });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: 2500, tableName: 'spilled_ma41' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-ma-41' }) };

    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const result = await openmeteoGetMarineTool.handler(wideInput(), ctx);

    expect(result.truncated).toBe(true);
    expect(structuredSize(result, ctx)).toBeLessThanOrEqual(INLINE_CHARS);
    expect(firstText(openmeteoGetMarineTool.format!(result)).length).toBeLessThanOrEqual(
      INLINE_CHARS,
    );
  });

  it('keeps both inline surfaces inside the ceiling with canvas disabled (#41)', async () => {
    const { hourly, hourlyUnits, daily, dailyUnits } = wideWindow();
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: hourlyUnits,
      daily_units: dailyUnits,
      hourly,
      daily,
    });
    mockCanvasInstance = undefined;

    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const result = await openmeteoGetMarineTool.handler(wideInput(), ctx);

    expect(result.truncated).toBe(true);
    expect(structuredSize(result, ctx)).toBeLessThanOrEqual(INLINE_CHARS);
    expect(firstText(openmeteoGetMarineTool.format!(result)).length).toBeLessThanOrEqual(
      INLINE_CHARS,
    );
  });

  it('names openmeteo_dataframe_describe before openmeteo_dataframe_query on both surfaces (#44)', async () => {
    const { hourly, hourlyUnits, daily, dailyUnits } = wideWindow();
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: hourlyUnits,
      daily_units: dailyUnits,
      hourly,
      daily,
    });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: 2500, tableName: 'spilled_ma44' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-ma-44' }) };

    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const result = await openmeteoGetMarineTool.handler(wideInput(), ctx);

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('spilled_ma44');
    expect(notice.indexOf('openmeteo_dataframe_describe')).toBeGreaterThanOrEqual(0);
    expect(notice.indexOf('openmeteo_dataframe_describe')).toBeLessThan(
      notice.indexOf('openmeteo_dataframe_query'),
    );

    const text = firstText(openmeteoGetMarineTool.format!(result));
    expect(text.indexOf('openmeteo_dataframe_describe')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('openmeteo_dataframe_describe')).toBeLessThan(
      text.indexOf('openmeteo_dataframe_query'),
    );
  });

  it('keeps the unserved-column warning when the canvas pointer fires in the same call (#44)', async () => {
    const { hourly, hourlyUnits, daily, dailyUnits } = wideWindow();
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: { ...hourlyUnits, sea_surface_temperature: 'undefined' },
      daily_units: dailyUnits,
      hourly: {
        ...hourly,
        sea_surface_temperature: (hourly.time as string[]).map(() => null),
      },
      daily,
    });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: 2500, tableName: 'spilled_ma44b' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-ma-44b' }) };

    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    await openmeteoGetMarineTool.handler(wideInput(), ctx);

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('sea_surface_temperature returned no data');
    expect(notice).toContain('openmeteo_dataframe_describe');
  });

  it('reports a variable the coordinate carries no values for (#40)', async () => {
    // ocean_current_velocity is null for a coordinate that is not open ocean, with a
    // real unit — a real coverage gap the unserved-name check cannot see.
    const time = hourlyTimes(48);
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: { time: 'iso8601', wave_height: 'm', ocean_current_velocity: 'km/h' },
      hourly: {
        time,
        wave_height: time.map((_, row) => 0.5 + (row % 8) / 10),
        ocean_current_velocity: time.map(() => null),
      },
    });

    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const result = await openmeteoGetMarineTool.handler(
      openmeteoGetMarineTool.input.parse({
        latitude: 47.8,
        longitude: -122.5,
        hourly_variables: ['wave_height', 'ocean_current_velocity'],
      }),
      ctx,
    );

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('No hourly data for ocean_current_velocity');
    expect(notice).not.toContain('wave_height');
    expect(result.record_count).toBe(48);
  });

  it('names the location, not only the window, for an all-null land point (#63)', async () => {
    // Live at 46.6021,-120.5059 (inland Washington): daily wave_height_max comes back
    // as 7 nulls under the real unit m. The window is fine — the point is on land.
    const time = Array.from({ length: 7 }, (_, i) => `2026-10-${String(12 + i).padStart(2, '0')}`);
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: undefined,
      hourly_units: undefined,
      daily_units: { time: 'iso8601', wave_height_max: 'm' },
      daily: { time, wave_height_max: time.map(() => null) },
    });

    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const result = await openmeteoGetMarineTool.handler(
      openmeteoGetMarineTool.input.parse({
        latitude: 46.6021,
        longitude: -120.5059,
        daily_variables: ['wave_height_max'],
      }),
      ctx,
    );

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('No daily data for wave_height_max');
    expect(notice).toContain('the default blend has no data for this location or window');
    expect(notice).toContain(
      'A point on land or under sea ice has no wave data from any model, so there the remedy is a coordinate in open water.',
    );
    expect(result.daily?.every((row) => row.wave_height_max === null)).toBe(true);
  });

  it('tells sheltered water (near-zero waves) apart from a land point (null) (#63)', () => {
    const latitude = openmeteoGetMarineTool.input.shape.latitude.description ?? '';
    for (const text of [openmeteoGetMarineTool.description, latitude]) {
      expect(text).toMatch(/sheltered water[^.]*near-zero/i);
      expect(text).toMatch(/land point[^.]*null/i);
      expect(text).not.toMatch(/inland points return near-zero/i);
    }
  });

  // --- no-canvas disclosure (#51), unrequested cadence (#53) -----------------

  const stageOnCanvas = (rowCount: number) => {
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount, tableName: 'spilled_ma53' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-ma-53' }) };
  };

  it.each([
    ['canvas enabled', true],
    ['canvas disabled', false],
  ])('omits daily on a truncated hourly-only request — %s (#53)', async (_label, canvasEnabled) => {
    const { hourly, hourlyUnits } = wideWindow();
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: hourlyUnits,
      hourly,
      daily_units: undefined,
      daily: undefined,
    });
    if (canvasEnabled) stageOnCanvas(2400);
    else mockCanvasInstance = undefined;

    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const result = await openmeteoGetMarineTool.handler(
      openmeteoGetMarineTool.input.parse({
        latitude: 47.8,
        longitude: -122.5,
        hourly_variables: ['wave_height', 'wave_period'],
        past_days: 92,
      }),
      ctx,
    );

    expect(result.truncated).toBe(true);
    expect(result.daily).toBeUndefined();
    expect(result.hourly?.length ?? 0).toBeGreaterThan(0);
    expect(firstText(openmeteoGetMarineTool.format!(result))).not.toContain(
      '### Daily marine summary',
    );
  });

  it.each([
    ['canvas enabled', true],
    ['canvas disabled', false],
  ])('omits hourly on a truncated daily-only request — %s (#53)', async (_label, canvasEnabled) => {
    // An archive range back to 2022 across the daily wave summary: ~1,460 rows.
    const time = Array.from({ length: 1460 }, (_, i) => {
      const d = new Date('2022-01-01T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    });
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: undefined,
      hourly: undefined,
      daily_units: {
        time: 'iso8601',
        wave_height_max: 'm',
        wave_direction_dominant: '°',
        wave_period_max: 's',
      },
      daily: {
        time,
        wave_height_max: time.map((_, i) => 2 + (i % 15) / 10),
        wave_direction_dominant: time.map((_, i) => 90 + (i % 40)),
        wave_period_max: time.map((_, i) => 9 + (i % 6)),
      },
    });
    if (canvasEnabled) stageOnCanvas(time.length);
    else mockCanvasInstance = undefined;

    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const result = await openmeteoGetMarineTool.handler(
      openmeteoGetMarineTool.input.parse({
        latitude: 36.8,
        longitude: -75.0,
        daily_variables: ['wave_height_max', 'wave_direction_dominant', 'wave_period_max'],
        start_date: '2022-01-01',
        end_date: '2025-12-31',
      }),
      ctx,
    );

    expect(result.truncated).toBe(true);
    expect(result.hourly).toBeUndefined();
    expect(result.daily?.length ?? 0).toBeGreaterThan(0);
    expect(firstText(openmeteoGetMarineTool.format!(result))).not.toContain('### Hourly marine');
  });

  it('discloses the disabled canvas in the notice and once across content[] (#51, #55)', async () => {
    const { hourly, hourlyUnits, daily, dailyUnits } = wideWindow();
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: hourlyUnits,
      daily_units: dailyUnits,
      hourly,
      daily,
    });
    mockCanvasInstance = undefined; // CANVAS_PROVIDER_TYPE=none

    const result = await runToolContract(openmeteoGetMarineTool, wideInput());

    expectNoCanvasDisclosureOnce(result, 'fewer past_days / forecast_days');
  });
});

describe('openmeteoGetMarineTool current conditions (#81)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasInstance = undefined;
    mockSpillover.mockResolvedValue({ spilled: false, previewRows: [] });
  });

  /** Live shape at 46.9,-124.6 (off the Washington coast): marine current, interval 900. */
  const CURRENT_BLOCK = {
    current_units: {
      time: 'iso8601',
      interval: 'seconds',
      wave_height: 'm',
      wave_period: 's',
      sea_surface_temperature: '°C',
    },
    current: {
      time: '2026-10-23T23:15',
      interval: 900,
      wave_height: 1.86,
      wave_period: 9.3,
      sea_surface_temperature: 12.2,
    },
  };

  /** A response envelope with no hourly or daily block — what a current-only call returns. */
  const CURRENT_ONLY = {
    latitude: 46.875,
    longitude: -124.62499,
    elevation: 0,
    utc_offset_seconds: -28800,
    timezone: 'Etc/GMT+8',
    timezone_abbreviation: 'GMT-8',
    generationtime_ms: 0.2,
    ...CURRENT_BLOCK,
  };

  const run = async (input: Record<string, unknown>, upstream: object) => {
    mockGetMarine.mockResolvedValue(upstream);
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const parsed = openmeteoGetMarineTool.input.parse({
      latitude: 46.9,
      longitude: -124.6,
      ...input,
    });
    const result = await openmeteoGetMarineTool.handler(parsed, ctx);
    return { ctx, result, params: mockGetMarine.mock.calls[0]?.[2] as Record<string, unknown> };
  };

  it('accepts a current-only call and returns current with interval 900 and current_units', async () => {
    const { result, params } = await run(
      { current_variables: ['wave_height', 'wave_period', 'sea_surface_temperature'] },
      CURRENT_ONLY,
    );

    expect(params.current).toEqual(['wave_height', 'wave_period', 'sea_surface_temperature']);
    expect(params.hourly).toBeUndefined();
    expect(params.daily).toBeUndefined();
    expect(result.hourly).toBeUndefined();
    expect(result.daily).toBeUndefined();
    expect(result.record_count).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.current).toEqual(CURRENT_BLOCK.current);
    expect(result.current_units).toEqual(CURRENT_BLOCK.current_units);
    // The output schema carries the requested variables through, not just time/interval.
    const parsed = openmeteoGetMarineTool.output.parse(result);
    expect(parsed.current).toEqual(CURRENT_BLOCK.current);
    expect(parsed.current?.interval).toBe(900);
  });

  it('drops blank current_variables entries and still requires a variable', async () => {
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 46.9,
      longitude: -124.6,
      current_variables: ['', '  '],
    });
    await expect(openmeteoGetMarineTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_variables_requested' },
    });
    expect(mockGetMarine).not.toHaveBeenCalled();
  });

  it('names current_variables in the no_variables_requested contract and message', async () => {
    const input = openmeteoGetMarineTool.input.parse({ latitude: 46.9, longitude: -124.6 });
    const error = await wireError(openmeteoGetMarineTool, input);
    expect(error).toMatchObject({ data: { reason: 'no_variables_requested' } });
    expect(error.message).toContain('current_variables');
    const contract = openmeteoGetMarineTool.errors?.find(
      (e) => e.reason === 'no_variables_requested',
    );
    expect(contract?.when).toContain('current_variables');
    expect(contract?.recovery).toContain('current_variables');
  });

  it('omits current and current_units, and sends no current, when not requested', async () => {
    const { result, params } = await run({ hourly_variables: ['wave_height'] }, MOCK_RESPONSE);
    expect(params).not.toHaveProperty('current', expect.anything());
    expect(result.current).toBeUndefined();
    expect(result.current_units).toBeUndefined();
    expect(firstText(openmeteoGetMarineTool.format!(result))).not.toContain('Current');
  });

  it('pairs current_variables with past_days on the forecast window', async () => {
    const { params, result } = await run(
      { current_variables: ['wave_height'], daily_variables: ['wave_height_max'], past_days: 2 },
      {
        ...CURRENT_ONLY,
        daily_units: { time: 'iso8601', wave_height_max: 'm' },
        daily: {
          time: ['2026-10-21', '2026-10-22', '2026-10-23'],
          wave_height_max: [1.76, 3.1, 3.1],
        },
      },
    );
    expect(params).toMatchObject({ current: ['wave_height'], past_days: 2 });
    expect(result.current?.time).toBe('2026-10-23T23:15');
    expect(result.daily).toHaveLength(3);
  });

  it('pairs current_variables with a date range on the archive window', async () => {
    const { params, result } = await run(
      {
        current_variables: ['wave_height'],
        daily_variables: ['wave_height_max'],
        start_date: '2024-07-01',
        end_date: '2024-07-02',
      },
      {
        ...CURRENT_ONLY,
        daily_units: { time: 'iso8601', wave_height_max: 'm' },
        daily: { time: ['2024-07-01', '2024-07-02'], wave_height_max: [1.56, 1.8] },
      },
    );
    expect(params).toMatchObject({
      current: ['wave_height'],
      start_date: '2024-07-01',
      end_date: '2024-07-02',
    });
    expect(params).not.toHaveProperty('past_days');
    // Upstream answers the present instant alongside the archive rows.
    expect(result.current?.time).toBe('2026-10-23T23:15');
    expect(result.daily?.map((row) => row.time)).toEqual(['2024-07-01', '2024-07-02']);
  });

  it('renders the current-conditions section without misreading interval as a variable', async () => {
    const { result } = await run(
      { current_variables: ['wave_height', 'wave_period', 'sea_surface_temperature'] },
      CURRENT_ONLY,
    );
    const text = firstText(openmeteoGetMarineTool.format!(result));
    expect(text).toContain('### Current conditions');
    expect(text).toContain(
      '**2026-10-23T23:15** (interval: 900s) — wave_height: 1.86 | wave_period: 9.3 | sea_surface_temperature: 12.2',
    );
    expect(text).toContain(
      '**Current units:** time: iso8601 | interval: seconds | wave_height: m | wave_period: s | sea_surface_temperature: °C',
    );
    expect(text).not.toContain('| interval: 900');
  });

  it('rejects a daily-only marine name in current_variables before the request', async () => {
    // Live: current=wave_height_max is an HTTP 400 whose reason calls the name an
    // invalid String value, which the post-call branch would frame as an unknown name.
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 46.9,
      longitude: -124.6,
      current_variables: ['wave_height', 'wave_height_max'],
    });
    const error = await wireError(openmeteoGetMarineTool, input);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'variable_wrong_cadence' },
    });
    expect(error.message).toContain(
      'wave_height_max is not valid in current_variables — Open-Meteo publishes it as a daily variable. Move it to daily_variables, or stay in current_variables with wave_height.',
    );
    expect(mockGetMarine).not.toHaveBeenCalled();
  });

  it('reports a non-marine current name through the "undefined"-unit notice, once', async () => {
    const { ctx, result } = await run(
      { current_variables: ['wave_height', 'temperature_2m'] },
      {
        ...CURRENT_ONLY,
        current_units: {
          time: 'iso8601',
          interval: 'seconds',
          wave_height: 'm',
          temperature_2m: 'undefined',
        },
        current: {
          time: '2026-10-23T23:15',
          interval: 900,
          wave_height: 1.86,
          temperature_2m: null,
        },
      },
    );
    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('temperature_2m returned no data');
    expect(notice.match(/temperature_2m/g)).toHaveLength(1);
    expect(notice).not.toContain('No current value');
    expect(result.current?.temperature_2m).toBeNull();
  });

  it('names a land point’s null current values on both surfaces', async () => {
    // Live at 46.0,-119.0 (inland): current wave_height and sea_surface_temperature
    // come back null under their real units.
    const current = {
      time: '2026-10-24T00:15',
      interval: 900,
      wave_height: null,
      sea_surface_temperature: null,
    };
    mockGetMarine.mockResolvedValue({
      ...CURRENT_ONLY,
      latitude: 46.041664,
      longitude: -119.04166,
      timezone: 'America/Los_Angeles',
      current_units: {
        time: 'iso8601',
        interval: 'seconds',
        wave_height: 'm',
        sea_surface_temperature: '°C',
      },
      current,
    });

    const result = await runToolContract(openmeteoGetMarineTool, {
      latitude: 46.0,
      longitude: -119.0,
      current_variables: ['wave_height', 'sea_surface_temperature'],
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      current: Record<string, unknown>;
      notice?: string;
    };
    expect(structured.notice).toContain(
      'No current value for wave_height, sea_surface_temperature — the values are null even though the units are real',
    );
    expect(structured.notice).not.toContain('interval');
    expect(structured.current).toEqual(current);
    const allText = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(allText).toContain('No current value for wave_height, sea_surface_temperature');
    expect(allText).toContain('wave_height: null | sea_surface_temperature: null');
  });

  it('adds no current-gap sentence for a fully populated current block', async () => {
    const { ctx } = await run({ current_variables: ['wave_height'] }, CURRENT_ONLY);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('keeps a wide current block inside the inline ceiling on both surfaces', async () => {
    const names = Array.from({ length: 50 }, (_, i) => `marine_variable_number_${i}`);
    const wideCurrent: Record<string, number | string> = {
      time: '2026-10-23T23:15',
      interval: 900,
    };
    const wideCurrentUnits: Record<string, string> = { time: 'iso8601', interval: 'seconds' };
    for (const [i, name] of names.entries()) {
      wideCurrent[name] = 10.5 + i;
      wideCurrentUnits[name] = 'm';
    }

    // Two hourly variables over 92 days: well past the row budget, so it is what bounds the rows.
    const time = hourlyTimes(24 * 92);
    const hourlyUnits = { time: 'iso8601', wave_height: 'm', wave_period: 's' };
    const { ctx, result } = await run(
      {
        current_variables: names,
        hourly_variables: ['wave_height', 'wave_period'],
        past_days: 92,
      },
      {
        ...MOCK_RESPONSE,
        current: wideCurrent,
        current_units: wideCurrentUnits,
        hourly_units: hourlyUnits,
        hourly: {
          time,
          wave_height: time.map((_, i) => 1 + (i % 11) / 10),
          wave_period: time.map((_, i) => 8 + (i % 7) / 10),
        },
      },
    );

    expect(result.truncated).toBe(true);
    expect(result.current).toEqual(wideCurrent);
    expect(result.current_units).toEqual(wideCurrentUnits);
    expect(structuredSize(result, ctx)).toBeLessThanOrEqual(INLINE_CHARS);
    expect(firstText(openmeteoGetMarineTool.format!(result)).length).toBeLessThanOrEqual(
      INLINE_CHARS,
    );
    /*
     * The rows were sized against what the current block and its units left, computed
     * here from the upstream payload rather than from the result — a handler that
     * leaves the block uncounted sizes the rows thousands of characters larger. Rows are
     * measured as the budget measures them: serialized length plus one per key, plus one.
     */
    const { rowBudget } = inlineBudget(wideCurrent, hourlyUnits, undefined, wideCurrentUnits);
    const rowCost = (result.hourly ?? []).reduce(
      (chars, row) => chars + JSON.stringify(row).length + Object.keys(row).length + 1,
      0,
    );
    expect(rowCost).toBeGreaterThan(rowBudget - 100);
    expect(rowCost).toBeLessThanOrEqual(rowBudget + 100);
  });

  it('describes current.interval as a 900-second aggregation interval, never an update cadence', () => {
    const interval =
      openmeteoGetMarineTool.output.shape.current.unwrap().shape.interval.description ?? '';
    expect(interval).toMatch(/aggregation interval/i);
    expect(interval).toContain('900');
    expect(interval).not.toMatch(/cadence|how often|refresh|updates?\b/i);
  });
});

describe('openmeteoGetMarineTool unit inputs (#81)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasInstance = undefined;
    mockSpillover.mockResolvedValue({ spilled: false, previewRows: [] });
  });

  const callWith = async (units: Record<string, unknown>, upstream: object = MOCK_RESPONSE) => {
    mockGetMarine.mockResolvedValue(upstream);
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const result = await openmeteoGetMarineTool.handler(
      openmeteoGetMarineTool.input.parse({
        latitude: 46.9,
        longitude: -124.6,
        hourly_variables: ['wave_height'],
        ...units,
      }),
      ctx,
    );
    return { result, params: mockGetMarine.mock.calls[0]?.[2] as Record<string, unknown> };
  };

  it('forwards non-default length, speed, and temperature units', async () => {
    const { params } = await callWith({
      length_unit: 'imperial',
      wind_speed_unit: 'kn',
      temperature_unit: 'fahrenheit',
    });
    expect(params).toMatchObject({
      length_unit: 'imperial',
      wind_speed_unit: 'kn',
      temperature_unit: 'fahrenheit',
    });
  });

  it.each([
    ['omitted', {}],
    [
      'set to the defaults',
      { length_unit: 'metric', wind_speed_unit: 'kmh', temperature_unit: 'celsius' },
    ],
  ])('sends no unit parameter when the units are %s', async (_label, units) => {
    const { params } = await callWith(units);
    expect(params.length_unit).toBeUndefined();
    expect(params.wind_speed_unit).toBeUndefined();
    expect(params.temperature_unit).toBeUndefined();
  });

  it.each([
    ['length_unit', 'furlong'],
    ['wind_speed_unit', 'knots'],
    ['temperature_unit', 'kelvin'],
  ])('rejects %s=%s at the schema and never calls upstream', async (field, value) => {
    const parsed = openmeteoGetMarineTool.input.safeParse({
      latitude: 46.9,
      longitude: -124.6,
      hourly_variables: ['wave_height'],
      [field]: value,
    });
    // An enum rejection on the field itself, not an unknown-key rejection of it.
    expect(parsed.error?.issues).toMatchObject([{ code: 'invalid_value', path: [field] }]);
    const result = await runToolContract(openmeteoGetMarineTool, {
      latitude: 46.9,
      longitude: -124.6,
      hourly_variables: ['wave_height'],
      [field]: value,
    });
    expect(result.isError).toBe(true);
    expect(mockGetMarine).not.toHaveBeenCalled();
  });

  it('labels every surface with the units upstream returned (ft, kn, °F, mp/h) — nothing converted', async () => {
    // Live units for length_unit=imperial, wind_speed_unit=mph, temperature_unit=fahrenheit.
    const upstream = {
      ...MOCK_RESPONSE,
      current_units: {
        time: 'iso8601',
        interval: 'seconds',
        wave_height: 'ft',
        ocean_current_velocity: 'mp/h',
        sea_surface_temperature: '°F',
      },
      current: {
        time: '2026-10-23T23:15',
        interval: 900,
        wave_height: 6.102,
        ocean_current_velocity: 0.6,
        sea_surface_temperature: 54.0,
      },
      hourly_units: { time: 'iso8601', wave_height: 'ft', wave_period: 's' },
      hourly: { time: ['2026-10-23T23:00'], wave_height: [6.168], wave_period: [9.25] },
      daily_units: { time: 'iso8601', wave_height_max: 'ft', wave_period_max: 's' },
      daily: { time: ['2026-10-23'], wave_height_max: [10.171], wave_period_max: [9.25] },
    };
    mockGetMarine.mockResolvedValue(upstream);
    const result = await runToolContract(openmeteoGetMarineTool, {
      latitude: 46.9,
      longitude: -124.6,
      current_variables: ['wave_height', 'ocean_current_velocity', 'sea_surface_temperature'],
      hourly_variables: ['wave_height', 'wave_period'],
      daily_variables: ['wave_height_max', 'wave_period_max'],
      length_unit: 'imperial',
      wind_speed_unit: 'mph',
      temperature_unit: 'fahrenheit',
    });

    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.current_units).toEqual(upstream.current_units);
    expect(structured.hourly_units).toEqual(upstream.hourly_units);
    expect(structured.daily_units).toEqual(upstream.daily_units);
    expect(structured.current).toEqual(upstream.current);
    expect((structured.hourly as Record<string, unknown>[])[0]?.wave_height).toBe(6.168);
    expect((structured.daily as Record<string, unknown>[])[0]?.wave_height_max).toBe(10.171);
    const text = firstText(result.content);
    expect(text).toContain('ocean_current_velocity: mp/h');
    expect(text).toContain('sea_surface_temperature: °F');
    expect(text).toContain('**Hourly units:** time: iso8601 | wave_height: ft | wave_period: s');
    expect(text).toContain(
      '**Daily units:** time: iso8601 | wave_height_max: ft | wave_period_max: s',
    );
    expect(text).toContain('wave_height: 6.102');
  });

  it('asserts no fixed height unit in any output description', () => {
    const descriptions = Object.values(openmeteoGetMarineTool.output.shape).map(
      (field) => field.description ?? '',
    );
    expect(descriptions.length).toBeGreaterThan(5);
    for (const text of descriptions) expect(text).not.toMatch(/\bmeters?\b|\bmetres?\b/i);
  });
});

describe('openmeteoGetMarineTool models and the 16-day window (#104)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasInstance = undefined;
    mockSpillover.mockResolvedValue({ spilled: false, previewRows: [] });
  });

  const MID_ATLANTIC = { latitude: 45, longitude: -30 };

  it('names the default blend in the description with the straight apostrophe its other strings use', () => {
    expect(openmeteoGetMarineTool.description).toContain(
      "With models omitted the data is Open-Meteo's best_match blend",
    );
    expect(openmeteoGetMarineTool.description).not.toContain('’');
  });

  /** Live: no wave model has data at −90, 0, and the default blend has none at −60, 0 where ecmwf_wam does. */
  const NO_WAVE_DATA =
    'A point on land or under sea ice has no wave data from any model, so there the remedy is a coordinate in open water.';

  /** The live all-null shape at a point the call's wave data does not reach, one day hourly. */
  const allNullHourly = (column: string) => {
    const time = hourlyTimes(24, '2026-11-18T00:00');
    return {
      ...MOCK_RESPONSE,
      hourly_units: { time: 'iso8601', [column]: 'm' },
      hourly: { time, [column]: time.map(() => null) },
    };
  };

  it('declares a coverage_gap recovery that claims no model reaches the point', () => {
    const recovery = openmeteoGetMarineTool.errors?.find(
      (entry) => entry.reason === 'coverage_gap',
    )?.recovery;
    expect(recovery).toBe(
      `${NO_WAVE_DATA} For a point in open water, name a model in models: the default blend has gaps a single wave model can fill. Retrying returns the same response.`,
    );
  });

  it('sends an all-null default blend to a single model, and a point without wave data to open water', async () => {
    mockGetMarine.mockResolvedValue(allNullHourly('wave_height'));

    const result = await runToolContract(openmeteoGetMarineTool, {
      latitude: -60,
      longitude: 0,
      hourly_variables: ['wave_height'],
      forecast_days: 1,
    });

    expect(noticeOf(result)).toBe(
      `No hourly data for wave_height anywhere in the requested window — all 24 values are null even though the units are real, so the default blend has no data for this location or window. ${NO_WAVE_DATA} For a point in open water, name a model in models: the default blend has gaps a single wave model can fill.`,
    );
  });

  it('follows the remedy of an all-null model with the point no model covers', async () => {
    mockGetMarine.mockResolvedValue(allNullHourly('wave_height'));

    const result = await runToolContract(openmeteoGetMarineTool, {
      latitude: -90,
      longitude: 0,
      hourly_variables: ['wave_height'],
      forecast_days: 1,
      models: ['ecmwf_wam'],
    });

    expect(noticeOf(result)).toBe(
      `No hourly data for wave_height anywhere in the requested window — all 24 values are null even though the units are real, so this location or the requested window falls outside this dataset’s coverage, or ecmwf_wam does not carry it. Try another model, or omit models to use the default. ${NO_WAVE_DATA}`,
    );
  });

  /** The upstream params the handler sent on its one call. */
  const sentParams = () => mockGetMarine.mock.calls[0]?.[2] as Record<string, unknown>;

  /** Every text block of a result, joined — the notice trailer is its own block. */
  const allText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');

  /** The notice on both surfaces: structuredContent as composed, content[] as rendered. */
  const noticeOf = (result: Awaited<ReturnType<typeof runToolContract>>) => {
    const notice = (result.structuredContent as { notice?: string }).notice ?? '';
    expect(allText(result)).toContain(renderNotice(notice));
    return notice;
  };

  /**
   * The live 16-day default-blend shape at 45, −30: 384 hourly and 16 daily rows, with
   * wave_height data through 2026-11-26T23:00 (216 rows) and wave_height_max through
   * 2026-11-26 (9 rows), every later row null under the real unit.
   */
  const sixteenDayBlend = () => {
    const time = hourlyTimes(384, '2026-11-18T00:00');
    const days = time.filter((_, i) => i % 24 === 0).map((t) => t.slice(0, 10));
    return {
      ...MOCK_RESPONSE,
      latitude: 45.041664,
      longitude: -30.041656,
      timezone: 'GMT',
      hourly_units: { time: 'iso8601', wave_height: 'm' },
      hourly: { time, wave_height: time.map((_, i) => (i < 216 ? 6.24 - (i % 30) / 10 : null)) },
      daily_units: { time: 'iso8601', wave_height_max: 'm' },
      daily: { time: days, wave_height_max: days.map((_, i) => (i < 9 ? 6.48 - i / 10 : null)) },
    };
  };

  const SIXTEEN_DAY_NOTICE =
    'Partial hourly coverage for wave_height: data runs 2026-11-18T00:00 to 2026-11-26T23:00, and 168 of 384 rows are null. Partial daily coverage for wave_height_max: data runs 2026-11-18 to 2026-11-26, and 7 of 16 rows are null.';

  it('reports the default blend’s null tail past its horizon on both surfaces, through the existing coverage notice', async () => {
    mockGetMarine.mockResolvedValue(sixteenDayBlend());

    const result = await runToolContract(openmeteoGetMarineTool, {
      ...MID_ATLANTIC,
      hourly_variables: ['wave_height'],
      daily_variables: ['wave_height_max'],
    });

    expect(result.isError).toBeFalsy();
    expect(noticeOf(result)).toBe(SIXTEEN_DAY_NOTICE);
    expect((result.structuredContent as { record_count: number }).record_count).toBe(400);
  });

  it('names a non-marine name in the no-models unserved-column sentence, exactly', async () => {
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: { time: 'iso8601', wave_height: 'm', temperature_2m: 'undefined' },
      hourly: {
        time: ['2026-05-30T00:00', '2026-05-30T01:00'],
        wave_height: [0.5, 0.6],
        temperature_2m: [null, null],
      },
    });

    const result = await runToolContract(openmeteoGetMarineTool, {
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height', 'temperature_2m'],
    });

    expect(noticeOf(result)).toBe(
      'temperature_2m returned no data — Open-Meteo reported the unit as "undefined", which means the marine endpoint does not serve that name. Check it against the marine variable list (wave_height, wave_period, swell_wave_height, sea_surface_temperature, …); weather variables belong in openmeteo_get_forecast.',
    );
  });

  it('answers forecast_days: 16 with all 384 hourly rows and the null-tail notice on both surfaces', async () => {
    mockGetMarine.mockResolvedValue(sixteenDayBlend());

    const result = await runToolContract(openmeteoGetMarineTool, {
      ...MID_ATLANTIC,
      hourly_variables: ['wave_height'],
      daily_variables: ['wave_height_max'],
      forecast_days: 16,
    });

    expect(result.isError).toBeFalsy();
    expect(sentParams()).toMatchObject({ forecast_days: 16, past_days: 0 });
    expect(sentParams().models).toBeUndefined();
    const structured = result.structuredContent as { hourly: unknown[]; daily: unknown[] };
    expect(structured.hourly).toHaveLength(384);
    expect(structured.daily).toHaveLength(16);
    // Serialized, as the wire carries it: an undefined value leaves no key behind.
    expect(JSON.parse(JSON.stringify(structured))).not.toHaveProperty('models');
    expect(noticeOf(result)).toBe(SIXTEEN_DAY_NOTICE);
  });

  /**
   * Live shape for models=ecmwf_wam,ncep_gfswave016,ewam at 45, −30: ewam (Europe only) is
   * dropped without a word, every remaining key carries its model, and ecmwf_wam answers
   * swell_wave_height with the unit "undefined" over nulls.
   */
  const THREE_MODELS = ['ecmwf_wam', 'ncep_gfswave016', 'ewam'];
  const THREE_MODEL_RESPONSE = {
    ...MOCK_RESPONSE,
    latitude: 44.956062,
    longitude: -29.99997,
    timezone: 'GMT',
    hourly_units: {
      time: 'iso8601',
      wave_height_ecmwf_wam: 'm',
      swell_wave_height_ecmwf_wam: 'undefined',
      wave_height_ncep_gfswave016: 'm',
      swell_wave_height_ncep_gfswave016: 'm',
    },
    hourly: {
      time: ['2026-11-18T00:00', '2026-11-18T01:00'],
      wave_height_ecmwf_wam: [6.48, 6.58],
      swell_wave_height_ecmwf_wam: [null, null],
      wave_height_ncep_gfswave016: [6.28, 6.44],
      swell_wave_height_ncep_gfswave016: [0.88, 0.86],
    },
    daily_units: {
      time: 'iso8601',
      wave_height_max_ecmwf_wam: 'm',
      wave_height_max_ncep_gfswave016: 'm',
    },
    daily: {
      time: ['2026-11-18'],
      wave_height_max_ecmwf_wam: [6.84],
      wave_height_max_ncep_gfswave016: [6.56],
    },
  };

  it('forwards models and echoes them, naming the dropped model and the one that serves no swell, on both surfaces', async () => {
    mockGetMarine.mockResolvedValue(THREE_MODEL_RESPONSE);

    const result = await runToolContract(openmeteoGetMarineTool, {
      ...MID_ATLANTIC,
      hourly_variables: ['wave_height', 'swell_wave_height'],
      daily_variables: ['wave_height_max'],
      forecast_days: 16,
      models: THREE_MODELS,
    });

    expect(result.isError).toBeFalsy();
    expect(sentParams().models).toEqual(THREE_MODELS);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.models).toEqual(THREE_MODELS);
    expect(structured.latitude).toBe(44.956062);
    expect(structured.hourly).toEqual([
      {
        time: '2026-11-18T00:00',
        wave_height_ecmwf_wam: 6.48,
        swell_wave_height_ecmwf_wam: null,
        wave_height_ncep_gfswave016: 6.28,
        swell_wave_height_ncep_gfswave016: 0.88,
      },
      {
        time: '2026-11-18T01:00',
        wave_height_ecmwf_wam: 6.58,
        swell_wave_height_ecmwf_wam: null,
        wave_height_ncep_gfswave016: 6.44,
        swell_wave_height_ncep_gfswave016: 0.86,
      },
    ]);
    expect(structured.daily_units).toEqual(THREE_MODEL_RESPONSE.daily_units);
    expect(noticeOf(result)).toBe(
      'swell_wave_height_ecmwf_wam returned no data — Open-Meteo reported the unit as "undefined", which on a model-suffixed column means that model does not serve the variable: ecmwf_wam does not serve swell_wave_height. Read it from a model that serves it. Open-Meteo returned no columns for ewam — it leaves a requested model out of the response when it has no data at this coordinate (typically a regional model outside its domain), so this response compares only ecmwf_wam, ncep_gfswave016.',
    );

    const text = firstText(result.content);
    expect(text).toContain('**Models:** ecmwf_wam, ncep_gfswave016, ewam\n');
    expect(text).toContain('wave_height_max_ncep_gfswave016: 6.56');
    expect(text).toContain('swell_wave_height_ecmwf_wam: undefined');
  });

  it('counts best_match’s _marine_best_match columns as its own, with no dropped-model notice', async () => {
    // Live shape for models=best_match,ecmwf_wam at 45, −30.
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: {
        time: 'iso8601',
        wave_height_marine_best_match: 'm',
        wave_height_ecmwf_wam: 'm',
      },
      hourly: {
        time: ['2026-11-18T00:00', '2026-11-18T01:00'],
        wave_height_marine_best_match: [6.24, 6.32],
        wave_height_ecmwf_wam: [6.48, 6.58],
      },
    });

    const result = await runToolContract(openmeteoGetMarineTool, {
      ...MID_ATLANTIC,
      hourly_variables: ['wave_height'],
      models: ['best_match', 'ecmwf_wam'],
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('calls the plain columns of a 2-model request unattributable', async () => {
    // Live shape for models=ewam,gwam at 45, −30: ewam dropped, gwam's columns plain.
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: { time: 'iso8601', wave_height: 'm' },
      hourly: { time: ['2026-11-18T00:00', '2026-11-18T01:00'], wave_height: [5.56, 5.6] },
    });

    const result = await runToolContract(openmeteoGetMarineTool, {
      ...MID_ATLANTIC,
      hourly_variables: ['wave_height'],
      models: ['ewam', 'gwam'],
    });

    expect(noticeOf(result)).toBe(
      'wave_height came back without a model suffix although 2 models were requested (ewam, gwam) — Open-Meteo leaves out a requested model that has no data at this coordinate (typically a regional model outside its domain), and the columns of the one left carry plain names, so these values are unattributable: they come from one of ewam, gwam, and the response does not say which. Request one model at a time to attribute them.',
    );
  });

  it('puts an archive range’s all-null columns on the model that returned them empty', async () => {
    // Live shape for models=era5_ocean,ecmwf_wam over 2024-07-01..02 at 45, −30: ecmwf_wam's
    // record starts in November 2025, so its columns are null under the real unit.
    const time = hourlyTimes(48, '2024-07-01T00:00');
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: { time: 'iso8601', wave_height_era5_ocean: 'm', wave_height_ecmwf_wam: 'm' },
      hourly: {
        time,
        wave_height_era5_ocean: time.map((_, i) => 1.12 + (i % 10) / 50),
        wave_height_ecmwf_wam: time.map(() => null),
      },
      daily_units: {
        time: 'iso8601',
        wave_height_max_era5_ocean: 'm',
        wave_height_max_ecmwf_wam: 'm',
      },
      daily: {
        time: ['2024-07-01', '2024-07-02'],
        wave_height_max_era5_ocean: [1.52, 1.5],
        wave_height_max_ecmwf_wam: [null, null],
      },
    });

    const result = await runToolContract(openmeteoGetMarineTool, {
      ...MID_ATLANTIC,
      hourly_variables: ['wave_height'],
      daily_variables: ['wave_height_max'],
      start_date: '2024-07-01',
      end_date: '2024-07-02',
      models: ['era5_ocean', 'ecmwf_wam'],
    });

    expect(sentParams()).toMatchObject({
      start_date: '2024-07-01',
      end_date: '2024-07-02',
      models: ['era5_ocean', 'ecmwf_wam'],
    });
    expect(noticeOf(result)).toBe(
      'ecmwf_wam returned no hourly data for wave_height_ecmwf_wam — all 48 values are null, while era5_ocean returned values for the same variable. Read it from era5_ocean. ecmwf_wam returned no daily data for wave_height_max_ecmwf_wam — all 2 values are null, while era5_ocean returned values for the same variable. Read it from era5_ocean.',
    );
  });

  it('names the selected model as a cause of an "undefined" unit on a single-model call', async () => {
    // Live: models=ecmwf_wam answers ocean_current_velocity with a plain column, unit "undefined".
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: { time: 'iso8601', wave_height: 'm', ocean_current_velocity: 'undefined' },
      hourly: {
        time: ['2026-11-18T00:00', '2026-11-18T01:00'],
        wave_height: [6.48, 6.58],
        ocean_current_velocity: [null, null],
      },
    });

    const result = await runToolContract(openmeteoGetMarineTool, {
      ...MID_ATLANTIC,
      hourly_variables: ['wave_height', 'ocean_current_velocity'],
      models: ['ecmwf_wam'],
    });

    expect(noticeOf(result)).toBe(
      'ocean_current_velocity returned no data — Open-Meteo reported the unit as "undefined", which means the marine endpoint does not serve that name, or the selected model (ecmwf_wam) does not serve it. Check it against the marine variable list (wave_height, wave_period, swell_wave_height, sea_surface_temperature, …); weather variables belong in openmeteo_get_forecast. Read a marine name that model does not serve from another model, or omit models.',
    );
    expect(firstText(result.content)).toContain('**Models:** ecmwf_wam\n');
  });

  it('names the one model left as a cause of an "undefined" unit on a plain column of a 2-model call', async () => {
    // ewam (Europe only) dropped at 45, −30, meteofrance_currents left: it serves no waves.
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: { time: 'iso8601', wave_height: 'undefined' },
      hourly: { time: ['2026-11-18T00:00', '2026-11-18T01:00'], wave_height: [null, null] },
    });

    const result = await runToolContract(openmeteoGetMarineTool, {
      ...MID_ATLANTIC,
      hourly_variables: ['wave_height'],
      models: ['ewam', 'meteofrance_currents'],
    });

    expect(noticeOf(result)).toContain(
      'wave_height returned no data — Open-Meteo reported the unit as "undefined", which means the marine endpoint does not serve that name, or the one model left in the response (one of ewam, meteofrance_currents) does not serve it.',
    );
  });

  it.each([
    [['best_match'], 'the selected model (best_match)'],
    [
      ['best_match', 'ecmwf_wam'],
      'the one model left in the response (one of best_match, ecmwf_wam)',
    ],
  ])(
    'leaves omitting models out of an "undefined" unit on a plain column when models %j holds the default blend',
    async (models, answered) => {
      // Omitting models reads best_match, which either answered this call or was left out of
      // the response for having no data at the coordinate: neither reads the name anew.
      mockGetMarine.mockResolvedValue({
        ...MOCK_RESPONSE,
        hourly_units: { time: 'iso8601', wave_height: 'm', ocean_current_velocity: 'undefined' },
        hourly: {
          time: ['2026-11-18T00:00', '2026-11-18T01:00'],
          wave_height: [6.48, 6.58],
          ocean_current_velocity: [null, null],
        },
      });

      const result = await runToolContract(openmeteoGetMarineTool, {
        ...MID_ATLANTIC,
        hourly_variables: ['wave_height', 'ocean_current_velocity'],
        models,
      });

      const notice = noticeOf(result);
      expect(notice).toContain(
        `ocean_current_velocity returned no data — Open-Meteo reported the unit as "undefined", which means the marine endpoint does not serve that name, or ${answered} does not serve it. Check it against the marine variable list (wave_height, wave_period, swell_wave_height, sea_surface_temperature, …); weather variables belong in openmeteo_get_forecast. Read a marine name that model does not serve from another model.`,
      );
      expect(notice).not.toContain('omit models');
    },
  );

  it('names one model named twice as the selected model for an "undefined" unit on its plain current column', async () => {
    // A model named twice suffixes the hourly column, as live for models=ecmwf_wam,ecmwf_wam,
    // while the current block stays unsuffixed — ocean_current_velocity under "undefined".
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: { time: 'iso8601', wave_height_ecmwf_wam: 'm' },
      hourly: {
        time: ['2026-11-18T00:00', '2026-11-18T01:00'],
        wave_height_ecmwf_wam: [6.66, 6.8],
      },
      current_units: { time: 'iso8601', interval: 'seconds', ocean_current_velocity: 'undefined' },
      current: { time: '2026-11-18T04:15', interval: 900, ocean_current_velocity: null },
    });

    const result = await runToolContract(openmeteoGetMarineTool, {
      ...MID_ATLANTIC,
      current_variables: ['ocean_current_velocity'],
      hourly_variables: ['wave_height'],
      models: ['ecmwf_wam', 'ecmwf_wam'],
    });

    expect(noticeOf(result)).toContain(
      'ocean_current_velocity returned no data — Open-Meteo reported the unit as "undefined", which means the marine endpoint does not serve that name, or the selected model (ecmwf_wam) does not serve it. Check it against the marine variable list (wave_height, wave_period, swell_wave_height, sea_surface_temperature, …); weather variables belong in openmeteo_get_forecast. Read a marine name that model does not serve from another model, or omit models.',
    );
  });

  it('offers fewer models in the units-trimmed notice of a multi-model call', async () => {
    // Every marine model over 50 hourly and 50 daily names: a suffixed unit map wide
    // enough to pass the units ceiling.
    const models = MARINE_MODELS.map((m) => m.name);
    const named = (cadence: string) =>
      Array.from({ length: 50 }, (_, i) =>
        `${cadence}_variable_${String(i).padStart(2, '0')}`.padEnd(60, '_x'),
      );
    const block = (variables: string[], time: string) => {
      const columns = variables.flatMap((v) =>
        models.map((m) => `${v}_${m === 'best_match' ? 'marine_best_match' : m}`),
      );
      return {
        units: Object.fromEntries([['time', 'iso8601'], ...columns.map((c) => [c, 'm'])]),
        data: Object.fromEntries([['time', [time]], ...columns.map((c) => [c, [1]])]),
      };
    };
    const [hourlyVariables, dailyVariables] = [named('hourly'), named('daily')];
    const hourly = block(hourlyVariables, '2026-11-18T00:00');
    const daily = block(dailyVariables, '2026-11-18');
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: hourly.units,
      hourly: hourly.data,
      daily_units: daily.units,
      daily: daily.data,
    });

    const result = await runToolContract(openmeteoGetMarineTool, {
      ...MID_ATLANTIC,
      hourly_variables: hourlyVariables,
      daily_variables: dailyVariables,
      models,
    });

    expect(noticeOf(result)).toMatch(
      /\d+ unit entries were omitted to keep this response within its inline size ceiling — the units map is incomplete\. Units are not staged on the canvas, so re-run with a narrower column set to see them all: fewer current_variables \/ hourly_variables \/ daily_variables, or fewer models\./,
    );
  });

  it('rejects current_variables with two models before any request (current_multi_model)', async () => {
    const error = await wireError(openmeteoGetMarineTool, {
      ...MID_ATLANTIC,
      current_variables: ['wave_height'],
      hourly_variables: ['wave_height'],
      models: ['ecmwf_wam', 'ncep_gfswave016'],
    });

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'current_multi_model',
        recovery: { hint: expect.stringContaining('at most one model') },
      },
    });
    expect(error.message).toContain('2 models (ecmwf_wam, ncep_gfswave016)');
    expect(mockGetMarine).not.toHaveBeenCalled();
  });

  it('rejects current_variables with two models as current_multi_model before a misplaced current name', async () => {
    // wave_height_max is filed under daily alone, so at current it is also a cadence fault.
    const error = await wireError(openmeteoGetMarineTool, {
      ...MID_ATLANTIC,
      current_variables: ['wave_height_max'],
      models: ['ecmwf_wam', 'ncep_gfswave016'],
    });

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'current_multi_model' },
    });
    expect(mockGetMarine).not.toHaveBeenCalled();
  });

  it.each([
    ['named twice', ['ecmwf_wam', 'ecmwf_wam']],
    ['repeated inside one element', ['ecmwf_wam,ecmwf_wam']],
  ])('answers current_variables beside one model %s, in one request', async (_, models) => {
    // The two live shapes for models=ecmwf_wam,ecmwf_wam at 45, −30, combined: the current
    // block unsuffixed, and the hourly block as one wave_height_ecmwf_wam column.
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: { time: 'iso8601', wave_height_ecmwf_wam: 'm' },
      hourly: {
        time: ['2026-11-18T00:00', '2026-11-18T01:00'],
        wave_height_ecmwf_wam: [6.66, 6.8],
      },
      current_units: { time: 'iso8601', interval: 'seconds', wave_height: 'm' },
      current: { time: '2026-11-18T04:15', interval: 900, wave_height: 6.5 },
    });

    const result = await runToolContract(openmeteoGetMarineTool, {
      ...MID_ATLANTIC,
      current_variables: ['wave_height'],
      hourly_variables: ['wave_height'],
      models,
    });

    expect(result.isError).toBeFalsy();
    expect(mockGetMarine).toHaveBeenCalledTimes(1);
    expect(sentParams()).toMatchObject({
      current: ['wave_height'],
      models: ['ecmwf_wam', 'ecmwf_wam'],
    });
    const wire = JSON.parse(JSON.stringify(result.structuredContent)) as Record<string, unknown>;
    expect(wire).toMatchObject({
      current: { wave_height: 6.5 },
      hourly: [{ wave_height_ecmwf_wam: 6.66 }, { wave_height_ecmwf_wam: 6.8 }],
    });
    expect(wire).not.toHaveProperty('notice');
    expect(allText(result)).not.toMatch(
      /returned no columns|without a model suffix|unattributable/,
    );
  });

  it('accepts current_variables with one model and forwards both', async () => {
    // Live shape for current=wave_height,wave_period&models=ncep_gfswave016 at 45, −30.
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: undefined,
      hourly_units: undefined,
      current_units: { time: 'iso8601', interval: 'seconds', wave_height: 'm', wave_period: 's' },
      current: { time: '2026-11-18T03:45', interval: 900, wave_height: 6.54, wave_period: 11.75 },
    });

    const result = await runToolContract(openmeteoGetMarineTool, {
      ...MID_ATLANTIC,
      current_variables: ['wave_height', 'wave_period'],
      models: ['ncep_gfswave016'],
    });

    expect(result.isError).toBeFalsy();
    expect(sentParams()).toMatchObject({
      current: ['wave_height', 'wave_period'],
      models: ['ncep_gfswave016'],
    });
    expect((result.structuredContent as { current: unknown }).current).toMatchObject({
      wave_height: 6.54,
    });
  });

  it('frames an unknown model as a variable-or-model rejection and lists the marine models', async () => {
    mockGetMarine.mockResolvedValue({
      error: true,
      reason: 'Invalid value: Cannot initialize MultiDomains from invalid String value bogus_model',
    });

    const error = await wireError(openmeteoGetMarineTool, {
      ...MID_ATLANTIC,
      hourly_variables: ['wave_height'],
      models: ['ecmwf_wam', 'bogus_model'],
    });

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_variable');
    expect(error.message).toMatch(/^Unknown variable or model name: bogus_model\./);
    expect(error.data?.recovery?.hint).toContain(`Documented models: ${MARINE_MODEL_NAMES}.`);
  });

  it('keeps the variable-only hint for an unknown name when models is omitted', async () => {
    mockGetMarine.mockResolvedValue({
      error: true,
      reason:
        'Invalid value: Cannot initialize SurfacePressureAndHeightVariable<VariableAndPreviousDay, VariableOrSpread<ForecastPressureVariable>, ForecastHeightVariable> from invalid String value bogus_wave.',
    });

    const result = await runToolContract(openmeteoGetMarineTool, {
      ...MID_ATLANTIC,
      hourly_variables: ['bogus_wave'],
    });
    const error = (result.structuredContent as { error: WireError }).error;

    expect(error.message).toMatch(/^Unknown variable name: bogus_wave\./);
    expect(error.data?.recovery?.hint).toBe(
      'Check variable names against Open-Meteo marine docs. Common: wave_height, wave_direction, wave_period, wind_wave_height, swell_wave_height, wave_height_max.',
    );
    expect(allText(result)).not.toContain('Documented models');
  });

  it.each([
    ['two models', ['ecmwf_wam', 'gwam'], true],
    ['no models', undefined, false],
  ])(
    'names fewer models as a lever on the volume rejection only with %s',
    async (_label, models, named) => {
      mockGetMarine.mockResolvedValue({
        error: true,
        reason:
          'Your API call requests too much data. Please reduce the number of variables, locations and/or weather models.',
      });

      const error = await wireError(openmeteoGetMarineTool, {
        ...MID_ATLANTIC,
        hourly_variables: ['wave_height'],
        past_days: 92,
        ...(models && { models }),
      });

      expect(error.data?.reason).toBe('request_too_large');
      expect(error.message.includes('daily_variables, or fewer models.')).toBe(named);
    },
  );

  it('offers fewer models as a lever in the canvas-less preview of a wide multi-model window', async () => {
    const models = ['ecmwf_wam', 'ncep_gfswave025', 'gwam'];
    const variables = ['wave_height', 'wave_period', 'wave_direction', 'swell_wave_height'];
    const time = hourlyTimes(16 * 24, '2026-11-18T00:00');
    const hourly: Record<string, (number | null)[] | string[]> = { time };
    const hourlyUnits: Record<string, string> = { time: 'iso8601' };
    for (const variable of variables) {
      for (const model of models) {
        hourly[`${variable}_${model}`] = time.map((_, i) => 100.5 + (i % 17));
        hourlyUnits[`${variable}_${model}`] = 'm';
      }
    }
    mockGetMarine.mockResolvedValue({ ...MOCK_RESPONSE, hourly_units: hourlyUnits, hourly });

    const result = await runToolContract(openmeteoGetMarineTool, {
      ...MID_ATLANTIC,
      hourly_variables: variables,
      forecast_days: 16,
      models,
    });

    expectNoCanvasDisclosureOnce(result, 'daily_variables, or fewer models');
  });

  it('caps models at the documented marine model count, and treats a blank list as omitted', async () => {
    const parse = (count: number) =>
      openmeteoGetMarineTool.input.safeParse({
        ...MID_ATLANTIC,
        hourly_variables: ['wave_height'],
        models: Array.from({ length: count }, (_, i) => `m${i}`),
      }).success;
    expect(parse(MARINE_MODELS.length)).toBe(true);
    expect(parse(MARINE_MODELS.length + 1)).toBe(false);

    mockGetMarine.mockResolvedValue(MOCK_RESPONSE);
    const result = await runToolContract(openmeteoGetMarineTool, {
      ...MID_ATLANTIC,
      hourly_variables: ['wave_height'],
      models: ['', ' '],
    });
    expect(sentParams().models).toBeUndefined();
    expect(JSON.stringify(result.structuredContent)).not.toContain('"models"');
  });
});
