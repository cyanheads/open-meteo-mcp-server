/**
 * @fileoverview Tests for the Open-Meteo HTTP client — request encoding and the
 * retryable/non-retryable classification of upstream responses — plus the columnar
 * reshape helpers the tool handlers apply to what it returns.
 * @module tests/services/open-meteo-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatRecord, formatUnits, reshapeColumnar } from '@/mcp-server/tools/reshape-utils.js';
import {
  getOpenMeteoService,
  initOpenMeteoService,
} from '@/services/open-meteo/open-meteo-service.js';

const fetchMock = vi.fn();

/** The requested URLs, in call order. */
const requestedUrls = (): string[] => fetchMock.mock.calls.map(([url]) => String(url));

/**
 * Answer every request with `body` — a fresh `Response` per call, since a body can
 * only be read once and the retry path reads one per attempt. Bodies here are raw
 * strings: the cases under test are not all valid JSON.
 */
const respondWith = (body: string, status = 200): void => {
  fetchMock.mockImplementation(() => Promise.resolve(new Response(body, { status })));
};

const OK_ENSEMBLE_BODY = JSON.stringify({
  latitude: 47.6,
  longitude: -122.3,
  elevation: 59,
  timezone: 'America/Los_Angeles',
  hourly_units: { time: 'iso8601', temperature_2m: '°C' },
  hourly: { time: ['2026-07-30T00:00'], temperature_2m: [15.2] },
});

describe('OpenMeteoService upstream classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    initOpenMeteoService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces a nan-coordinate body as a non-retryable input error, with no retry burn (#33)', async () => {
    /*
     * Live body from a regional ensemble model queried outside its domain — HTTP 200,
     * a bare `nan` where each coordinate belongs, no data blocks. `nan` is not valid
     * JSON, so this used to reach JSON.parse, be classified ServiceUnavailable, and
     * burn all three attempts before reporting a transient outage for an input error
     * that can never succeed.
     */
    respondWith(
      '{"latitude":nan,"longitude":nan,"generationtime_ms":0.0035,"utc_offset_seconds":0,"timezone":"GMT","timezone_abbreviation":"GMT"}',
    );
    const ctx = createMockContext();

    const error = await getOpenMeteoService()
      .getEnsemble(47.6, -122.3, { hourly: ['temperature_2m'], models: 'icon_eu_eps' }, ctx)
      .catch((e: Error) => e);

    expect(error).toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    expect(error.message).toContain('no data for this location');
    expect(error.message).toContain('global model');
    expect(error.message).not.toContain('unavailable after');
    // The decisive part: one attempt, not three.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries a genuine transient failure to exhaustion (#33)', async () => {
    // A 5xx is the failure the retry loop exists for — narrowing the nan case must
    // not touch it.
    respondWith('{"error":true,"reason":"upstream down"}', 503);
    const ctx = createMockContext();

    const error = await getOpenMeteoService()
      .getEnsemble(47.6, -122.3, { hourly: ['temperature_2m'] }, ctx)
      .catch((e: Error) => e);

    expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect(error.message).toContain('unavailable after 3 attempts');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('still retries an unparseable body that is not the nan shape (#33)', async () => {
    // The narrow match is deliberate: a truncated or garbled body carries no evidence
    // that the request itself is wrong, so it keeps its retries.
    respondWith('{"latitude":47.6,"hourly":{"time":[');
    const ctx = createMockContext();

    const error = await getOpenMeteoService()
      .getEnsemble(47.6, -122.3, { hourly: ['temperature_2m'] }, ctx)
      .catch((e: Error) => e);

    expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries an HTML CDN error page, unchanged by the nan guard', async () => {
    respondWith('<!DOCTYPE html><html><body>502</body></html>', 502);
    const ctx = createMockContext();

    await getOpenMeteoService()
      .getEnsemble(47.6, -122.3, { hourly: ['temperature_2m'] }, ctx)
      .catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('surfaces the no-data envelope as the same coverage-gap error as the nan body (#33)', async () => {
    /*
     * The `meteoswiss_*` pair reports an out-of-domain coordinate through the error
     * envelope where every other regional model answers HTTP 200 with the nan body.
     * Returned to the handler this reaches frameInvalidVariableMessage, which leads
     * with "the API rejected a requested variable or model name" — a non-retryable
     * error pointed at the spelling of a name rather than the coverage gap.
     */
    respondWith('{"error":true,"reason":"No data is available for this location"}', 400);
    const ctx = createMockContext();

    const error = await getOpenMeteoService()
      .getEnsemble(
        47.6,
        -122.3,
        { hourly: ['temperature_2m'], models: 'meteoswiss_icon_ch1_ensemble' },
        ctx,
      )
      .catch((e: Error) => e);

    expect(error).toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    expect(error.message).toContain('no data for this location');
    expect(error.message).toContain('global model');
    expect(error.message).not.toContain('variable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves an unrelated 4xx envelope for the handler to classify', async () => {
    // The coverage-gap match is narrow: an unknown-variable rejection still comes back
    // as a body so the tool can attach its own error-contract reason.
    respondWith(
      '{"error":true,"reason":"Data corrupted at path \'\'. Cannot initialize MultiDomains from invalid String value BOGUS_MODEL."}',
      400,
    );
    const ctx = createMockContext();

    const body = await getOpenMeteoService().getEnsemble(
      47.6,
      -122.3,
      { hourly: ['temperature_2m'], models: 'BOGUS_MODEL' },
      ctx,
    );

    expect(body).toMatchObject({ error: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('OpenMeteoService request encoding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    respondWith(OK_ENSEMBLE_BODY);
    initOpenMeteoService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the climate models list with a literal comma so upstream isolates the offender (#34)', async () => {
    /*
     * Percent-encoding the comma makes upstream read the list as one opaque value:
     * `models=MRI_AGCM3_2_S%2CBOGUS_MODEL` is rejected as
     * `invalid String value MRI_AGCM3_2_S,BOGUS_MODEL`, naming a valid model as a
     * suspect. With a literal comma the same request is rejected as
     * `invalid String value BOGUS_MODEL` — both verified against the keyless endpoint.
     */
    const ctx = createMockContext();
    await getOpenMeteoService().getClimate(
      47.6,
      -122.3,
      {
        start_date: '2050-01-01',
        end_date: '2050-01-05',
        daily: ['temperature_2m_max'],
        models: ['MRI_AGCM3_2_S', 'EC_Earth3P_HR'],
      },
      ctx,
    );

    const url = requestedUrls()[0] ?? '';
    expect(url).toContain('models=MRI_AGCM3_2_S,EC_Earth3P_HR');
    expect(url).not.toContain('%2C');
  });

  it.each([
    [
      'ensemble hourly and daily',
      (ctx: ReturnType<typeof createMockContext>) =>
        getOpenMeteoService().getEnsemble(
          47.6,
          -122.3,
          { hourly: ['temperature_2m', 'precipitation'], daily: ['temperature_2m_max'] },
          ctx,
        ),
      ['hourly=temperature_2m,precipitation', 'daily=temperature_2m_max'],
    ],
    [
      'forecast hourly and daily',
      (ctx: ReturnType<typeof createMockContext>) =>
        getOpenMeteoService().getForecast(
          47.6,
          -122.3,
          { hourly: ['temperature_2m', 'precipitation'], daily: ['temperature_2m_max'] },
          ctx,
        ),
      ['hourly=temperature_2m,precipitation', 'daily=temperature_2m_max'],
    ],
    [
      'marine hourly and daily',
      (ctx: ReturnType<typeof createMockContext>) =>
        getOpenMeteoService().getMarine(
          36.8,
          -75.0,
          { hourly: ['wave_height', 'wave_period'], daily: ['wave_height_max'] },
          ctx,
        ),
      ['hourly=wave_height,wave_period', 'daily=wave_height_max'],
    ],
    [
      'flood daily',
      (ctx: ReturnType<typeof createMockContext>) =>
        getOpenMeteoService().getFlood(
          47.6,
          -122.3,
          { daily: ['river_discharge', 'river_discharge_mean'] },
          ctx,
        ),
      ['daily=river_discharge,river_discharge_mean'],
    ],
    [
      'elevation coordinate lists',
      (ctx: ReturnType<typeof createMockContext>) =>
        getOpenMeteoService().getElevation([47.6, 48.1], [-122.3, -123.0], ctx),
      ['latitude=47.6,48.1', 'longitude=-122.3,-123'],
    ],
  ])(
    'sends the %s list with a literal comma (#34)',
    async (_label, call, expectedFragments: string[]) => {
      // Every comma-joined parameter, not just models — a literal comma isolates the
      // offending variable the same way, and a valid list still fans out (verified
      // per endpoint against the keyless API).
      await call(createMockContext());

      const url = requestedUrls()[0] ?? '';
      for (const fragment of expectedFragments) expect(url).toContain(fragment);
      expect(url).not.toContain('%2C');
    },
  );

  it('still escapes every character other than the list separator', async () => {
    // The comma is a sub-delimiter RFC 3986 permits unencoded in a query value;
    // nothing else is let through, and encoding runs per list element so a comma
    // inside an element could not forge a separator.
    const ctx = createMockContext();
    await getOpenMeteoService().getGeocode('São Paulo, SP', 5, 'en', 'BR', ctx);

    const url = requestedUrls()[0] ?? '';
    expect(url).toContain('name=S%C3%A3o%20Paulo%2C%20SP');
    expect(url).toContain('countryCode=BR');
  });

  it.each([
    ['ampersand', 'a&b', 'a%26b'],
    ['equals', 'a=b', 'a%3Db'],
    ['fragment', 'a#b', 'a%23b'],
    ['query start', 'a?b', 'a%3Fb'],
    ['space', 'a b', 'a%20b'],
    ['percent', 'a%b', 'a%25b'],
    ['newline', 'a\nb', 'a%0Ab'],
    ['carriage return', 'a\r\nb', 'a%0D%0Ab'],
    ['non-ASCII', 'São Paulo', 'S%C3%A3o%20Paulo'],
    ['comma', 'a,b', 'a%2Cb'],
    ['plus', 'a+b', 'a%2Bb'],
    ['semicolon', 'a;b', 'a%3Bb'],
    ['double quote', 'a"b', 'a%22b'],
    ['backslash', 'a\\b', 'a%5Cb'],
    ['astral plane', '\u{1F4A5}', '%F0%9F%92%A5'],
  ])(
    'percent-encodes a caller-supplied %s in both a scalar and a list element',
    async (_label, raw: string, encoded: string) => {
      /*
       * Every value in every request originates in tool input, and the list separator
       * is the one character deliberately left literal — so a value carrying `&`, `=`,
       * `#`, or a comma of its own must not be able to add a parameter, replace one,
       * truncate the query, or forge a separator.
       */
      const ctx = createMockContext();
      await getOpenMeteoService().getGeocode(raw, 5, 'en', undefined, ctx);
      await getOpenMeteoService().getClimate(
        47.6,
        -122.3,
        {
          start_date: '2050-01-01',
          end_date: '2050-01-05',
          daily: ['temperature_2m_max', raw],
        },
        ctx,
      );

      const [scalarUrl = '', listUrl = ''] = requestedUrls();
      expect(scalarUrl).toContain(`name=${encoded}`);
      expect(listUrl).toContain(`daily=temperature_2m_max,${encoded}`);
      // The value occupies exactly one parameter on each request: the parameter count
      // is fixed by the call, so a value that escaped its slot would raise it.
      expect(scalarUrl.split('&')).toHaveLength(4);
      expect(listUrl.split('&')).toHaveLength(6);
      expect(listUrl.split('?')).toHaveLength(2);
    },
  );

  it('omits an absent or empty list rather than sending an empty parameter', async () => {
    const ctx = createMockContext();
    await getOpenMeteoService().getForecast(
      47.6,
      -122.3,
      { hourly: ['temperature_2m'], daily: [], forecast_days: 3 },
      ctx,
    );

    const url = requestedUrls()[0] ?? '';
    expect(url).toContain('hourly=temperature_2m');
    expect(url).not.toContain('daily=');
    // A zero-valued number is a real value and must survive the omission rule.
    expect(url).toContain('forecast_days=3');
  });

  it('omits an empty scalar rather than sending a bare key=', async () => {
    /*
     * `models` is a free-form optional string, so a form-based client can send it
     * blank. `models=` is not "no model" upstream — it draws
     * `No data is available for this location`, pointing the caller at the coordinate
     * for what is an empty field, where an absent models selects the default blend.
     */
    const ctx = createMockContext();
    await getOpenMeteoService().getEnsemble(
      47.6,
      -122.3,
      { hourly: ['temperature_2m'], models: '' },
      ctx,
    );

    const url = requestedUrls()[0] ?? '';
    expect(url).toContain('hourly=temperature_2m');
    expect(url).not.toContain('models=');
  });

  it('sends past_days=0 rather than dropping it as falsy', async () => {
    const ctx = createMockContext();
    await getOpenMeteoService().getMarine(
      47.8,
      -122.5,
      { hourly: ['wave_height'], forecast_days: 8, past_days: 0 },
      ctx,
    );

    expect(requestedUrls()[0] ?? '').toContain('past_days=0');
  });
});

describe('reshapeColumnar', () => {
  it('zips time and variable arrays into per-timestamp records', () => {
    const result = reshapeColumnar({
      time: ['2026-05-30T00:00', '2026-05-30T01:00'],
      temperature_2m: [10.1, 9.4],
      precipitation: [0.0, 0.5],
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      time: '2026-05-30T00:00',
      temperature_2m: 10.1,
      precipitation: 0.0,
    });
    expect(result[1]).toEqual({
      time: '2026-05-30T01:00',
      temperature_2m: 9.4,
      precipitation: 0.5,
    });
  });

  it('preserves null values in arrays (e.g. ocean_current_velocity inland)', () => {
    const result = reshapeColumnar({
      time: ['2026-05-30T00:00'],
      ocean_current_velocity: [null],
    });

    expect(result[0]).toEqual({ time: '2026-05-30T00:00', ocean_current_velocity: null });
  });

  it('handles a single-element block', () => {
    const result = reshapeColumnar({
      time: ['2026-05-30'],
      temperature_2m_max: [15.9],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ time: '2026-05-30', temperature_2m_max: 15.9 });
  });

  it('units are NOT included in records — they live in the units map', () => {
    const result = reshapeColumnar({
      time: ['2026-05-30T00:00'],
      temperature_2m: [10.1],
    });
    expect(result[0]).not.toHaveProperty('unit');
    expect(result[0]).not.toHaveProperty('temperature_2m_unit');
  });

  it('exact parallel alignment across four variables × three timestamps', () => {
    // The central correctness risk: variable[i] must map to time[i] for every variable.
    const result = reshapeColumnar({
      time: ['T0', 'T1', 'T2'],
      var_a: [100, 200, 300],
      var_b: [10, 20, 30],
      var_c: [1, 2, 3],
      var_d: [0.1, 0.2, 0.3],
    });

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ time: 'T0', var_a: 100, var_b: 10, var_c: 1, var_d: 0.1 });
    expect(result[1]).toEqual({ time: 'T1', var_a: 200, var_b: 20, var_c: 2, var_d: 0.2 });
    expect(result[2]).toEqual({ time: 'T2', var_a: 300, var_b: 30, var_c: 3, var_d: 0.3 });
  });

  it('null in the middle of an array aligns correctly with adjacent real values', () => {
    // A mid-array null for one variable should not shift subsequent values.
    const result = reshapeColumnar({
      time: ['T0', 'T1', 'T2'],
      wave_height: [1.0, null, 3.0],
      wave_period: [8.0, 8.5, 9.0],
    });

    expect(result[0]).toEqual({ time: 'T0', wave_height: 1.0, wave_period: 8.0 });
    expect(result[1]).toEqual({ time: 'T1', wave_height: null, wave_period: 8.5 });
    expect(result[2]).toEqual({ time: 'T2', wave_height: 3.0, wave_period: 9.0 });
  });

  it('all-null variable produces null at every position', () => {
    const result = reshapeColumnar({
      time: ['T0', 'T1'],
      ocean_current_velocity: [null, null],
      wave_height: [1.0, 2.0],
    });

    expect(result[0]?.ocean_current_velocity).toBeNull();
    expect(result[1]?.ocean_current_velocity).toBeNull();
    // The other variable is unaffected
    expect(result[0]?.wave_height).toBe(1.0);
    expect(result[1]?.wave_height).toBe(2.0);
  });

  it('time-only block (no variables) produces records with only the time field', () => {
    // Edge case: the API should never send this, but reshapeColumnar must not crash.
    const result = reshapeColumnar({ time: ['T0', 'T1'] });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ time: 'T0' });
    expect(result[1]).toEqual({ time: 'T1' });
  });
});

describe('formatUnits', () => {
  it('formats a units map as a readable string', () => {
    const out = formatUnits({ time: 'iso8601', temperature_2m: '°C', precipitation: 'mm' });
    expect(out).toBe('time: iso8601 | temperature_2m: °C | precipitation: mm');
  });

  it('returns empty string for undefined', () => {
    expect(formatUnits(undefined)).toBe('');
  });

  it('includes the time key in the formatted string (#24)', () => {
    // Upstream gives time a real unit (iso8601) and structuredContent.*_units keeps
    // it — dropping it here left content[] carrying an incomplete units map for
    // text-only clients.
    const out = formatUnits({ time: 'iso8601', pm2_5: 'μg/m³' });
    expect(out).toContain('time: iso8601');
    expect(out).toContain('pm2_5: μg/m³');
  });

  it('formats a map with no time entry unchanged', () => {
    expect(formatUnits({ river_discharge: 'm³/s' })).toBe('river_discharge: m³/s');
  });
});

describe('formatRecord', () => {
  it('renders time as the leading label and omits it from the variable list', () => {
    // formatRecord's time exclusion is unrelated to formatUnits' — a record's
    // timestamp is already its leading label, so repeating it in the per-variable
    // listing would be redundant. A units map has no such leading label, which is
    // why the two functions treat `time` differently.
    expect(formatRecord({ time: '2024-07-01T00:00', temperature_2m: 18, precipitation: 0 })).toBe(
      '**2024-07-01T00:00** — temperature_2m: 18 | precipitation: 0',
    );
  });

  it('renders null values explicitly rather than dropping them', () => {
    expect(formatRecord({ time: '2024-07-01', river_discharge: null })).toBe(
      '**2024-07-01** — river_discharge: null',
    );
  });
});
