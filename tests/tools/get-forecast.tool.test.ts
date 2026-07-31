/**
 * @fileoverview Tests for openmeteo_get_forecast tool.
 * @module tests/tools/get-forecast.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoGetForecastTool } from '@/mcp-server/tools/definitions/get-forecast.tool.js';
import { PREVIEW_CHARS } from '@/mcp-server/tools/spill-utils.js';

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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
    });
    await expect(openmeteoGetForecastTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'no_variables_requested',
        recovery: { hint: 'Provide at least one of hourly_variables or daily_variables.' },
      },
    });
  });

  it('frames the upstream unknown-variable rejection: names the values, leads with guidance, demotes the raw reason', async () => {
    // Real upstream reason from the live forecast endpoint for a two-variable
    // request (URLSearchParams sends hourly with a percent-encoded comma, so the
    // upstream echoes the whole requested list — valid names included).
    const upstreamReason =
      "Data corrupted at path ''. Cannot initialize SurfacePressureAndHeightVariable<VariableAndPreviousDay, VariableOrSpread<ForecastPressureVariable>, ForecastHeightVariable> from invalid String value temperature_2m,not_a_real_variable_xyz.";
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason: upstreamReason,
    });
    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m', 'not_a_real_variable_xyz'],
    });
    await expect(openmeteoGetForecastTool.handler(input, ctx)).rejects.toMatchObject({
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
    await expect(openmeteoGetForecastTool.handler(input, ctx)).rejects.toMatchObject({
      message: expect.stringContaining(`(Upstream: ${upstreamReason})`),
    });
  });

  it('names cloud_cover and its field when it is passed alongside valid daily siblings (#26)', async () => {
    // The live 400 for this request echoes the whole encoded list, valid names
    // included, so the offender is never isolated upstream. Rejecting before the call
    // is what makes the next attempt convergent.
    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
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

    await expect(openmeteoGetForecastTool.handler(input, ctx)).rejects.toMatchObject({
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
    const ctx = createMockContext();
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m', 'some_new_daily_name'],
    });

    await openmeteoGetForecastTool.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toContain('some_new_daily_name returned no data');
    expect(getEnrichment(ctx).notice).toContain('hourly_variables or daily_variables');
  });

  it('stays quiet when every requested column carries a real unit', async () => {
    mockGetForecast.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    expect(blocks[0]?.text).toContain('Weather forecast');
    expect(blocks[0]?.text).toContain('Open-Meteo.com');
  });

  it('renders the full units map including the time unit in content[] (#24)', () => {
    // structuredContent.*_units carries time: iso8601 — content[] must too, or
    // text-only clients read an incomplete units map.
    const text =
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
      })[0]?.text ?? '';
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
    const text =
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
      })[0]?.text ?? '';
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

    const previewRows = time.slice(0, 5).map((tstamp) => ({
      time: tstamp,
      temperature_2m: 12.5,
    }));
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: time.length, tableName: 'spilled_fc123' },
      previewRows,
    });
    const acquire = vi.fn().mockResolvedValue({ canvasId: 'canvas-fc-1' });
    mockCanvasInstance = { acquire };

    const ctx = createMockContext();
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
    expect(result.hourly).toHaveLength(previewRows.length);
  });

  it('bounds the preview and sets truncated=true when the window is wide and canvas is disabled', async () => {
    // Depends on #28 — without the canvas-less fallback this window would return
    // whole with truncated: false.
    const time = hourlyTimes(2592);
    mockGetForecast.mockResolvedValue({ ...MOCK_RESPONSE, hourly: wideHourlyBlock(time) });
    mockCanvasInstance = undefined; // CANVAS_PROVIDER_TYPE=none

    const ctx = createMockContext();
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
    expect(JSON.stringify(result.hourly ?? []).length).toBeLessThanOrEqual(PREVIEW_CHARS * 1.1);
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

    const ctx = createMockContext();
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
    ).toBeLessThanOrEqual(PREVIEW_CHARS * 1.1);
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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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

  it('splits the spillover preview back into hourly and daily by timestamp shape', async () => {
    const hourlyTime = hourlyTimes(2160);
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: wideHourlyBlock(hourlyTime),
      daily_units: { time: 'iso8601', temperature_2m_max: '°C' },
      daily: { time: ['2026-03-01', '2026-03-02'], temperature_2m_max: [15.9, 16.2] },
    });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: hourlyTime.length + 2, tableName: 'spilled_fc_mix' },
      previewRows: [
        { time: '2026-03-01T00:00', temperature_2m: 5.1 },
        { time: '2026-03-01', temperature_2m_max: 15.9 },
      ],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-fc-mix' }) };

    const ctx = createMockContext();
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      forecast_days: 16,
      past_days: 74,
      hourly_variables: ['temperature_2m'],
      daily_variables: ['temperature_2m_max'],
    });
    const result = await openmeteoGetForecastTool.handler(input, ctx);

    expect(result.hourly).toEqual([{ time: '2026-03-01T00:00', temperature_2m: 5.1 }]);
    expect(result.daily).toEqual([{ time: '2026-03-01', temperature_2m_max: 15.9 }]);
  });

  it('renders the canvas handles in the truncated format()', () => {
    const text =
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
      })[0]?.text ?? '';
    expect(text).toContain('canvas-fc-1');
    expect(text).toContain('spilled_fc123');
    expect(text).toContain('**Records:** 2592');
    expect(text).toContain('1 shown of 2592 total rows on canvas');
  });

  it('names the disabled canvas and the narrowing levers in the truncated no-canvas format()', () => {
    const text =
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
      })[0]?.text ?? '';
    expect(text).toContain('CANVAS_PROVIDER_TYPE=none');
    expect(text).toContain('CANVAS_PROVIDER_TYPE=duckdb');
    expect(text).toContain('fewer past_days / forecast_days');
    // Heading reports the upstream total and does not claim a canvas holds it.
    expect(text).toContain('1 shown of 2592 total rows)');
    expect(text).not.toContain('total rows on canvas');
  });
});
