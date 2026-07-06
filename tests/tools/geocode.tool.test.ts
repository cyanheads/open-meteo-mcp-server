/**
 * @fileoverview Tests for openmeteo_geocode tool.
 * @module tests/tools/geocode.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoGeocodeTool } from '@/mcp-server/tools/definitions/geocode.tool.js';

const mockGetGeocode = vi.fn();

vi.mock('@/services/open-meteo/open-meteo-service.js', () => ({
  getOpenMeteoService: () => ({ getGeocode: mockGetGeocode }),
}));

const SEATTLE_RESULT = {
  id: 5809844,
  name: 'Seattle',
  latitude: 47.60621,
  longitude: -122.33207,
  elevation: 56.0,
  feature_code: 'PPLA2',
  country_code: 'US',
  country: 'United States',
  admin1: 'Washington',
  admin2: 'King',
  timezone: 'America/Los_Angeles',
  population: 780995,
};

/**
 * Real upstream shape for a continent feature (search "Antarctica"): the API
 * omits country, country_code, admin1, and admin2 entirely for feature_code CONT.
 */
const ANTARCTICA_CONT_RESULT = {
  id: 6255152,
  name: 'Antarctica',
  latitude: -78.15856,
  longitude: 16.40626,
  elevation: 3199.0,
  feature_code: 'CONT',
  timezone: 'Antarctica/Syowa',
  population: 1100,
};

/** Real upstream result for name="上海" under language="zh". */
const SHANGHAI_ZH_RESULT = {
  id: 1796236,
  name: '上海',
  latitude: 31.22222,
  longitude: 121.45806,
  elevation: 12.0,
  feature_code: 'PPLA',
  country_code: 'CN',
  timezone: 'Asia/Shanghai',
  population: 24874500,
  country: '中国',
  admin1: '上海市',
  admin2: '上海市',
};

/** Ambiguous name spanning countries — "Paris" resolves to France and the US. */
const PARIS_FR = {
  id: 2988507,
  name: 'Paris',
  latitude: 48.85341,
  longitude: 2.3488,
  elevation: 42.0,
  feature_code: 'PPLC',
  country_code: 'FR',
  country: 'France',
  admin1: 'Île-de-France',
  admin2: 'Paris',
  timezone: 'Europe/Paris',
  population: 2138551,
};

const PARIS_US = {
  id: 4717560,
  name: 'Paris',
  latitude: 33.66094,
  longitude: -95.55551,
  elevation: 183.0,
  feature_code: 'PPLA2',
  country_code: 'US',
  country: 'United States',
  admin1: 'Texas',
  admin2: 'Lamar',
  timezone: 'America/Chicago',
  population: 25171,
};

describe('openmeteoGeocodeTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ranked geocoding results', async () => {
    mockGetGeocode.mockResolvedValue({ results: [SEATTLE_RESULT] });
    const ctx = createMockContext();
    const input = openmeteoGeocodeTool.input.parse({ name: 'Seattle' });
    const result = await openmeteoGeocodeTool.handler(input, ctx);

    expect(result.count).toBe(1);
    expect(result.results[0]?.name).toBe('Seattle');
    expect(result.results[0]?.latitude).toBe(47.60621);
    expect(result.results[0]?.timezone).toBe('America/Los_Angeles');
  });

  it('throws no_results with correct code when results key is absent', async () => {
    // API returns {} without results key on no-match — guard: results ?? []
    mockGetGeocode.mockResolvedValue({ generationtime_ms: 0.085 });
    const ctx = createMockContext({ errors: openmeteoGeocodeTool.errors });
    const input = openmeteoGeocodeTool.input.parse({ name: 'zzzznotaplace' });
    await expect(openmeteoGeocodeTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'no_results',
        // Declared contract recovery flows to the wire (data.recovery.hint)
        recovery: { hint: expect.stringContaining('spelling') },
      },
    });
  });

  it('throws no_results when results array is empty', async () => {
    mockGetGeocode.mockResolvedValue({ results: [], generationtime_ms: 0.1 });
    const ctx = createMockContext({ errors: openmeteoGeocodeTool.errors });
    const input = openmeteoGeocodeTool.input.parse({ name: 'zzzznotaplace' });
    await expect(openmeteoGeocodeTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results' },
    });
  });

  it('no_results recovery covers both dropping an admin qualifier and querying the nearest town for a physical feature', async () => {
    mockGetGeocode.mockResolvedValue({ generationtime_ms: 0.1 });
    const ctx = createMockContext({ errors: openmeteoGeocodeTool.errors });
    const input = openmeteoGeocodeTool.input.parse({ name: 'Baoding Hebei' });
    const err = (await openmeteoGeocodeTool.handler(input, ctx).catch((e: unknown) => e)) as {
      data: { recovery: { hint: string } };
    };
    const hint = err.data.recovery.hint;
    // Administrative-qualifier strand: drop the qualifier, search the bare name.
    expect(hint).toMatch(/Baoding/);
    expect(hint).toMatch(/drop|bare place name|qualifier/i);
    // Gazetteer-feature strand: populated-places-only, query the nearest town instead.
    expect(hint).toMatch(/populated places/i);
    expect(hint).toMatch(/nearest town/i);
  });

  it('tolerates results missing country/country_code (continent features)', async () => {
    mockGetGeocode.mockResolvedValue({ results: [ANTARCTICA_CONT_RESULT] });
    const ctx = createMockContext();
    const input = openmeteoGeocodeTool.input.parse({ name: 'Antarctica' });
    const result = await openmeteoGeocodeTool.handler(input, ctx);

    expect(result.count).toBe(1);
    expect(result.results[0]?.country).toBeNull();
    expect(result.results[0]?.country_code).toBeNull();
    expect(result.results[0]?.admin1).toBeNull();
    expect(result.results[0]?.timezone).toBe('Antarctica/Syowa');
    // Output schema must accept the sparse shape
    expect(() => openmeteoGeocodeTool.output.parse(result)).not.toThrow();
  });

  it('retries once with a script-inferred language when a non-ASCII query misses under default "en"', async () => {
    mockGetGeocode
      .mockResolvedValueOnce({ generationtime_ms: 0.1 }) // en pass: no results key
      .mockResolvedValueOnce({ results: [SHANGHAI_ZH_RESULT] });
    const ctx = createMockContext();
    const input = openmeteoGeocodeTool.input.parse({ name: '上海' });
    const result = await openmeteoGeocodeTool.handler(input, ctx);

    expect(mockGetGeocode).toHaveBeenCalledTimes(2);
    expect(mockGetGeocode).toHaveBeenNthCalledWith(1, '上海', 5, 'en', undefined, ctx);
    expect(mockGetGeocode).toHaveBeenNthCalledWith(2, '上海', 5, 'zh', undefined, ctx);
    expect(result.results[0]?.name).toBe('上海');
    expect(result.results[0]?.country_code).toBe('CN');
    expect(result.results[0]?.latitude).toBe(31.22222);
  });

  it('retry path survives sparse results missing country', async () => {
    mockGetGeocode.mockResolvedValueOnce({ generationtime_ms: 0.1 }).mockResolvedValueOnce({
      results: [{ ...SHANGHAI_ZH_RESULT, country: undefined, country_code: undefined }],
    });
    const ctx = createMockContext();
    const input = openmeteoGeocodeTool.input.parse({ name: '上海' });
    const result = await openmeteoGeocodeTool.handler(input, ctx);

    expect(result.count).toBe(1);
    expect(result.results[0]?.country).toBeNull();
    expect(result.results[0]?.country_code).toBeNull();
  });

  it('does not retry an ASCII query — throws no_results after one pass', async () => {
    mockGetGeocode.mockResolvedValue({ generationtime_ms: 0.1 });
    const ctx = createMockContext({ errors: openmeteoGeocodeTool.errors });
    const input = openmeteoGeocodeTool.input.parse({ name: 'zzzznotaplace' });
    await expect(openmeteoGeocodeTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results' },
    });
    expect(mockGetGeocode).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the caller set a non-default language', async () => {
    mockGetGeocode.mockResolvedValue({ generationtime_ms: 0.1 });
    const ctx = createMockContext({ errors: openmeteoGeocodeTool.errors });
    const input = openmeteoGeocodeTool.input.parse({ name: '上海', language: 'de' });
    await expect(openmeteoGeocodeTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results' },
    });
    expect(mockGetGeocode).toHaveBeenCalledTimes(1);
    expect(mockGetGeocode).toHaveBeenCalledWith('上海', 5, 'de', undefined, ctx);
  });

  it('narrows an ambiguous name to the requested country and changes the top match', async () => {
    // Upstream filters to countryCode when set; "Paris" spans FR + US unfiltered.
    mockGetGeocode.mockImplementation((...args: unknown[]) => {
      const country = args[3] as string | undefined;
      return Promise.resolve({ results: country === 'US' ? [PARIS_US] : [PARIS_FR, PARIS_US] });
    });
    const ctx = createMockContext();

    const unfiltered = await openmeteoGeocodeTool.handler(
      openmeteoGeocodeTool.input.parse({ name: 'Paris' }),
      ctx,
    );
    const filtered = await openmeteoGeocodeTool.handler(
      openmeteoGeocodeTool.input.parse({ name: 'Paris', country: 'US' }),
      ctx,
    );

    expect(unfiltered.results[0]?.country_code).toBe('FR');
    expect(filtered.results[0]?.country_code).toBe('US');
    // Identity change, not merely a narrower count.
    expect(filtered.results[0]?.country_code).not.toBe(unfiltered.results[0]?.country_code);
  });

  it('uppercases a lowercase country code before querying upstream', async () => {
    mockGetGeocode.mockResolvedValue({ results: [PARIS_US] });
    const ctx = createMockContext();
    const input = openmeteoGeocodeTool.input.parse({ name: 'Paris', country: 'us' });
    await openmeteoGeocodeTool.handler(input, ctx);
    // Lowercase accepted by the schema, normalized to uppercase for the upstream countryCode filter.
    expect(mockGetGeocode).toHaveBeenCalledWith('Paris', 5, 'en', 'US', ctx);
  });

  it('rejects a malformed country code at the schema boundary', () => {
    // Three- and one-letter codes fail validation instead of silently returning no_results.
    expect(() => openmeteoGeocodeTool.input.parse({ name: 'Paris', country: 'USA' })).toThrow();
    expect(() => openmeteoGeocodeTool.input.parse({ name: 'Paris', country: 'U' })).toThrow();
  });

  it('normalises nullable fields', async () => {
    const partialResult = {
      ...SEATTLE_RESULT,
      elevation: null,
      population: null,
      admin1: null,
      admin2: null,
    };
    mockGetGeocode.mockResolvedValue({ results: [partialResult] });
    const ctx = createMockContext();
    const input = openmeteoGeocodeTool.input.parse({ name: 'SomePlace' });
    const result = await openmeteoGeocodeTool.handler(input, ctx);
    expect(result.results[0]?.elevation).toBeNull();
    expect(result.results[0]?.population).toBeNull();
    expect(result.results[0]?.admin1).toBeNull();
  });

  it('formats results as markdown', () => {
    const blocks = openmeteoGeocodeTool.format!({
      results: [
        {
          id: 1,
          name: 'Seattle',
          latitude: 47.6,
          longitude: -122.3,
          elevation: 56,
          timezone: 'America/Los_Angeles',
          country: 'United States',
          country_code: 'US',
          admin1: 'Washington',
          admin2: null,
          population: 780000,
          feature_code: 'PPLA2',
        },
      ],
      count: 1,
    });
    expect(blocks[0]?.type).toBe('text');
    expect(blocks[0]?.text).toContain('Seattle');
    expect(blocks[0]?.text).toContain('Open-Meteo.com');
  });

  it('format omits country markers instead of rendering null for sparse results', () => {
    const blocks = openmeteoGeocodeTool.format!({
      results: [
        {
          id: 6255152,
          name: 'Antarctica',
          latitude: -78.15856,
          longitude: 16.40626,
          elevation: 3199,
          timezone: null,
          country: null,
          country_code: null,
          admin1: null,
          admin2: null,
          population: 1100,
          feature_code: 'CONT',
        },
      ],
      count: 1,
    });
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('Antarctica');
    expect(text).not.toContain('null');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('()');
  });
});
