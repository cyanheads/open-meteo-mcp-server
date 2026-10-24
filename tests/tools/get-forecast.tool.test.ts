/**
 * @fileoverview Tests for openmeteo_get_forecast tool.
 * @module tests/tools/get-forecast.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoGetForecastTool } from '@/mcp-server/tools/definitions/get-forecast.tool.js';
import { FORECAST_MODELS } from '@/mcp-server/tools/model-catalog.js';
import { INLINE_CHARS } from '@/mcp-server/tools/spill-utils.js';
import { firstText } from '../helpers/content.js';
import { rowBudgetFor, structuredSize } from '../helpers/inline-surface.js';
import { expectNoCanvasDisclosureOnce } from '../helpers/no-canvas.js';
import { type WireError, wireError } from '../helpers/wire-error.js';

const mockGetForecast = vi.fn();
const mockSpillover = vi.fn();

vi.mock('@/services/open-meteo/open-meteo-service.js', () => ({
  getOpenMeteoService: () => ({ getForecast: mockGetForecast }),
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
const hourlyTimes = (count: number, from = '2026-03-01T00:00'): string[] =>
  Array.from({ length: count }, (_, i) => {
    const d = new Date(from);
    d.setHours(d.getHours() + i);
    return d.toISOString().slice(0, 16);
  });

/**
 * A 12-variable hourly block — the width that makes a 108-day window overflow.
 * `nullsBefore` leaves that many leading rows all-null, the shape the forecast API
 * returns when `past_days` reaches further back than it serves.
 */
const wideHourlyBlock = (
  time: string[],
  nullsBefore = 0,
): Record<string, (number | null)[] | string[]> => {
  const block: Record<string, (number | null)[] | string[]> = { time };
  for (const variable of [
    'temperature_2m',
    'precipitation',
    'wind_speed_10m',
    'relative_humidity_2m',
    'cloud_cover',
    'uv_index',
    'apparent_temperature',
    'dew_point_2m',
    'surface_pressure',
    'visibility',
    'wind_gusts_10m',
    'wind_direction_10m',
  ]) {
    block[variable] = time.map((_, i) => (i < nullsBefore ? null : 100.5 + (i % 17)));
  }
  return block;
};

/** Verbatim upstream reason for a request wider than the endpoint serves in one call. */
const TOO_MUCH_DATA_REASON =
  'Your API call requests too much data. Please reduce the number of variables, locations and/or weather models.';

const MOCK_RESPONSE = {
  latitude: 47.595562,
  longitude: -122.32443,
  elevation: 59.0,
  utc_offset_seconds: -25200,
  timezone: 'America/Los_Angeles',
  timezone_abbreviation: 'GMT-7',
  generationtime_ms: 0.2,
  hourly_units: { time: 'iso8601', temperature_2m: '°C', precipitation: 'mm' },
  hourly: {
    time: ['2026-05-30T00:00', '2026-05-30T01:00'],
    temperature_2m: [10.1, 9.4],
    precipitation: [0.0, 0.0],
  },
};

describe('openmeteoGetForecastTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasInstance = undefined; // reset canvas to disabled state
    // Default spillover mock: fit result (no spill) — overridden per test
    mockSpillover.mockResolvedValue({
      spilled: false,
      previewRows: [],
    });
  });

  it('reshapes columnar response into per-timestamp records', async () => {
    mockGetForecast.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m', 'precipitation'],
    });
    const result = await openmeteoGetForecastTool.handler(input, ctx);

    expect(result.hourly).toHaveLength(2);
    expect(result.hourly![0]).toMatchObject({
      time: '2026-05-30T00:00',
      temperature_2m: 10.1,
      precipitation: 0.0,
    });
    expect(result.hourly_units).toEqual({
      time: 'iso8601',
      temperature_2m: '°C',
      precipitation: 'mm',
    });
  });

  it('exact parallel alignment: each timestamp maps to the same-index variable values', async () => {
    // Three timestamps × three variables — verifies position [i] consistency across all arrays.
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: {
        time: 'iso8601',
        temperature_2m: '°C',
        wind_speed_10m: 'km/h',
        cloud_cover: '%',
      },
      hourly: {
        time: ['2026-05-30T00:00', '2026-05-30T01:00', '2026-05-30T02:00'],
        temperature_2m: [10.1, 9.4, 8.8],
        wind_speed_10m: [5.0, 6.2, 7.1],
        cloud_cover: [20, 35, 50],
      },
    });
    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m', 'wind_speed_10m', 'cloud_cover'],
    });
    const result = await openmeteoGetForecastTool.handler(input, ctx);

    expect(result.hourly).toHaveLength(3);
    // position 0
    expect(result.hourly![0]).toEqual({
      time: '2026-05-30T00:00',
      temperature_2m: 10.1,
      wind_speed_10m: 5.0,
      cloud_cover: 20,
    });
    // position 1
    expect(result.hourly![1]).toEqual({
      time: '2026-05-30T01:00',
      temperature_2m: 9.4,
      wind_speed_10m: 6.2,
      cloud_cover: 35,
    });
    // position 2
    expect(result.hourly![2]).toEqual({
      time: '2026-05-30T02:00',
      temperature_2m: 8.8,
      wind_speed_10m: 7.1,
      cloud_cover: 50,
    });
  });

  it('throws no_variables_requested (with correct reason and recovery hint) when neither hourly nor daily provided', async () => {
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
    });
    await expect(wireError(openmeteoGetForecastTool, input)).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'no_variables_requested',
        recovery: {
          hint: 'Provide at least one of current_variables (conditions right now), hourly_variables, or daily_variables.',
        },
      },
    });
  });

  // --- timezone (#38) --------------------------------------------------------

  it('rejects a blank timezone before the network call (#38)', async () => {
    // openMeteoUrl omits an empty value, so a blank timezone used to fall through to
    // upstream's GMT default rather than the documented "auto".
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m'],
      timezone: '',
    });
    await expect(wireError(openmeteoGetForecastTool, input)).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('timezone was blank'),
      data: {
        reason: 'invalid_timezone',
        recovery: { hint: expect.stringContaining('IANA') },
      },
    });
    expect(mockGetForecast).not.toHaveBeenCalled();
  });

  it('reclassifies the upstream Invalid timezone envelope away from invalid_variable (#38)', async () => {
    // Live upstream shape for an unknown zone: HTTP 400, {"reason":"Invalid timezone","error":true}.
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason: 'Invalid timezone',
    });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m'],
      timezone: 'Mars/Olympus',
    });
    await expect(wireError(openmeteoGetForecastTool, input)).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('Open-Meteo rejected the requested timezone'),
      data: {
        reason: 'invalid_timezone',
        recovery: { hint: expect.stringContaining('auto') },
      },
    });
  });

  it('still defaults an omitted timezone to auto (#38)', async () => {
    mockGetForecast.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m'],
    });
    await openmeteoGetForecastTool.handler(input, ctx);
    expect(mockGetForecast).toHaveBeenCalledWith(
      47.6062,
      -122.3321,
      expect.objectContaining({ timezone: 'auto' }),
      ctx,
    );
  });

  it('passes a valid IANA zone through unchanged (#38)', async () => {
    mockGetForecast.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m'],
      timezone: 'America/Los_Angeles',
    });
    await openmeteoGetForecastTool.handler(input, ctx);
    expect(mockGetForecast).toHaveBeenCalledWith(
      47.6062,
      -122.3321,
      expect.objectContaining({ timezone: 'America/Los_Angeles' }),
      ctx,
    );
  });

  it('frames the upstream unknown-variable rejection: names the values, leads with guidance, demotes the raw reason', async () => {
    // A rejection naming more than one value: upstream read the list as one opaque
    // value. Without an allowlist the framing can only say at least one is invalid,
    // never single out a name that may be perfectly valid.
    const upstreamReason =
      "Data corrupted at path ''. Cannot initialize SurfacePressureAndHeightVariable<VariableAndPreviousDay, VariableOrSpread<ForecastPressureVariable>, ForecastHeightVariable> from invalid String value temperature_2m,not_a_real_variable_xyz.";
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason: upstreamReason,
    });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m', 'not_a_real_variable_xyz'],
    });
    await expect(wireError(openmeteoGetForecastTool, input)).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      // Leads with guidance and names the requested values without claiming
      // the valid ones are unknown
      message: expect.stringMatching(
        /^At least one of the requested variable names is not a valid Open-Meteo API name: temperature_2m, not_a_real_variable_xyz\./,
      ),
      data: {
        reason: 'invalid_variable',
        // Declared contract recovery flows to the wire (data.recovery.hint)
        recovery: { hint: expect.stringContaining('temperature_2m') },
      },
    });
    // Raw upstream string is demoted to a trailing parenthetical, not the lead
    await expect(wireError(openmeteoGetForecastTool, input)).resolves.toMatchObject({
      message: expect.stringContaining(`(Upstream: ${upstreamReason})`),
    });
  });

  it('classifies the upstream too-much-data rejection as request_too_large (#50)', async () => {
    // Every requested name is valid here — the volume is what upstream refused, so the
    // unknown-name framing sent the caller to check spelling instead of narrowing.
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason: TOO_MUCH_DATA_REASON,
    });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      forecast_days: 16,
      past_days: 92,
      hourly_variables: ['temperature_2m', 'precipitation'],
    });
    const error = await wireError(openmeteoGetForecastTool, input);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'request_too_large',
        recovery: { hint: expect.stringContaining('Narrow the request') },
      },
    });
    expect(error.message).toContain('too much data at once');
    expect(error.message).toContain('fewer past_days / forecast_days');
    expect(error.message).not.toMatch(/exact Open-Meteo API name/);
  });

  it('names cloud_cover and its field when it is passed alongside valid daily siblings (#26)', async () => {
    // The live 400 for this request echoes the whole encoded list, valid names
    // included, so the offender is never isolated upstream. Rejecting before the call
    // is what makes the next attempt convergent.
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 40.71427,
      longitude: -74.00597,
      forecast_days: 16,
      daily_variables: [
        'sunrise',
        'sunset',
        'temperature_2m_max',
        'temperature_2m_min',
        'precipitation_sum',
        'cloud_cover',
        'weather_code',
        'uv_index_max',
      ],
    });

    await expect(wireError(openmeteoGetForecastTool, input)).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message:
        'cloud_cover is not valid in daily_variables — Open-Meteo publishes it as an hourly variable. Move it to hourly_variables, or stay in daily_variables with cloud_cover_max, cloud_cover_mean, cloud_cover_min.',
      data: { reason: 'variable_wrong_cadence', recovery: { hint: expect.any(String) } },
    });
    // The valid siblings are never named as suspects, and no upstream call is made.
    expect(mockGetForecast).not.toHaveBeenCalled();
  });

  it('rejects temperature_2m_max in hourly_variables instead of returning an all-null column (#26)', async () => {
    // Upstream answers this one with HTTP 200, an all-null column, and unit
    // "undefined" — a success indistinguishable from a genuine data gap.
    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 40.71427,
      longitude: -74.00597,
      hourly_variables: ['temperature_2m_max'],
    });

    await expect(openmeteoGetForecastTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message:
        'temperature_2m_max is not valid in hourly_variables — Open-Meteo publishes it as a daily variable. Move it to daily_variables, or stay in hourly_variables with temperature_2m.',
      data: { reason: 'variable_wrong_cadence' },
    });
    expect(mockGetForecast).not.toHaveBeenCalled();
  });

  it('sends an unknown variable name upstream unrejected (#7)', async () => {
    // The catalogs reject only a confident misplacement. A name in neither cadence set
    // is unknown, not invalid — Open-Meteo stays the authority on it.
    mockGetForecast.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m', 'a_variable_open_meteo_added_later'],
      daily_variables: ['another_new_daily_variable'],
    });

    await openmeteoGetForecastTool.handler(input, ctx);

    expect(mockGetForecast).toHaveBeenCalledTimes(1);
    const callArgs = mockGetForecast.mock.calls[0]?.[2] as {
      hourly?: string[];
      daily?: string[];
    };
    expect(callArgs?.hourly).toEqual(['temperature_2m', 'a_variable_open_meteo_added_later']);
    expect(callArgs?.daily).toEqual(['another_new_daily_variable']);
  });

  it('notices an all-null column upstream reported with unit "undefined"', async () => {
    // The backstop for names the catalog does not carry: without it the caller reads
    // nulls as a genuine data gap.
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: { time: 'iso8601', temperature_2m: '°C', some_new_daily_name: 'undefined' },
      hourly: {
        time: ['2026-05-30T00:00', '2026-05-30T01:00'],
        temperature_2m: [10.1, 9.4],
        some_new_daily_name: [null, null],
      },
    });
    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m', 'some_new_daily_name'],
    });

    await openmeteoGetForecastTool.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toContain('some_new_daily_name returned no data');
    expect(getEnrichment(ctx).notice).toContain(
      'current_variables, hourly_variables, or daily_variables',
    );
  });

  it('stays quiet when every requested column carries a real unit', async () => {
    mockGetForecast.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m', 'precipitation'],
    });

    await openmeteoGetForecastTool.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('passes timezone=auto by default', async () => {
    mockGetForecast.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m'],
    });
    // Default should not override timezone — verify 'auto' is used
    expect(input.timezone).toBe('auto');
    await openmeteoGetForecastTool.handler(input, ctx);
    const callArgs = mockGetForecast.mock.calls[0]?.[2] as { timezone?: string };
    expect(callArgs?.timezone).toBe('auto');
  });

  it('passes explicit timezone through to service', async () => {
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      timezone: 'Europe/Berlin',
      utc_offset_seconds: 7200,
    });
    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 52.52,
      longitude: 13.4,
      hourly_variables: ['temperature_2m'],
      timezone: 'Europe/Berlin',
    });
    const result = await openmeteoGetForecastTool.handler(input, ctx);
    const callArgs = mockGetForecast.mock.calls[0]?.[2] as { timezone?: string };
    expect(callArgs?.timezone).toBe('Europe/Berlin');
    expect(result.timezone).toBe('Europe/Berlin');
  });

  it('surfaces hourly_units and daily_units separately from records', async () => {
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily_units: { time: 'iso8601', temperature_2m_max: '°C' },
      daily: { time: ['2026-05-30'], temperature_2m_max: [15.9] },
    });
    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m'],
      daily_variables: ['temperature_2m_max'],
    });
    const result = await openmeteoGetForecastTool.handler(input, ctx);
    // Units are in the units map, not in each record
    expect(result.daily![0]).not.toHaveProperty('unit');
    expect(result.daily_units).toHaveProperty('temperature_2m_max', '°C');
  });

  it('formats output as markdown with attribution', () => {
    const blocks = openmeteoGetForecastTool.format!({
      latitude: 47.6,
      longitude: -122.3,
      elevation: 59,
      timezone: 'America/Los_Angeles',
      utc_offset_seconds: -25200,
      record_count: 1,
      hourly: [{ time: '2026-05-30T10:00', temperature_2m: 12.0 }],
      hourly_units: { temperature_2m: '°C' },
      truncated: false,
    });
    expect(firstText(blocks)).toContain('Weather forecast');
    expect(firstText(blocks)).toContain('Open-Meteo.com');
  });

  it('renders the full units map including the time unit in content[] (#24)', () => {
    // structuredContent.*_units carries time: iso8601 — content[] must too, or
    // text-only clients read an incomplete units map.
    const text = firstText(
      openmeteoGetForecastTool.format!({
        latitude: 47.6,
        longitude: -122.3,
        elevation: 59,
        timezone: 'America/Los_Angeles',
        utc_offset_seconds: -25200,
        record_count: 2,
        hourly: [{ time: '2026-05-30T10:00', temperature_2m: 12.0 }],
        hourly_units: { time: 'iso8601', temperature_2m: '°C' },
        daily: [{ time: '2026-05-30', temperature_2m_max: 18.0 }],
        daily_units: { time: 'iso8601', temperature_2m_max: '°C' },
        truncated: false,
      }),
    );
    expect(text).toContain('**Hourly units:** time: iso8601 | temperature_2m: °C');
    expect(text).toContain('**Daily units:** time: iso8601 | temperature_2m_max: °C');
  });

  it('renders every hourly row in content[] with no cap or "…and N more" (format parity)', () => {
    // 50 rows is above the former 48-row render cap — content[] must carry the same
    // rows as structuredContent.hourly, with an honest count in the heading.
    const hourly = Array.from({ length: 50 }, (_, i) => ({
      time: `2026-05-30T00:00+${i}`,
      temperature_2m: 1000 + i,
    }));
    const text = firstText(
      openmeteoGetForecastTool.format!({
        latitude: 47.6,
        longitude: -122.3,
        elevation: 59,
        timezone: 'America/Los_Angeles',
        utc_offset_seconds: -25200,
        record_count: 50,
        hourly,
        hourly_units: { temperature_2m: '°C' },
        truncated: false,
      }),
    );
    expect(text).toContain('### Hourly (50 records)');
    expect(text).toContain('temperature_2m: 1000'); // first row
    expect(text).toContain('temperature_2m: 1049'); // last row — not sliced at 48
    expect(text).not.toMatch(/and \d+ more/);
  });
  it('spills to DataCanvas and sets truncated=true when a wide past_days window exceeds the budget', async () => {
    // #29: past_days up to 92 alongside forecast_days up to 16 is a 108-day hourly
    // window — the same payload class openmeteo_get_historical stages.
    const time = hourlyTimes(2592);
    mockGetForecast.mockResolvedValue({ ...MOCK_RESPONSE, hourly: wideHourlyBlock(time) });

    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: time.length, tableName: 'spilled_fc123' },
      previewRows: time.slice(0, 5).map((tstamp) => ({ time: tstamp, temperature_2m: 12.5 })),
    });
    const acquire = vi.fn().mockResolvedValue({ canvasId: 'canvas-fc-1' });
    mockCanvasInstance = { acquire };

    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      forecast_days: 16,
      past_days: 92,
      hourly_variables: ['temperature_2m', 'precipitation'],
    });
    const result = await openmeteoGetForecastTool.handler(input, ctx);

    expect(acquire).toHaveBeenCalled();
    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBe('canvas-fc-1');
    expect(result.table_name).toBe('spilled_fc123');
    expect(result.record_count).toBe(time.length);
    // The preview is bounded from the source records, not read off spillover()'s
    // previewRows — the canvas holds every row, the inline preview is chosen separately.
    expect(result.hourly?.length ?? 0).toBeGreaterThan(0);
    expect(result.hourly?.length ?? 0).toBeLessThan(time.length);
    expect(JSON.stringify(result.hourly ?? []).length).toBeLessThanOrEqual(rowBudgetFor(result));
  });

  it('bounds the preview and sets truncated=true when the window is wide and canvas is disabled', async () => {
    // Depends on #28 — without the canvas-less fallback this window would return
    // whole with truncated: false.
    const time = hourlyTimes(2592);
    mockGetForecast.mockResolvedValue({ ...MOCK_RESPONSE, hourly: wideHourlyBlock(time) });
    mockCanvasInstance = undefined; // CANVAS_PROVIDER_TYPE=none

    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      forecast_days: 16,
      past_days: 92,
      hourly_variables: ['temperature_2m', 'precipitation'],
    });
    const result = await openmeteoGetForecastTool.handler(input, ctx);

    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBeUndefined();
    expect(result.table_name).toBeUndefined();
    expect(mockSpillover).not.toHaveBeenCalled();
    expect(result.hourly?.length ?? 0).toBeLessThan(time.length);
    expect(JSON.stringify(result.hourly ?? []).length).toBeLessThanOrEqual(rowBudgetFor(result));
    // record_count stays the full upstream total, not the preview length.
    expect(result.record_count).toBe(time.length);
  });

  it('carries daily rows in the canvas-less preview of a wide hourly window (#32)', async () => {
    // Hourly records lead the concatenated set, so a single preview over it spends
    // the whole budget before the first daily row and daily comes back empty.
    const time = hourlyTimes(2592);
    const dailyTime = Array.from(
      { length: 108 },
      (_, i) => `2026-0${Math.floor(i / 28) + 1}-${String((i % 28) + 1).padStart(2, '0')}`,
    );
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: wideHourlyBlock(time),
      daily_units: { time: 'iso8601', temperature_2m_max: '°C', precipitation_sum: 'mm' },
      daily: {
        time: dailyTime,
        temperature_2m_max: dailyTime.map((_, i) => 12 + (i % 15)),
        precipitation_sum: dailyTime.map((_, i) => (i % 3 === 0 ? 1.2 : 0)),
      },
    });
    mockCanvasInstance = undefined; // CANVAS_PROVIDER_TYPE=none

    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      forecast_days: 16,
      past_days: 92,
      hourly_variables: ['temperature_2m', 'precipitation'],
      daily_variables: ['temperature_2m_max', 'precipitation_sum'],
    });
    const result = await openmeteoGetForecastTool.handler(input, ctx);

    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBeUndefined();
    expect(result.daily).toHaveLength(dailyTime.length);
    expect(result.daily?.[0]).toMatchObject({ time: dailyTime[0], temperature_2m_max: 12 });
    expect(result.hourly?.length ?? 0).toBeGreaterThan(0);
    // Both previews together stay inside the one budget, and record_count is the total.
    expect(
      JSON.stringify(result.hourly ?? []).length + JSON.stringify(result.daily ?? []).length,
    ).toBeLessThanOrEqual(rowBudgetFor(result));
    expect(result.record_count).toBe(time.length + dailyTime.length);
  });

  it('skips the leading all-null past_days run in the canvas-less preview', async () => {
    // The API serves fewer past days than past_days: 92 allows, so the unserved head
    // comes back null — measured at 733 of 2,592 rows for a Seattle pull, longer than
    // the whole budget. Without the skip the preview carries no data at all.
    const time = hourlyTimes(2592);
    const firstUseful = 733;
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: wideHourlyBlock(time, firstUseful),
    });
    mockCanvasInstance = undefined; // CANVAS_PROVIDER_TYPE=none

    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      forecast_days: 16,
      past_days: 92,
      hourly_variables: ['temperature_2m', 'precipitation'],
    });
    const result = await openmeteoGetForecastTool.handler(input, ctx);

    expect(result.truncated).toBe(true);
    expect(result.hourly?.[0]?.time).toBe(time[firstUseful]);
    expect(result.hourly?.[0]?.temperature_2m).not.toBeNull();
    // The skipped rows still count toward the upstream total.
    expect(result.record_count).toBe(time.length);
  });

  it('returns inline without touching a canvas when the window fits', async () => {
    mockGetForecast.mockResolvedValue(MOCK_RESPONSE);
    const acquire = vi.fn();
    mockCanvasInstance = { acquire };

    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m', 'precipitation'],
    });
    const result = await openmeteoGetForecastTool.handler(input, ctx);

    expect(result.truncated).toBe(false);
    expect(result.record_count).toBe(2);
    expect(result.canvas_id).toBeUndefined();
    expect(result.table_name).toBeUndefined();
    // A result that fits must not mint a canvas — an acquired-but-unused canvas
    // holds a per-tenant slot the caller never learns about.
    expect(acquire).not.toHaveBeenCalled();
    expect(mockSpillover).not.toHaveBeenCalled();
  });

  it('carries daily rows in the canvas-branch preview of a wide hourly window (#36)', async () => {
    /*
     * The canvas branch used to split spillover()'s previewRows by timestamp shape.
     * Those rows are drained from the head of the concatenated [...hourly, ...daily]
     * array, so on a wide hourly window every one of them is hourly and `daily` came
     * back empty even though the staged table held all 108 daily rows.
     */
    const hourlyTime = hourlyTimes(2592);
    const dailyTime = Array.from(
      { length: 108 },
      (_, i) =>
        `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    );
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: wideHourlyBlock(hourlyTime),
      daily_units: { time: 'iso8601', temperature_2m_max: '°C', precipitation_sum: 'mm' },
      daily: {
        time: dailyTime,
        temperature_2m_max: dailyTime.map((_, i) => 15 + (i % 12)),
        precipitation_sum: dailyTime.map((_, i) => (i % 3 === 0 ? 1.2 : 0)),
      },
    });
    // What spillover() actually drains here: a budget's worth of leading hourly rows,
    // no daily row among them.
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: hourlyTime.length + dailyTime.length, tableName: 'spilled_fc_mix' },
      previewRows: hourlyTime.slice(0, 300).map((t) => ({ time: t, temperature_2m: 5.1 })),
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-fc-mix' }) };

    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      forecast_days: 16,
      past_days: 92,
      hourly_variables: ['temperature_2m'],
      daily_variables: ['temperature_2m_max', 'precipitation_sum'],
    });
    const result = await openmeteoGetForecastTool.handler(input, ctx);

    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBe('canvas-fc-mix');
    // Both cadences carry rows, and the daily side is real daily data.
    expect(result.daily).toHaveLength(dailyTime.length);
    expect(result.daily?.[0]).toMatchObject({ time: dailyTime[0], temperature_2m_max: 15 });
    expect(result.hourly?.length ?? 0).toBeGreaterThan(0);
    expect(result.hourly?.[0]?.time).toBe(hourlyTime[0]);
    // One shared budget across both, same as the canvas-less branch.
    expect(
      JSON.stringify(result.hourly ?? []).length + JSON.stringify(result.daily ?? []).length,
    ).toBeLessThanOrEqual(rowBudgetFor(result));
    // record_count stays the staged total, not the preview length.
    expect(result.record_count).toBe(hourlyTime.length + dailyTime.length);

    // format() renders the daily section the empty array used to gate away.
    const text = firstText(openmeteoGetForecastTool.format!(result));
    expect(text).toContain('### Daily');
    expect(text).toContain(`of ${hourlyTime.length + dailyTime.length} total rows on canvas`);
  });

  it('renders the canvas handles in the truncated format()', () => {
    const text = firstText(
      openmeteoGetForecastTool.format!({
        latitude: 47.6,
        longitude: -122.3,
        elevation: 59,
        timezone: 'America/Los_Angeles',
        utc_offset_seconds: -25200,
        record_count: 2592,
        hourly: [{ time: '2026-03-01T00:00', temperature_2m: 5.1 }],
        hourly_units: { temperature_2m: '°C' },
        canvas_id: 'canvas-fc-1',
        table_name: 'spilled_fc123',
        truncated: true,
      }),
    );
    expect(text).toContain('canvas-fc-1');
    expect(text).toContain('spilled_fc123');
    expect(text).toContain('**Records:** 2592');
    expect(text).toContain('1 shown of 2592 total rows on canvas');
  });

  it('names the disabled canvas and the narrowing levers in the truncated no-canvas format()', () => {
    const text = firstText(
      openmeteoGetForecastTool.format!({
        latitude: 47.6,
        longitude: -122.3,
        elevation: 59,
        timezone: 'America/Los_Angeles',
        utc_offset_seconds: -25200,
        record_count: 2592,
        hourly: [{ time: '2026-03-01T00:00', temperature_2m: 5.1 }],
        hourly_units: { temperature_2m: '°C' },
        canvas_id: undefined,
        table_name: undefined,
        truncated: true,
      }),
    );
    // The short line only (#55) — the full disclosure reaches content[] via the notice trailer.
    expect(text).toContain('bounded preview only; no canvas_id (DataCanvas disabled)');
    expect(text).not.toContain('CANVAS_PROVIDER_TYPE');
    expect(text).toContain('fewer past_days / forecast_days');
    // Heading reports the upstream total and does not claim a canvas holds it.
    expect(text).toContain('1 shown of 2592 total rows)');
    expect(text).not.toContain('total rows on canvas');
  });

  // --- inline size ceiling (#41), canvas pointer (#44), coverage gaps (#40) ---

  /** The six-variable block from #41 Case B. */
  const caseBBlock = (
    time: string[],
    valueAt: (row: number, variable: number) => number | null = (row) => 100.5 + (row % 17),
  ): Record<string, (number | null)[] | string[]> => {
    const block: Record<string, (number | null)[] | string[]> = { time };
    [
      'temperature_2m',
      'precipitation',
      'wind_speed_10m',
      'relative_humidity_2m',
      'cloud_cover',
      'uv_index',
    ].forEach((variable, index) => {
      block[variable] = time.map((_, row) => valueAt(row, index));
    });
    return block;
  };

  const CASE_B_UNITS = {
    time: 'iso8601',
    temperature_2m: '°C',
    precipitation: 'mm',
    wind_speed_10m: 'km/h',
    relative_humidity_2m: '%',
    cloud_cover: '%',
    uv_index: '',
  };

  const caseBInput = () =>
    openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: [
        'temperature_2m',
        'precipitation',
        'wind_speed_10m',
        'relative_humidity_2m',
        'cloud_cover',
        'uv_index',
      ],
      forecast_days: 16,
      past_days: 92,
    });

  it('keeps both inline surfaces inside the ceiling with canvas disabled (#41)', async () => {
    // Case B, as reported: 108 days of six hourly variables, 2,592 rows, no canvas.
    // The preview selector summed each row's own serialized length and never counted
    // the comma joining it to the next, so a several-hundred-row preview overshot on
    // both surfaces.
    const time = hourlyTimes(2592);
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: CASE_B_UNITS,
      hourly: caseBBlock(time),
    });
    mockCanvasInstance = undefined; // CANVAS_PROVIDER_TYPE=none

    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const result = await openmeteoGetForecastTool.handler(caseBInput(), ctx);

    expect(result.truncated).toBe(true);
    expect(result.record_count).toBe(2592);
    expect(structuredSize(result, ctx)).toBeLessThanOrEqual(INLINE_CHARS);
    expect(firstText(openmeteoGetForecastTool.format!(result)).length).toBeLessThanOrEqual(
      INLINE_CHARS,
    );
  });

  it('keeps both inline surfaces inside the ceiling when the spill stages (#41)', async () => {
    const time = hourlyTimes(2592);
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: CASE_B_UNITS,
      hourly: caseBBlock(time),
    });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: 2592, tableName: 'spilled_fc41' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-fc-41' }) };

    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const result = await openmeteoGetForecastTool.handler(caseBInput(), ctx);

    expect(result.truncated).toBe(true);
    expect(structuredSize(result, ctx)).toBeLessThanOrEqual(INLINE_CHARS);
    expect(firstText(openmeteoGetForecastTool.format!(result)).length).toBeLessThanOrEqual(
      INLINE_CHARS,
    );
  });

  it('names openmeteo_dataframe_describe before openmeteo_dataframe_query on both surfaces (#44)', async () => {
    const time = hourlyTimes(2592);
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: CASE_B_UNITS,
      hourly: caseBBlock(time),
    });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: 2592, tableName: 'spilled_fc44' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-fc-44' }) };

    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const result = await openmeteoGetForecastTool.handler(caseBInput(), ctx);

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('spilled_fc44');
    expect(notice.indexOf('openmeteo_dataframe_describe')).toBeGreaterThanOrEqual(0);
    expect(notice.indexOf('openmeteo_dataframe_describe')).toBeLessThan(
      notice.indexOf('openmeteo_dataframe_query'),
    );

    const text = firstText(openmeteoGetForecastTool.format!(result));
    expect(text.indexOf('openmeteo_dataframe_describe')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('openmeteo_dataframe_describe')).toBeLessThan(
      text.indexOf('openmeteo_dataframe_query'),
    );
  });

  it('keeps the unserved-column warning when the canvas pointer fires in the same call (#44)', async () => {
    const time = hourlyTimes(2592);
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: { ...CASE_B_UNITS, soil_moisture_0_to_1cm: 'undefined' },
      hourly: { ...caseBBlock(time), soil_moisture_0_to_1cm: time.map(() => null) },
    });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: 2592, tableName: 'spilled_fc44b' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-fc-44b' }) };

    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    await openmeteoGetForecastTool.handler(caseBInput(), ctx);

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('soil_moisture_0_to_1cm returned no data');
    expect(notice).toContain('openmeteo_dataframe_describe');
  });

  // --- no-canvas disclosure (#51), unrequested cadence (#53) -----------------

  /** A daily-only block wide enough to truncate: 108 days across 40 daily variables. */
  const wideDailyBlock = (time: string[]): Record<string, (number | null)[] | string[]> => {
    const block: Record<string, (number | null)[] | string[]> = { time };
    for (let v = 0; v < 40; v++) {
      block[`daily_variable_number_${v}`] = time.map((_, row) => 10.5 + ((row + v) % 13));
    }
    return block;
  };

  /** `count` consecutive ISO dates from `from`. */
  const dailyDates = (count: number, from = '2026-01-01'): string[] =>
    Array.from({ length: count }, (_, i) => {
      const d = new Date(`${from}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    });

  const stageOnCanvas = (rowCount: number) => {
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount, tableName: 'spilled_fc53' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-fc-53' }) };
  };

  it.each([
    ['canvas enabled', true],
    ['canvas disabled', false],
  ])('omits daily on a truncated hourly-only request — %s (#53)', async (_label, canvasEnabled) => {
    // boundedPreviewByCadence used to receive `dailyRecords ?? []` and hand back a
    // plain array, so the truncated response published `daily: []` where the schema
    // promises the key is absent when no daily_variables were requested.
    const time = hourlyTimes(2592);
    mockGetForecast.mockResolvedValue({ ...MOCK_RESPONSE, hourly: wideHourlyBlock(time) });
    if (canvasEnabled) stageOnCanvas(time.length);
    else mockCanvasInstance = undefined;

    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const result = await openmeteoGetForecastTool.handler(
      openmeteoGetForecastTool.input.parse({
        latitude: 47.6062,
        longitude: -122.3321,
        forecast_days: 16,
        past_days: 92,
        hourly_variables: ['temperature_2m', 'precipitation'],
      }),
      ctx,
    );

    expect(result.truncated).toBe(true);
    expect(result.daily).toBeUndefined();
    expect(result.hourly?.length ?? 0).toBeGreaterThan(0);
    // format() renders no daily section for an absent cadence.
    expect(firstText(openmeteoGetForecastTool.format!(result))).not.toContain('### Daily');
  });

  it.each([
    ['canvas enabled', true],
    ['canvas disabled', false],
  ])('omits hourly on a truncated daily-only request — %s (#53)', async (_label, canvasEnabled) => {
    const time = dailyDates(108);
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: undefined,
      hourly: undefined,
      daily_units: { time: 'iso8601' },
      daily: wideDailyBlock(time),
    });
    if (canvasEnabled) stageOnCanvas(time.length);
    else mockCanvasInstance = undefined;

    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const result = await openmeteoGetForecastTool.handler(
      openmeteoGetForecastTool.input.parse({
        latitude: 47.6062,
        longitude: -122.3321,
        forecast_days: 16,
        past_days: 92,
        daily_variables: Array.from({ length: 40 }, (_, v) => `daily_variable_number_${v}`),
      }),
      ctx,
    );

    expect(result.truncated).toBe(true);
    expect(result.hourly).toBeUndefined();
    expect(result.daily?.length ?? 0).toBeGreaterThan(0);
    expect(firstText(openmeteoGetForecastTool.format!(result))).not.toContain('### Hourly');
  });

  it('discloses the disabled canvas in the notice and once across content[] (#51, #55)', async () => {
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: wideHourlyBlock(hourlyTimes(2592)),
    });
    mockCanvasInstance = undefined; // CANVAS_PROVIDER_TYPE=none

    const result = await runToolContract(openmeteoGetForecastTool, {
      latitude: 47.6062,
      longitude: -122.3321,
      forecast_days: 16,
      past_days: 92,
      hourly_variables: ['temperature_2m', 'precipitation'],
    });

    expectNoCanvasDisclosureOnce(result, 'fewer past_days / forecast_days');
  });

  it('keeps the coverage-gap sentence alongside the no-canvas disclosure (#51)', async () => {
    // Both notice sources fire on one response, and the composer rewrites the whole
    // string each time — neither may silently drop the other.
    const time = hourlyTimes(2592);
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: CASE_B_UNITS,
      hourly: caseBBlock(time, (row) => (row < 733 ? null : 100.5 + (row % 17))),
    });
    mockCanvasInstance = undefined;

    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    await openmeteoGetForecastTool.handler(caseBInput(), ctx);

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('Partial hourly coverage for temperature_2m');
    expect(notice).toContain('There is no canvas_id because DataCanvas is disabled');
  });

  it('says nothing about a disabled canvas when the spill actually staged (#51)', async () => {
    const time = hourlyTimes(2592);
    mockGetForecast.mockResolvedValue({ ...MOCK_RESPONSE, hourly: wideHourlyBlock(time) });
    stageOnCanvas(time.length);

    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    await openmeteoGetForecastTool.handler(
      openmeteoGetForecastTool.input.parse({
        latitude: 47.6062,
        longitude: -122.3321,
        forecast_days: 16,
        past_days: 92,
        hourly_variables: ['temperature_2m', 'precipitation'],
      }),
      ctx,
    );

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('spilled_fc53');
    expect(notice).not.toContain('DataCanvas is disabled');
  });

  it('reports the leading-null head a past_days window longer than the API serves returns (#40)', async () => {
    // The forecast API serves fewer past days than past_days: 92 allows, so the
    // unserved head comes back null with real units — a coverage gap, not an
    // unserved name.
    const time = hourlyTimes(240);
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: { time: 'iso8601', temperature_2m: '°C' },
      hourly: {
        time,
        temperature_2m: time.map((_, row) => (row < 48 ? null : 10 + (row % 9))),
      },
    });

    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const result = await openmeteoGetForecastTool.handler(
      openmeteoGetForecastTool.input.parse({
        latitude: 47.6062,
        longitude: -122.3321,
        hourly_variables: ['temperature_2m'],
        past_days: 92,
      }),
      ctx,
    );

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('Partial hourly coverage for temperature_2m');
    expect(notice).toContain(`data runs ${time[48]} to ${time[239]}`);
    expect(notice).toContain('48 of 240 rows are null');
    // The response is small enough to return whole — the gap is reported anyway.
    expect(result.truncated).toBe(false);
    expect(result.record_count).toBe(240);
  });
});

describe('openmeteoGetForecastTool model comparison (#80)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasInstance = undefined;
    mockSpillover.mockResolvedValue({ spilled: false, previewRows: [] });
  });

  const SEATTLE = { latitude: 47.6062, longitude: -122.3321 };

  /** The upstream params the handler sent on its one call. */
  const sentParams = () => mockGetForecast.mock.calls[0]?.[2] as Record<string, unknown>;

  it('sends no models parameter and leaves the output unchanged when models is omitted', async () => {
    mockGetForecast.mockResolvedValue(MOCK_RESPONSE);

    const result = await runToolContract(openmeteoGetForecastTool, {
      ...SEATTLE,
      hourly_variables: ['temperature_2m', 'precipitation'],
    });

    expect(result.isError).toBeFalsy();
    // The service omits an undefined models value from the URL (pinned in its own suite).
    expect(sentParams().models).toBeUndefined();
    // Serialized, as the wire carries it: an undefined value leaves no key behind.
    const wire = JSON.parse(JSON.stringify(result.structuredContent)) as Record<string, unknown>;
    expect(wire).not.toHaveProperty('models');
    expect(wire).not.toHaveProperty('notice');
    expect(firstText(result.content)).toBe(
      [
        '## Weather forecast',
        '**Location:** 47.595562, -122.32443 | **Elevation:** 59m',
        '**Timezone:** America/Los_Angeles | **utc_offset_seconds:** -25200',
        '**Records:** 2 | **Truncated:** false',
        '',
        '**Hourly units:** time: iso8601 | temperature_2m: °C | precipitation: mm',
        '',
        '### Hourly (2 records)',
        '**2026-05-30T00:00** — temperature_2m: 10.1 | precipitation: 0',
        '**2026-05-30T01:00** — temperature_2m: 9.4 | precipitation: 0',
        '',
        '_Weather data by Open-Meteo.com_',
      ].join('\n'),
    );
  });

  /** Live Seattle shape for gfs_seamless,ecmwf_ifs025,icon_seamless — every key suffixed. */
  const THREE_MODELS = ['gfs_seamless', 'ecmwf_ifs025', 'icon_seamless'];
  const THREE_MODEL_RESPONSE = {
    ...MOCK_RESPONSE,
    hourly_units: {
      time: 'iso8601',
      temperature_2m_gfs_seamless: '°C',
      temperature_2m_ecmwf_ifs025: '°C',
      temperature_2m_icon_seamless: '°C',
    },
    hourly: {
      time: ['2026-10-24T00:00', '2026-10-24T01:00'],
      temperature_2m_gfs_seamless: [5.9, 5.6],
      temperature_2m_ecmwf_ifs025: [6.8, 6.6],
      temperature_2m_icon_seamless: [6.3, 5.2],
    },
    daily_units: {
      time: 'iso8601',
      temperature_2m_max_gfs_seamless: '°C',
      temperature_2m_max_ecmwf_ifs025: '°C',
      temperature_2m_max_icon_seamless: '°C',
    },
    daily: {
      time: ['2026-10-24'],
      temperature_2m_max_gfs_seamless: [13.6],
      temperature_2m_max_ecmwf_ifs025: [13.1],
      temperature_2m_max_icon_seamless: [12.3],
    },
  };

  it('forwards three models and returns suffixed columns and unit keys, echoing models on both surfaces', async () => {
    mockGetForecast.mockResolvedValue(THREE_MODEL_RESPONSE);

    const result = await runToolContract(openmeteoGetForecastTool, {
      ...SEATTLE,
      hourly_variables: ['temperature_2m'],
      daily_variables: ['temperature_2m_max'],
      models: THREE_MODELS,
    });

    expect(result.isError).toBeFalsy();
    expect(sentParams().models).toEqual(THREE_MODELS);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.models).toEqual(THREE_MODELS);
    expect(structured.hourly).toEqual([
      {
        time: '2026-10-24T00:00',
        temperature_2m_gfs_seamless: 5.9,
        temperature_2m_ecmwf_ifs025: 6.8,
        temperature_2m_icon_seamless: 6.3,
      },
      {
        time: '2026-10-24T01:00',
        temperature_2m_gfs_seamless: 5.6,
        temperature_2m_ecmwf_ifs025: 6.6,
        temperature_2m_icon_seamless: 5.2,
      },
    ]);
    expect(structured.daily_units).toEqual(THREE_MODEL_RESPONSE.daily_units);
    // Every requested model is present, so there is nothing to disclose.
    expect(structured).not.toHaveProperty('notice');

    const text = firstText(result.content);
    expect(text).toContain('**Models:** gfs_seamless, ecmwf_ifs025, icon_seamless\n');
    expect(text).toContain('temperature_2m_max_icon_seamless: 12.3');
    expect(text).toContain('temperature_2m_ecmwf_ifs025: °C');
  });

  it('forwards a single model, keeps its plain column names, and echoes it', async () => {
    mockGetForecast.mockResolvedValue(MOCK_RESPONSE);

    const result = await runToolContract(openmeteoGetForecastTool, {
      ...SEATTLE,
      hourly_variables: ['temperature_2m', 'precipitation'],
      models: ['gfs_seamless'],
    });

    expect(sentParams().models).toEqual(['gfs_seamless']);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.models).toEqual(['gfs_seamless']);
    expect(structured).not.toHaveProperty('notice');
    expect(firstText(result.content)).toContain('**Models:** gfs_seamless\n');
  });

  it.each([[[]], [['', ' ']]])('treats a blank models list %j as omitted', async (models) => {
    mockGetForecast.mockResolvedValue(MOCK_RESPONSE);

    const result = await runToolContract(openmeteoGetForecastTool, {
      ...SEATTLE,
      hourly_variables: ['temperature_2m'],
      models,
    });

    expect(sentParams().models).toBeUndefined();
    expect(JSON.stringify(result.structuredContent)).not.toContain('"models"');
  });

  it('caps models at the documented forecast model count', () => {
    const parse = (count: number) =>
      openmeteoGetForecastTool.input.safeParse({
        ...SEATTLE,
        hourly_variables: ['temperature_2m'],
        models: Array.from({ length: count }, (_, i) => `m${i}`),
      }).success;
    expect(parse(FORECAST_MODELS.length)).toBe(true);
    expect(parse(FORECAST_MODELS.length + 1)).toBe(false);
  });

  it('names a model upstream dropped from a partly out-of-domain list', async () => {
    // Live: gfs_seamless,ecmwf_ifs025,icon_d2 at Seattle answers HTTP 200 with two
    // suffixed columns — icon_d2 is left out without a word.
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: {
        time: 'iso8601',
        temperature_2m_gfs_seamless: '°C',
        temperature_2m_ecmwf_ifs025: '°C',
      },
      hourly: {
        time: ['2026-10-24T00:00', '2026-10-24T01:00'],
        temperature_2m_gfs_seamless: [5.9, 5.6],
        temperature_2m_ecmwf_ifs025: [6.8, 6.6],
      },
    });

    const result = await runToolContract(openmeteoGetForecastTool, {
      ...SEATTLE,
      hourly_variables: ['temperature_2m'],
      models: ['gfs_seamless', 'ecmwf_ifs025', 'icon_d2'],
    });

    expect(result.isError).toBeFalsy();
    const notice = (result.structuredContent as { notice?: string }).notice ?? '';
    expect(notice).toContain('Open-Meteo returned no columns for icon_d2');
    expect(notice).toContain('compares only gfs_seamless, ecmwf_ifs025');
    expect(result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n')).toContain(
      'Open-Meteo returned no columns for icon_d2',
    );
  });

  it('reads the daily block for a dropped model on a daily-only request', async () => {
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: undefined,
      hourly: undefined,
      daily_units: {
        time: 'iso8601',
        temperature_2m_max_gfs_seamless: '°C',
        temperature_2m_max_ecmwf_ifs025: '°C',
      },
      daily: {
        time: ['2026-10-24'],
        temperature_2m_max_gfs_seamless: [13.6],
        temperature_2m_max_ecmwf_ifs025: [13.1],
      },
    });

    const result = await runToolContract(openmeteoGetForecastTool, {
      ...SEATTLE,
      daily_variables: ['temperature_2m_max'],
      models: ['gfs_seamless', 'ecmwf_ifs025', 'icon_d2'],
    });

    expect(result.isError).toBeFalsy();
    const notice = (result.structuredContent as { notice?: string }).notice ?? '';
    expect(notice).toContain(
      'Open-Meteo returned no columns for icon_d2 — it leaves a requested model out of the response when it has no data at this coordinate',
    );
    expect(notice).toContain('compares only gfs_seamless, ecmwf_ifs025.');
  });

  it('calls the unsuffixed columns of a 2-model request unattributable', async () => {
    // Live: gfs_seamless,icon_d2 at Seattle — icon_d2 dropped, plain column names.
    mockGetForecast.mockResolvedValue(MOCK_RESPONSE);

    const result = await runToolContract(openmeteoGetForecastTool, {
      ...SEATTLE,
      hourly_variables: ['temperature_2m', 'precipitation'],
      models: ['gfs_seamless', 'icon_d2'],
    });

    const notice = (result.structuredContent as { notice?: string }).notice ?? '';
    expect(notice).toContain(
      'temperature_2m, precipitation came back without a model suffix although 2 models were requested',
    );
    expect(notice).toContain('unattributable');
    expect(notice).toContain('one of gfs_seamless, icon_d2');
  });

  it('rejects current_variables with two models before any request (current_multi_model)', async () => {
    const error = await wireError(openmeteoGetForecastTool, {
      ...SEATTLE,
      current_variables: ['temperature_2m'],
      hourly_variables: ['temperature_2m'],
      models: ['gfs_seamless', 'ecmwf_ifs025'],
    });

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'current_multi_model',
        recovery: { hint: expect.stringContaining('at most one model') },
      },
    });
    expect(error.message).toContain('2 models (gfs_seamless, ecmwf_ifs025)');
    expect(mockGetForecast).not.toHaveBeenCalled();
  });

  it('accepts current_variables with one model and forwards both', async () => {
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      current_units: { time: 'iso8601', interval: 'seconds', temperature_2m: '°C' },
      current: { time: '2026-10-24T00:15', interval: 900, temperature_2m: 6.7 },
    });

    const result = await runToolContract(openmeteoGetForecastTool, {
      ...SEATTLE,
      current_variables: ['temperature_2m'],
      models: ['ecmwf_ifs025'],
    });

    expect(result.isError).toBeFalsy();
    expect(sentParams()).toMatchObject({ current: ['temperature_2m'], models: ['ecmwf_ifs025'] });
    expect((result.structuredContent as { current: unknown }).current).toMatchObject({
      temperature_2m: 6.7,
    });
  });

  it('frames an unknown model as a variable-or-model rejection and lists the forecast models', async () => {
    mockGetForecast.mockResolvedValue({
      error: true,
      reason:
        'Invalid value: Cannot initialize MultiDomains from invalid String value bogus_model_xyz',
    });

    const error = await wireError(openmeteoGetForecastTool, {
      ...SEATTLE,
      hourly_variables: ['temperature_2m'],
      models: ['gfs_seamless', 'bogus_model_xyz'],
    });

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_variable');
    expect(error.message).toMatch(/^Unknown variable or model name: bogus_model_xyz\./);
    expect(error.data?.recovery?.hint).toContain('ncep_gfs_seamless');
    expect(error.data?.recovery?.hint).toContain('ecmwf_ifs025');
  });

  it('keeps the variable-only framing for an unknown name when models is omitted', async () => {
    mockGetForecast.mockResolvedValue({
      error: true,
      reason: 'Cannot initialize ForecastVariable from invalid String value not_a_variable',
    });

    const result = await runToolContract(openmeteoGetForecastTool, {
      ...SEATTLE,
      hourly_variables: ['not_a_variable'],
    });
    const error = (result.structuredContent as { error: WireError }).error;

    expect(error.message).toMatch(/^Unknown variable name: not_a_variable\./);
    // No models went upstream, so the rejected name is a variable: the hint names variables only.
    const hint = error.data?.recovery?.hint ?? '';
    expect(hint).toMatch(/^Check the variable name against Open-Meteo docs\./);
    expect(hint).not.toContain('Documented models');
    for (const model of FORECAST_MODELS) expect(hint).not.toContain(model);
    expect(firstText(result.content)).toContain(hint);
    expect(firstText(result.content)).not.toContain('Documented models');
  });

  it('says a model does not serve a variable when its suffixed column has the unit "undefined"', async () => {
    // Live: lightning_potential across gfs_hrrr,icon_seamless at Seattle — gfs_hrrr's
    // column carries the unit "undefined", icon_seamless's a real J/kg over nulls.
    const time = hourlyTimes(24, '2026-10-24T00:00');
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: {
        time: 'iso8601',
        lightning_potential_gfs_hrrr: 'undefined',
        lightning_potential_icon_seamless: 'J/kg',
      },
      hourly: {
        time,
        lightning_potential_gfs_hrrr: time.map(() => null),
        lightning_potential_icon_seamless: time.map(() => null),
      },
    });

    const result = await runToolContract(openmeteoGetForecastTool, {
      ...SEATTLE,
      hourly_variables: ['lightning_potential'],
      models: ['gfs_hrrr', 'icon_seamless'],
    });

    const notice = (result.structuredContent as { notice?: string }).notice ?? '';
    expect(notice).toContain(
      'gfs_hrrr does not serve lightning_potential. Read it from a model that serves it.',
    );
    expect(notice).not.toContain('cadence');
    // icon_seamless serves it under a real unit, so its nulls are a coverage gap.
    expect(notice).toContain('No hourly data for lightning_potential_icon_seamless');
    expect(notice).not.toContain('icon_seamless does not serve');
  });

  it('names the selected model as a cause of an "undefined" unit on a single-model call', async () => {
    // Live: models=gfs_hrrr alone answers lightning_potential with a plain column, unit "undefined".
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: { time: 'iso8601', lightning_potential: 'undefined' },
      hourly: { time: ['2026-10-24T00:00'], lightning_potential: [null] },
    });

    const result = await runToolContract(openmeteoGetForecastTool, {
      ...SEATTLE,
      hourly_variables: ['lightning_potential'],
      models: ['gfs_hrrr'],
    });

    const notice = (result.structuredContent as { notice?: string }).notice ?? '';
    expect(notice).toContain('lightning_potential returned no data');
    expect(notice).toContain('or the selected model (gfs_hrrr) does not serve it');
  });

  /** A 3-model, 16-day hourly block wide enough to overflow the inline budget. */
  const threeModelWideBlock = () => {
    const time = hourlyTimes(16 * 24, '2026-10-24T00:00');
    const block: Record<string, (number | null)[] | string[]> = { time };
    const units: Record<string, string> = { time: 'iso8601' };
    for (const variable of ['temperature_2m', 'precipitation', 'wind_speed_10m', 'cloud_cover']) {
      for (const model of THREE_MODELS) {
        block[`${variable}_${model}`] = time.map((_, i) => 100.5 + (i % 17));
        units[`${variable}_${model}`] = '°C';
      }
    }
    return { time, block, units };
  };

  it('stages every suffixed column on the canvas spill and keeps them in the preview', async () => {
    const { time, block, units } = threeModelWideBlock();
    mockGetForecast.mockResolvedValue({ ...MOCK_RESPONSE, hourly_units: units, hourly: block });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: time.length, tableName: 'spilled_models' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-models' }) };

    const result = await runToolContract(openmeteoGetForecastTool, {
      ...SEATTLE,
      forecast_days: 16,
      hourly_variables: ['temperature_2m', 'precipitation', 'wind_speed_10m', 'cloud_cover'],
      models: THREE_MODELS,
    });

    const structured = result.structuredContent as {
      hourly: Record<string, unknown>[];
      hourly_units: Record<string, string>;
      models: string[];
      truncated: boolean;
      notice?: string;
    };
    expect(structured.truncated).toBe(true);
    expect(structured.models).toEqual(THREE_MODELS);
    // The staged schema carries one column per variable per model.
    const [opts] = mockSpillover.mock.calls[0] as [{ schema: { name: string }[] }];
    const staged = opts.schema.map((c) => c.name);
    expect(staged).toHaveLength(1 + 4 * THREE_MODELS.length);
    expect(staged).toContain('cloud_cover_icon_seamless');
    // The bounded preview rows and the unit map keep the suffixed keys.
    expect(structured.hourly.length).toBeGreaterThan(0);
    expect(structured.hourly.length).toBeLessThan(time.length);
    expect(Object.keys(structured.hourly[0] ?? {})).toEqual(Object.keys(block));
    expect(structured.hourly_units).toEqual(units);
    // All three models came back, so the only notice part is the canvas pointer.
    expect(structured.notice).toMatch(/^Staged 384 rows to table "spilled_models"/);
  });

  it('keeps suffixed columns in the canvas-less preview and offers fewer models as a lever', async () => {
    const { time, block, units } = threeModelWideBlock();
    mockGetForecast.mockResolvedValue({ ...MOCK_RESPONSE, hourly_units: units, hourly: block });

    const result = await runToolContract(openmeteoGetForecastTool, {
      ...SEATTLE,
      forecast_days: 16,
      hourly_variables: ['temperature_2m', 'precipitation', 'wind_speed_10m', 'cloud_cover'],
      models: THREE_MODELS,
    });

    const structured = result.structuredContent as {
      hourly: Record<string, unknown>[];
      truncated: boolean;
      notice?: string;
    };
    expect(structured.truncated).toBe(true);
    expect(structured.hourly.length).toBeLessThan(time.length);
    expect(Object.keys(structured.hourly[0] ?? {})).toEqual(Object.keys(block));
    expect(structured.notice).toContain('or fewer models.');
    expect(firstText(result.content)).toContain('or fewer models.');
  });

  it('leaves models out of the narrowing levers when none were requested', async () => {
    const time = hourlyTimes(2592);
    mockGetForecast.mockResolvedValue({ ...MOCK_RESPONSE, hourly: wideHourlyBlock(time) });

    const result = await runToolContract(openmeteoGetForecastTool, {
      ...SEATTLE,
      past_days: 92,
      forecast_days: 16,
      hourly_variables: ['temperature_2m'],
    });

    const notice = (result.structuredContent as { notice?: string }).notice ?? '';
    expect(notice).toContain('narrow the request: fewer past_days');
    expect(notice).not.toContain('models');
  });
});

describe('openmeteoGetForecastTool current conditions (#42)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasInstance = undefined;
    mockSpillover.mockResolvedValue({ spilled: false, previewRows: [] });
  });

  /** Live upstream shape: `current` carries time + interval alongside the variables. */
  const CURRENT_BLOCK = {
    current_units: {
      time: 'iso8601',
      interval: 'seconds',
      temperature_2m: '°C',
      precipitation: 'mm',
      wind_speed_10m: 'km/h',
    },
    current: {
      time: '2026-05-30T14:15',
      interval: 900,
      temperature_2m: 16.3,
      precipitation: 0.0,
      wind_speed_10m: 11.2,
    },
  };

  const run = async (input: Record<string, unknown>, upstream: object) => {
    mockGetForecast.mockResolvedValue(upstream);
    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const parsed = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      ...input,
    });
    const result = await openmeteoGetForecastTool.handler(parsed, ctx);
    return { ctx, result, params: mockGetForecast.mock.calls[0]?.[2] as { current?: string[] } };
  };

  it('forwards current_variables as the upstream current parameter', async () => {
    const { params } = await run(
      { current_variables: ['temperature_2m', 'precipitation', 'wind_speed_10m'] },
      { ...MOCK_RESPONSE, ...CURRENT_BLOCK },
    );
    expect(params.current).toEqual(['temperature_2m', 'precipitation', 'wind_speed_10m']);
  });

  it('accepts a current-only call — current_variables alone satisfies the variable contract', async () => {
    const { result } = await run(
      { current_variables: ['temperature_2m'] },
      {
        latitude: 47.595562,
        longitude: -122.32443,
        elevation: 59.0,
        utc_offset_seconds: -25200,
        timezone: 'America/Los_Angeles',
        timezone_abbreviation: 'GMT-7',
        generationtime_ms: 0.2,
        ...CURRENT_BLOCK,
      },
    );
    expect(result.hourly).toBeUndefined();
    expect(result.daily).toBeUndefined();
    expect(result.current).toMatchObject({ time: '2026-05-30T14:15', interval: 900 });
    expect(() => openmeteoGetForecastTool.output.parse(result)).not.toThrow();
  });

  it('carries the current block and unit map through verbatim', async () => {
    const { result } = await run(
      { current_variables: ['temperature_2m', 'precipitation', 'wind_speed_10m'] },
      { ...MOCK_RESPONSE, ...CURRENT_BLOCK },
    );
    expect(result.current).toEqual(CURRENT_BLOCK.current);
    expect(result.current_units).toEqual(CURRENT_BLOCK.current_units);
    // The output schema must carry the variable keys through, not just time/interval —
    // a bare z.object() would validate and then strip every requested value.
    expect(openmeteoGetForecastTool.output.parse(result).current).toEqual(CURRENT_BLOCK.current);
  });

  it('omits current and current_units entirely when current_variables was not requested', async () => {
    const { result, params } = await run({ hourly_variables: ['temperature_2m'] }, MOCK_RESPONSE);
    expect(params.current).toBeUndefined();
    expect(result.current).toBeUndefined();
    expect(result.current_units).toBeUndefined();
    expect('current' in result ? result.current : undefined).toBeUndefined();
  });

  it('renders a distinct current-conditions section on content[], with interval as metadata', async () => {
    const { result } = await run(
      { current_variables: ['temperature_2m', 'precipitation', 'wind_speed_10m'] },
      { ...MOCK_RESPONSE, ...CURRENT_BLOCK },
    );
    const text = firstText(openmeteoGetForecastTool.format!(result));
    expect(text).toMatch(/### Current conditions/);
    expect(text).toContain('2026-05-30T14:15');
    expect(text).toContain('temperature_2m: 16.3');
    // interval is the block's aggregation interval, not a requested variable — it must not
    // appear in the per-variable list the way formatRecord would put it there.
    expect(text).not.toContain('| interval: 900');
    expect(text).toMatch(/interval/);
    // Unit map reaches content[] too, so both surfaces carry the same data.
    expect(text).toContain('**Current units:**');
    expect(text).toContain('wind_speed_10m: km/h');
  });

  it('renders no current section when none was requested', async () => {
    const { result } = await run({ hourly_variables: ['temperature_2m'] }, MOCK_RESPONSE);
    const text = firstText(openmeteoGetForecastTool.format!(result));
    expect(text).not.toMatch(/Current conditions/);
    expect(text).not.toContain('**Current units:**');
  });

  it('still rejects a call with no variables at all, naming current_variables', async () => {
    mockGetForecast.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({ latitude: 47.6, longitude: -122.3 });
    await expect(openmeteoGetForecastTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'no_variables_requested' },
    });
    const contract = openmeteoGetForecastTool.errors?.find(
      (e) => e.reason === 'no_variables_requested',
    );
    expect(contract?.when).toContain('current_variables');
    expect(contract?.recovery).toContain('current_variables');
  });

  it('treats an empty current_variables array as no request', async () => {
    mockGetForecast.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      current_variables: [],
    });
    await expect(openmeteoGetForecastTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_variables_requested' },
    });
  });

  it('surfaces a mis-cadenced current name through the existing "undefined"-unit backstop', async () => {
    // Upstream answers a daily-only name passed to current with HTTP 200, a null value,
    // and the literal unit "undefined" — the same shape hourly_variables already hits.
    const { ctx } = await run(
      { current_variables: ['temperature_2m', 'temperature_2m_max'] },
      {
        ...MOCK_RESPONSE,
        current_units: {
          time: 'iso8601',
          interval: 'seconds',
          temperature_2m: '°C',
          temperature_2m_max: 'undefined',
        },
        current: {
          time: '2026-05-30T14:15',
          interval: 900,
          temperature_2m: 16.3,
          temperature_2m_max: null,
        },
      },
    );
    expect(String(getEnrichment(ctx).notice)).toContain('temperature_2m_max returned no data');
  });

  // --- null current values under a real unit (#63) ----------------------------

  /** Live at 47.6062,-122.3321: lightning_potential comes back null under J/kg. */
  const NULL_LIGHTNING = {
    current_units: {
      time: 'iso8601',
      interval: 'seconds',
      temperature_2m: '°C',
      lightning_potential: 'J/kg',
    },
    current: {
      time: '2026-10-12T10:15',
      interval: 900,
      temperature_2m: 8.6,
      lightning_potential: null,
    },
  };

  it('names a null current value under a real unit on both surfaces, keeping the null (#63)', async () => {
    const { hourly: _hourly, hourly_units: _hourlyUnits, ...envelope } = MOCK_RESPONSE;
    mockGetForecast.mockResolvedValue({ ...envelope, ...NULL_LIGHTNING });

    const result = await runToolContract(openmeteoGetForecastTool, {
      latitude: 47.6062,
      longitude: -122.3321,
      current_variables: ['temperature_2m', 'lightning_potential'],
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      current: Record<string, unknown>;
      notice?: string;
      record_count: number;
    };
    expect(structured.notice).toContain('No current value for lightning_potential');
    expect(structured.notice).not.toContain('interval');
    // The null is preserved, never coerced to zero, and the row count is untouched.
    expect(structured.current).toEqual(NULL_LIGHTNING.current);
    expect(structured.record_count).toBe(0);
    const allText = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(allText).toContain('No current value for lightning_potential');
  });

  it('adds no current-gap sentence for a fully populated current block (#63)', async () => {
    const { ctx } = await run(
      { current_variables: ['temperature_2m', 'precipitation', 'wind_speed_10m'] },
      { ...MOCK_RESPONSE, ...CURRENT_BLOCK },
    );
    expect(String(getEnrichment(ctx).notice ?? '')).not.toContain('No current value');
  });

  it('reports an "undefined"-unit current name once, through its own notice only (#63)', async () => {
    const { ctx } = await run(
      { current_variables: ['temperature_2m', 'temperature_2m_max'] },
      {
        ...MOCK_RESPONSE,
        current_units: {
          time: 'iso8601',
          interval: 'seconds',
          temperature_2m: '°C',
          temperature_2m_max: 'undefined',
        },
        current: {
          time: '2026-05-30T14:15',
          interval: 900,
          temperature_2m: 16.3,
          temperature_2m_max: null,
        },
      },
    );
    const notice = String(getEnrichment(ctx).notice);
    expect(notice.match(/temperature_2m_max/g)).toHaveLength(1);
    expect(notice).not.toContain('No current value');
  });

  // --- interval is an aggregation interval, not an update cadence (#67) --------

  const intervalDescription = () =>
    openmeteoGetForecastTool.output.shape.current.unwrap().shape.interval.description ?? '';

  it('describes current.interval as the aggregation interval ending at current.time (#67)', () => {
    const text = intervalDescription();
    expect(text).not.toMatch(/cadence|how often|refresh|updates?\b/i);
    expect(text).toMatch(/aggregation interval/i);
    expect(text).toContain('900');
    expect(text).toMatch(/preceding interval seconds ending at current\.time/);
    expect(text).toMatch(/instantaneous[^.]*valid at current\.time/);
  });

  it('forwards the provider’s interval verbatim and renders it as metadata (#67)', async () => {
    const { result } = await run(
      { current_variables: ['temperature_2m', 'precipitation', 'wind_speed_10m'] },
      { ...MOCK_RESPONSE, ...CURRENT_BLOCK },
    );
    expect(openmeteoGetForecastTool.output.parse(result).current?.interval).toBe(900);
    const text = firstText(openmeteoGetForecastTool.format!(result));
    expect(text).toContain('(interval: 900s)');
    expect(text).not.toContain('| interval: 900');
  });

  it('routes an unrecognized current name through the existing invalid_variable path', async () => {
    mockGetForecast.mockResolvedValue({
      error: true,
      reason: 'Cannot initialize ForecastVariable from invalid String value totally_not_a_variable',
    });
    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      current_variables: ['totally_not_a_variable'],
    });
    await expect(openmeteoGetForecastTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_variable' },
    });
  });

  it('counts a wide current block against the inline budget', async () => {
    /*
     * 65 current variables measured 3,927 characters of current + current_units — more
     * than the whole scaffold reserve — so the rows have to be measured against a budget
     * that has already paid for them. The input caps at 50, as hourly_variables does.
     */
    const names = Array.from({ length: 50 }, (_, i) => `current_variable_number_${i}`);
    const wideCurrent: Record<string, number | string> = {
      time: '2026-05-30T14:15',
      interval: 900,
    };
    const wideCurrentUnits: Record<string, string> = { time: 'iso8601', interval: 'seconds' };
    for (const [i, name] of names.entries()) {
      wideCurrent[name] = 100.5 + i;
      wideCurrentUnits[name] = 'μg/m³';
    }

    const time = hourlyTimes(24 * 92);
    const { ctx, result } = await run(
      { current_variables: names, hourly_variables: ['temperature_2m'], past_days: 92 },
      {
        ...MOCK_RESPONSE,
        current: wideCurrent,
        current_units: wideCurrentUnits,
        hourly_units: { time: 'iso8601', temperature_2m: '°C' },
        hourly: wideHourlyBlock(time),
      },
    );

    expect(result.truncated).toBe(true);
    expect(structuredSize(result, ctx)).toBeLessThanOrEqual(INLINE_CHARS);
    expect(firstText(openmeteoGetForecastTool.format!(result)).length).toBeLessThanOrEqual(
      INLINE_CHARS,
    );
    // The rows were bounded against the budget the current block left behind.
    expect(rowBudgetFor(result)).toBeLessThan(
      rowBudgetFor({ hourly_units: result.hourly_units, daily_units: result.daily_units }),
    );
  });
});
