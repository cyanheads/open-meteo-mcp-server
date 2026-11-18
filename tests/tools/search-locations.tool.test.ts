/**
 * @fileoverview Tests for openmeteo_search_locations tool.
 * @module tests/tools/search-locations.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoSearchLocationsTool } from '@/mcp-server/tools/definitions/search-locations.tool.js';
import { renderedText } from '../helpers/commonmark.js';
import { firstText } from '../helpers/content.js';
import { wireError } from '../helpers/wire-error.js';

const mockGetGeocode = vi.fn();

vi.mock('@/services/open-meteo/open-meteo-service.js', () => ({
  getOpenMeteoService: () => ({ getGeocode: mockGetGeocode }),
}));

/** Stands in for every counter the tool creates, so a test can count its increments. */
const clampCounter = vi.hoisted(() => ({ add: vi.fn() }));

/** Hands out {@link clampCounter}, recording the metric name each counter is created under. */
const createCounter = vi.hoisted(() => vi.fn((_name: string) => clampCounter));

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter,
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

describe('openmeteoSearchLocationsTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ranked geocoding results', async () => {
    mockGetGeocode.mockResolvedValue({ results: [SEATTLE_RESULT] });
    const ctx = createMockContext({ errors: openmeteoSearchLocationsTool.errors });
    const input = openmeteoSearchLocationsTool.input.parse({ name: 'Seattle' });
    const result = await openmeteoSearchLocationsTool.handler(input, ctx);

    expect(result.count).toBe(1);
    expect(result.results[0]?.name).toBe('Seattle');
    expect(result.results[0]?.latitude).toBe(47.60621);
    expect(result.results[0]?.timezone).toBe('America/Los_Angeles');
  });

  it('throws no_results with correct code when results key is absent', async () => {
    // API returns {} without results key on no-match — guard: results ?? []
    mockGetGeocode.mockResolvedValue({ generationtime_ms: 0.085 });
    const input = openmeteoSearchLocationsTool.input.parse({ name: 'zzzznotaplace' });
    await expect(wireError(openmeteoSearchLocationsTool, input)).resolves.toMatchObject({
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
    const ctx = createMockContext({ errors: openmeteoSearchLocationsTool.errors });
    const input = openmeteoSearchLocationsTool.input.parse({ name: 'zzzznotaplace' });
    await expect(openmeteoSearchLocationsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results' },
    });
  });

  it('no_results recovery covers both dropping an admin qualifier and querying the nearest town for a physical feature', async () => {
    mockGetGeocode.mockResolvedValue({ generationtime_ms: 0.1 });
    const input = openmeteoSearchLocationsTool.input.parse({ name: 'Baoding Hebei' });
    const hint = (await wireError(openmeteoSearchLocationsTool, input)).data?.recovery?.hint;
    // Administrative-qualifier strand: drop the qualifier, search the bare name.
    expect(hint).toMatch(/Baoding/);
    expect(hint).toMatch(/drop|bare place name|qualifier/i);
    // Gazetteer-feature strand: populated-places-only, query the nearest town instead.
    expect(hint).toMatch(/populated places/i);
    expect(hint).toMatch(/nearest town/i);
  });

  it('no_results recovery names the full-administrative-name and romanized fallback for a short native-script query (#46)', async () => {
    /*
     * Upstream exact-matches a one- or two-character query and prefix-matches anything
     * longer, so "서울" misses even under language "ko" — the indexed name is
     * "서울특별시". The tool's script-inferred retry already covers 3+ character names;
     * the recovery has to name what a caller retries a short one with.
     */
    mockGetGeocode.mockResolvedValue({ generationtime_ms: 0.1 });
    const input = openmeteoSearchLocationsTool.input.parse({ name: '서울' });
    const hint = (await wireError(openmeteoSearchLocationsTool, input)).data?.recovery?.hint;

    expect(hint).toMatch(/one- or two-character|1-2 character/i);
    // Both working next steps: the full administrative name and the romanized name.
    expect(hint).toMatch(/서울특별시/);
    expect(hint).toMatch(/romani[sz]ed/i);
    // And it must not send the caller back to a language override, which cannot help here.
    expect(hint).toMatch(/language alone/i);
  });

  it.each([
    ['name', () => openmeteoSearchLocationsTool.input.shape.name.description ?? ''],
    ['language', () => openmeteoSearchLocationsTool.input.shape.language.description ?? ''],
  ])('the %s field description carries the short-native-name fallback (#46)', (_field, read) => {
    const text = read();
    expect(text).toMatch(/서울특별시|大阪市/);
    expect(text).toMatch(/romani[sz]ed/i);
  });

  it('the language field description states the three-or-more-character threshold (#46)', () => {
    const text = openmeteoSearchLocationsTool.input.shape.language.description ?? '';
    expect(text).toMatch(/three or more characters/i);
    expect(text).toMatch(/language alone/i);
  });

  it('tolerates results missing country/country_code (continent features)', async () => {
    mockGetGeocode.mockResolvedValue({ results: [ANTARCTICA_CONT_RESULT] });
    const ctx = createMockContext({ errors: openmeteoSearchLocationsTool.errors });
    const input = openmeteoSearchLocationsTool.input.parse({ name: 'Antarctica' });
    const result = await openmeteoSearchLocationsTool.handler(input, ctx);

    expect(result.count).toBe(1);
    expect(result.results[0]?.country).toBeNull();
    expect(result.results[0]?.country_code).toBeNull();
    expect(result.results[0]?.admin1).toBeNull();
    expect(result.results[0]?.timezone).toBe('Antarctica/Syowa');
    // Output schema must accept the sparse shape
    expect(() => openmeteoSearchLocationsTool.output.parse(result)).not.toThrow();
  });

  it('retries once with a script-inferred language when a non-ASCII query misses under default "en"', async () => {
    mockGetGeocode
      .mockResolvedValueOnce({ generationtime_ms: 0.1 }) // en pass: no results key
      .mockResolvedValueOnce({ results: [SHANGHAI_ZH_RESULT] });
    const ctx = createMockContext({ errors: openmeteoSearchLocationsTool.errors });
    const input = openmeteoSearchLocationsTool.input.parse({ name: '上海' });
    const result = await openmeteoSearchLocationsTool.handler(input, ctx);

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
    const ctx = createMockContext({ errors: openmeteoSearchLocationsTool.errors });
    const input = openmeteoSearchLocationsTool.input.parse({ name: '上海' });
    const result = await openmeteoSearchLocationsTool.handler(input, ctx);

    expect(result.count).toBe(1);
    expect(result.results[0]?.country).toBeNull();
    expect(result.results[0]?.country_code).toBeNull();
  });

  it('does not retry an ASCII query — throws no_results after one pass', async () => {
    mockGetGeocode.mockResolvedValue({ generationtime_ms: 0.1 });
    const ctx = createMockContext({ errors: openmeteoSearchLocationsTool.errors });
    const input = openmeteoSearchLocationsTool.input.parse({ name: 'zzzznotaplace' });
    await expect(openmeteoSearchLocationsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results' },
    });
    expect(mockGetGeocode).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the caller set a non-default language', async () => {
    mockGetGeocode.mockResolvedValue({ generationtime_ms: 0.1 });
    const ctx = createMockContext({ errors: openmeteoSearchLocationsTool.errors });
    const input = openmeteoSearchLocationsTool.input.parse({ name: '上海', language: 'de' });
    await expect(openmeteoSearchLocationsTool.handler(input, ctx)).rejects.toMatchObject({
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
    const ctx = createMockContext({ errors: openmeteoSearchLocationsTool.errors });

    const unfiltered = await openmeteoSearchLocationsTool.handler(
      openmeteoSearchLocationsTool.input.parse({ name: 'Paris' }),
      ctx,
    );
    const filtered = await openmeteoSearchLocationsTool.handler(
      openmeteoSearchLocationsTool.input.parse({ name: 'Paris', country: 'US' }),
      ctx,
    );

    expect(unfiltered.results[0]?.country_code).toBe('FR');
    expect(filtered.results[0]?.country_code).toBe('US');
    // Identity change, not merely a narrower count.
    expect(filtered.results[0]?.country_code).not.toBe(unfiltered.results[0]?.country_code);
  });

  it('uppercases a lowercase country code before querying upstream', async () => {
    mockGetGeocode.mockResolvedValue({ results: [PARIS_US] });
    const ctx = createMockContext({ errors: openmeteoSearchLocationsTool.errors });
    const input = openmeteoSearchLocationsTool.input.parse({ name: 'Paris', country: 'us' });
    await openmeteoSearchLocationsTool.handler(input, ctx);
    // Lowercase accepted by the schema, normalized to uppercase for the upstream countryCode filter.
    expect(mockGetGeocode).toHaveBeenCalledWith('Paris', 5, 'en', 'US', ctx);
  });

  it('rejects a malformed country code at the schema boundary', () => {
    // Three- and one-letter codes fail validation instead of silently returning no_results.
    expect(() =>
      openmeteoSearchLocationsTool.input.parse({ name: 'Paris', country: 'USA' }),
    ).toThrow();
    expect(() =>
      openmeteoSearchLocationsTool.input.parse({ name: 'Paris', country: 'U' }),
    ).toThrow();
  });

  it.each(['USA', 'Netherlands', ''])(
    'rejects country %j with the alpha-2 rule on every surface (#97)',
    async (country) => {
      const rule =
        'country: Must be an ISO 3166-1 alpha-2 code: two letters such as "NL" or "US", not a country name or a three-letter code. Omit country to search globally.';

      const result = await runToolContract(openmeteoSearchLocationsTool, {
        name: 'Utrecht',
        country,
      });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as {
        error: { code: number; message: string; data?: { recovery?: { hint: string } } };
      };
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.message).toBe(
        `Input validation error: Invalid arguments for tool openmeteo_search_locations: ${rule}`,
      );
      expect(error.data?.recovery?.hint).toBe(rule);
      expect(firstText(result.content)).toContain(`openmeteo_search_locations: ${rule}`);
      expect(mockGetGeocode).not.toHaveBeenCalled();
    },
  );

  it('validates NL, nl, and Nl alike and sends NL upstream', async () => {
    mockGetGeocode.mockResolvedValue({ results: [PARIS_FR] });

    const results = [];
    for (const country of ['NL', 'nl', 'Nl']) {
      results.push(
        await runToolContract(openmeteoSearchLocationsTool, { name: 'Utrecht', country }),
      );
    }

    expect(mockGetGeocode.mock.calls.map((call) => call.slice(0, 4))).toEqual([
      ['Utrecht', 5, 'en', 'NL'],
      ['Utrecht', 5, 'en', 'NL'],
      ['Utrecht', 5, 'en', 'NL'],
    ]);
    expect(results.map((result) => result.isError === true)).toEqual([false, false, false]);
    expect(results[1]?.structuredContent).toEqual(results[0]?.structuredContent);
    expect(results[2]?.structuredContent).toEqual(results[0]?.structuredContent);
  });

  it('advertises country with its two-letter pattern', () => {
    const advertised = openmeteoSearchLocationsTool.input['~standard'].jsonSchema.input({
      target: 'draft-2020-12',
    }) as { properties: Record<string, unknown> };

    expect(advertised.properties.country).toStrictEqual({
      description:
        'ISO 3166-1 alpha-2 country code (e.g. "US", "FR") to disambiguate places that share a name. Omit for a global search.',
      type: 'string',
      pattern: '^[A-Za-z]{2}$',
    });
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
    const ctx = createMockContext({ errors: openmeteoSearchLocationsTool.errors });
    const input = openmeteoSearchLocationsTool.input.parse({ name: 'SomePlace' });
    const result = await openmeteoSearchLocationsTool.handler(input, ctx);
    expect(result.results[0]?.elevation).toBeNull();
    expect(result.results[0]?.population).toBeNull();
    expect(result.results[0]?.admin1).toBeNull();
  });

  it('formats results as markdown', () => {
    const blocks = openmeteoSearchLocationsTool.format!({
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
    expect(firstText(blocks)).toContain('Seattle');
    expect(firstText(blocks)).toContain('Open-Meteo.com');
  });

  it('format omits country markers instead of rendering null for sparse results', () => {
    const blocks = openmeteoSearchLocationsTool.format!({
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
    const text = firstText(blocks) ?? '';
    expect(text).toContain('Antarctica');
    expect(text).not.toContain('null');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('()');
  });

  it('format renders upstream place text as written under a CommonMark parse', () => {
    const blocks = openmeteoSearchLocationsTool.format!({
      results: [
        {
          id: 1,
          name: '*Star* [Town](x)',
          latitude: 1,
          longitude: 2,
          elevation: null,
          timezone: 'America/Los_Angeles',
          country: 'Land_',
          country_code: 'LD',
          admin1: '`Upper`',
          admin2: null,
          population: null,
          feature_code: 'PPL',
        },
      ],
      count: 1,
    });
    const text = renderedText(firstText(blocks));
    expect(text).toContain('*Star* [Town](x) (LD) — Land_, `Upper` — 1, 2');
    expect(text).toContain('timezone: America/Los_Angeles');
  });
});

describe('openmeteoSearchLocationsTool low-confidence notice (#48)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Live top result for name="Calcutta" — a South African village, not Kolkata. */
  const CALCUTTA_ZA = {
    id: 1004357,
    name: 'Calcutta',
    latitude: -24.7,
    longitude: 30.9,
    elevation: 800.0,
    feature_code: 'PPL',
    country_code: 'ZA',
    country: 'South Africa',
    admin1: 'Mpumalanga',
    admin2: null,
    timezone: 'Africa/Johannesburg',
    population: 35864,
  };

  /** Live top (and only) result for name="Bangalore" — a Karachi neighbourhood. */
  const BANGALORE_TOWN_PK = {
    id: 1184180,
    name: 'Bangalore Town',
    latitude: 24.8717,
    longitude: 67.0839,
    elevation: 12.0,
    feature_code: 'PPLX',
    country_code: 'PK',
    country: 'Pakistan',
    admin1: 'Sindh',
    admin2: null,
    timezone: 'Asia/Karachi',
    population: null,
  };

  const noticeFor = async (results: unknown[], name: string) => {
    mockGetGeocode.mockResolvedValue({ results });
    const ctx = createMockContext({ errors: openmeteoSearchLocationsTool.errors });
    const input = openmeteoSearchLocationsTool.input.parse({ name });
    const result = await openmeteoSearchLocationsTool.handler(input, ctx);
    return { notice: getEnrichment(ctx).notice as string | undefined, result };
  };

  it('declares an enrichment notice field, like the seven weather tools', () => {
    expect(openmeteoSearchLocationsTool.enrichment?.notice).toBeDefined();
    expect(openmeteoSearchLocationsTool.enrichment?.notice?.description ?? '').toMatch(
      /population/i,
    );
  });

  it('flags a null-population top result, naming place, country, and feature_code', async () => {
    const { notice } = await noticeFor([BANGALORE_TOWN_PK], 'Bangalore');
    expect(notice).toContain('Bangalore Town');
    expect(notice).toContain('Pakistan');
    expect(notice).toContain('PPLX');
    expect(notice).toMatch(/no recorded population/i);
    // The caller's own knowledge supplies the modern name — the server holds no table.
    expect(notice).toMatch(/official name/i);
    expect(notice).toMatch(/verify/i);
  });

  it('flags a small-population top result', async () => {
    const { notice } = await noticeFor([CALCUTTA_ZA], 'Calcutta');
    expect(notice).toContain('Calcutta');
    expect(notice).toContain('South Africa');
    expect(notice).toContain('PPL');
    expect(notice).toContain('35,864');
  });

  it('leaves a well-populated top result unflagged', async () => {
    const { notice } = await noticeFor([SEATTLE_RESULT], 'Seattle');
    expect(notice).toBeUndefined();
  });

  it('renders a Markdown-active place name literally in content[] and stores it raw', async () => {
    // `_Calcutta_` between quotes is emphasis to a CommonMark parse unless it is escaped.
    mockGetGeocode.mockResolvedValue({ results: [{ ...CALCUTTA_ZA, name: '_Calcutta_' }] });
    const result = await runToolContract(openmeteoSearchLocationsTool, { name: 'Calcutta' });
    expect(result.isError).toBeFalsy();
    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toMatch(/^Low-confidence match: the top result "_Calcutta_" \(South Africa, /);
    const trailer = result.content.at(-1);
    expect(renderedText(trailer?.type === 'text' ? trailer.text : '')).toContain(notice);
  });

  it.each([
    ['Bengaluru', 8495492],
    ['Mumbai', 12691836],
    ['Chennai', 4681087],
    ['Kolkata', 4631392],
    ['Beijing', 18960744],
    ['Ho Chi Minh City', 14002598],
    ['Paris', 2138551],
    ['Baoding', 1132000],
    ['Springfield', 166810],
    ['Seattle', 780995],
  ])('%s resolves unflagged at population %d', async (name, population) => {
    const { notice } = await noticeFor([{ ...SEATTLE_RESULT, name, population }], name);
    expect(notice).toBeUndefined();
  });

  it('flags every reproduced exonym miss', async () => {
    for (const [name, population] of [
      ['Bangalore Town', null],
      ['Bombay', null],
      ['Madras', 6662],
      ['Calcutta', 35864],
      ['Peking', null],
      ['Saigon', null],
    ] as [string, number | null][]) {
      const { notice } = await noticeFor([{ ...CALCUTTA_ZA, name, population }], name);
      expect(notice, name).toBeDefined();
    }
  });

  it('does not flag at the threshold, and flags one below it', async () => {
    expect(
      (await noticeFor([{ ...SEATTLE_RESULT, population: 100_000 }], 'X')).notice,
    ).toBeUndefined();
    expect(
      (await noticeFor([{ ...SEATTLE_RESULT, population: 99_999 }], 'X')).notice,
    ).toBeDefined();
  });

  it('reads the top result only — a low-population lead flags despite a large runner-up', async () => {
    const { notice, result } = await noticeFor([CALCUTTA_ZA, SEATTLE_RESULT], 'Calcutta');
    expect(notice).toContain('Calcutta');
    expect(result.count).toBe(2);
  });

  it('is advisory — results and count are untouched, and no_results never fires', async () => {
    const { notice, result } = await noticeFor([BANGALORE_TOWN_PK], 'Bangalore');
    expect(notice).toBeDefined();
    expect(result.count).toBe(1);
    expect(result.results[0]?.name).toBe('Bangalore Town');
    expect(result.results[0]?.latitude).toBe(24.8717);
    expect(() => openmeteoSearchLocationsTool.output.parse(result)).not.toThrow();
  });

  it('names a countryless feature without rendering a null', async () => {
    const { notice } = await noticeFor([ANTARCTICA_CONT_RESULT], 'Antarctica');
    expect(notice).toContain('Antarctica');
    expect(notice).toContain('CONT');
    expect(notice).not.toContain('null');
    expect(notice).not.toContain('undefined');
  });

  it('still throws no_results when nothing matched at all', async () => {
    mockGetGeocode.mockResolvedValue({ generationtime_ms: 0.1 });
    const ctx = createMockContext({ errors: openmeteoSearchLocationsTool.errors });
    const input = openmeteoSearchLocationsTool.input.parse({ name: 'zzzznotaplace' });
    await expect(openmeteoSearchLocationsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results' },
    });
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('flags a result reached through the script-inferred retry the same way', async () => {
    mockGetGeocode
      .mockResolvedValueOnce({ generationtime_ms: 0.1 })
      .mockResolvedValueOnce({ results: [{ ...SHANGHAI_ZH_RESULT, population: 900 }] });
    const ctx = createMockContext({ errors: openmeteoSearchLocationsTool.errors });
    const input = openmeteoSearchLocationsTool.input.parse({ name: '上海' });
    await openmeteoSearchLocationsTool.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toContain('上海');
  });

  it('format() output is unchanged by the notice — it rides the enrichment trailer', async () => {
    const { result } = await noticeFor([BANGALORE_TOWN_PK], 'Bangalore');
    const text = firstText(openmeteoSearchLocationsTool.format!(result));
    expect(text).toContain('Bangalore Town');
    expect(text).not.toMatch(/official name/i);
  });
});

describe('openmeteoSearchLocationsTool effective_language (#69)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  type SearchResult = Awaited<ReturnType<typeof runToolContract>>;

  const structured = (result: SearchResult) =>
    result.structuredContent as { effective_language?: string; notice?: string; count?: number };

  // content[] read as a client renders it, so assertions survive framework escape and code-span changes.
  const allText = (result: SearchResult) =>
    renderedText(
      result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
    );

  it('declares effective_language as an optional enrichment field', () => {
    const field = openmeteoSearchLocationsTool.enrichment?.effective_language;
    expect(field?.isOptional()).toBe(true);
    expect(field?.description ?? '').toMatch(/name, country, admin1, and admin2/);
  });

  it('reports the inferred language on both surfaces when the retry produced the results', async () => {
    mockGetGeocode
      .mockResolvedValueOnce({ generationtime_ms: 0.1 })
      .mockResolvedValueOnce({ results: [SHANGHAI_ZH_RESULT] });

    const result = await runToolContract(openmeteoSearchLocationsTool, { name: '上海' });

    expect(result.isError).toBeFalsy();
    expect(structured(result).effective_language).toBe('zh');
    expect(allText(result)).toContain('Effective language: zh');
    // results, count, and notice are unchanged by the new field.
    expect(structured(result).count).toBe(1);
    expect(structured(result).notice).toBeUndefined();
  });

  it.each([
    ['ja', 'さっぽろ', { ...SHANGHAI_ZH_RESULT, name: '札幌市' }],
    ['ko', '서울특별시', { ...SHANGHAI_ZH_RESULT, name: '서울특별시' }],
    ['ru', 'Москва', { ...SHANGHAI_ZH_RESULT, name: 'Москва' }],
  ])('reports %s for a %s retry hit', async (language, name, hit) => {
    mockGetGeocode
      .mockResolvedValueOnce({ generationtime_ms: 0.1 })
      .mockResolvedValueOnce({ results: [hit] });

    const result = await runToolContract(openmeteoSearchLocationsTool, { name });

    expect(mockGetGeocode).toHaveBeenNthCalledWith(
      2,
      name,
      5,
      language,
      undefined,
      expect.anything(),
    );
    expect(structured(result).effective_language).toBe(language);
    expect(allText(result)).toContain(`Effective language: ${language}`);
  });

  it('carries no effective_language on a first-pass hit', async () => {
    mockGetGeocode.mockResolvedValue({ results: [SEATTLE_RESULT] });

    const result = await runToolContract(openmeteoSearchLocationsTool, { name: 'Seattle' });

    expect(mockGetGeocode).toHaveBeenCalledTimes(1);
    expect(structured(result)).not.toHaveProperty('effective_language');
    expect(allText(result)).not.toContain('Effective language');
  });

  it('carries no effective_language on a native-script first-pass hit', async () => {
    mockGetGeocode.mockResolvedValue({ results: [SHANGHAI_ZH_RESULT] });

    const result = await runToolContract(openmeteoSearchLocationsTool, { name: '上海' });

    expect(mockGetGeocode).toHaveBeenCalledTimes(1);
    expect(structured(result)).not.toHaveProperty('effective_language');
    expect(allText(result)).not.toContain('Effective language');
  });

  it('carries no effective_language when the caller set the language — one call, no retry', async () => {
    mockGetGeocode.mockResolvedValue({ results: [{ ...SHANGHAI_ZH_RESULT, name: 'Shanghai' }] });

    const result = await runToolContract(openmeteoSearchLocationsTool, {
      name: '上海',
      language: 'de',
    });

    expect(mockGetGeocode).toHaveBeenCalledTimes(1);
    expect(mockGetGeocode).toHaveBeenCalledWith('上海', 5, 'de', undefined, expect.anything());
    expect(structured(result)).not.toHaveProperty('effective_language');
    expect(allText(result)).not.toContain('Effective language');
  });

  it('carries both the notice and effective_language on a low-population retry hit', async () => {
    mockGetGeocode
      .mockResolvedValueOnce({ generationtime_ms: 0.1 })
      .mockResolvedValueOnce({ results: [{ ...SHANGHAI_ZH_RESULT, population: 900 }] });

    const result = await runToolContract(openmeteoSearchLocationsTool, { name: '上海' });

    expect(structured(result).effective_language).toBe('zh');
    expect(structured(result).notice).toContain('Low-confidence match');
    expect(allText(result)).toContain('Effective language: zh');
    expect(allText(result)).toContain('Low-confidence match');
  });

  it('still throws no_results when the retry misses too, with no effective_language', async () => {
    mockGetGeocode.mockResolvedValue({ generationtime_ms: 0.1 });

    const result = await runToolContract(openmeteoSearchLocationsTool, { name: '上海' });

    expect(mockGetGeocode).toHaveBeenCalledTimes(2);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'no_results' } },
    });
    expect(allText(result)).not.toContain('Effective language');
  });
});

describe('openmeteoSearchLocationsTool count (#102)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A fresh tool module, so its server config parses the `OPENMETEO_CLAMP_LIMITS` stubbed here. */
  async function loadTool(clampLimits: string | undefined) {
    vi.resetModules();
    vi.stubEnv('OPENMETEO_CLAMP_LIMITS', clampLimits);
    return (await import('@/mcp-server/tools/definitions/search-locations.tool.js'))
      .openmeteoSearchLocationsTool;
  }

  /** The `count` property of the inputSchema tools/list advertises, as it crosses the wire. */
  function advertisedCount(tool: typeof openmeteoSearchLocationsTool): unknown {
    const schema = tool.input['~standard'].jsonSchema.input({ target: 'draft-2020-12' }) as {
      properties: Record<string, unknown>;
    };
    return JSON.parse(JSON.stringify(schema.properties.count));
  }

  type SearchResult = Awaited<ReturnType<typeof runToolContract>>;

  const noticeOf = (result: SearchResult) =>
    (result.structuredContent as { notice?: string }).notice;

  /** The notice trailer line in content[], as a CommonMark parse reads it. */
  const trailerOf = (result: SearchResult) => {
    const trailer = result.content.at(-1);
    return renderedText(trailer?.type === 'text' ? trailer.text : '');
  };

  /** The count each upstream call was sent, in call order. */
  const sentCounts = () => mockGetGeocode.mock.calls.map((call) => call[1]);

  /** `n` well-populated places sharing a name, ids 1…n in rank order. */
  const ranked = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      ...SEATTLE_RESULT,
      id: i + 1,
      name: 'Springfield',
      population: 900_000 - i,
    }));

  /** Live rank 11 for Springfield with country US — out of reach at count 10. */
  const SPRINGFIELD_PA = {
    id: 4561407,
    name: 'Springfield',
    latitude: 39.93067,
    longitude: -75.32019,
    elevation: 76.0,
    feature_code: 'PPL',
    country_code: 'US',
    country: 'United States',
    admin1: 'Pennsylvania',
    admin2: 'Delaware',
    timezone: 'America/New_York',
    population: 23363,
  };

  const CLAMPED_500 =
    'count 500 is above the geocoder’s maximum of 100 matches, so 100 was applied.';
  const COUNTRY_REMEDY =
    'The geocoder has no offset, so matches past the 100th are out of reach; set country to search one country’s matches alone.';
  const COUNT_TAIL =
    'Ask for more to reach smaller places that share a common name such as "Springfield" or "Portland": the geocoder has no offset, so a place ranked past count is reached only by a larger count or by setting country.';

  it.each([undefined, 1, 5, 10])(
    'sends count %s and returns the same output as before, with no notice',
    async (count) => {
      const tool = await loadTool(undefined);
      mockGetGeocode.mockResolvedValue({ results: [SEATTLE_RESULT] });

      const result = await runToolContract(tool, {
        name: 'Seattle',
        ...(count === undefined ? {} : { count }),
      });

      expect(mockGetGeocode.mock.calls.map((call) => call.slice(0, 4))).toEqual([
        ['Seattle', count ?? 5, 'en', undefined],
      ]);
      expect(result.structuredContent).toEqual({ results: [SEATTLE_RESULT], count: 1 });
      expect(clampCounter.add).not.toHaveBeenCalled();
    },
  );

  it('reads a count sent as the string "7" as the number 7', async () => {
    const tool = await loadTool(undefined);
    mockGetGeocode.mockResolvedValue({ results: [SEATTLE_RESULT] });

    const result = await runToolContract(tool, { name: 'Seattle', count: '7' as never });

    expect(result.isError).toBeFalsy();
    expect(sentCounts()).toEqual([7]);
  });

  it.each([11, 100])(
    'accepts count %i and returns every row the geocoder ranked',
    async (count) => {
      const tool = await loadTool(undefined);
      const rows = ranked(count);
      rows[10] = SPRINGFIELD_PA;
      mockGetGeocode.mockResolvedValue({ results: rows });

      const result = await runToolContract(tool, { name: 'Springfield', country: 'US', count });

      expect(result.isError).toBeFalsy();
      expect(sentCounts()).toEqual([count]);
      const structured = result.structuredContent as {
        count: number;
        results: { id: number; admin1: string | null }[];
      };
      expect(structured.count).toBe(count);
      expect(structured.results.map((r) => r.id)).toEqual(rows.map((r) => r.id));
      expect(structured.results[10]).toMatchObject({ id: 4561407, admin1: 'Pennsylvania' });
      expect(noticeOf(result)).toBeUndefined();
      expect(firstText(result.content)).toContain('United States, Pennsylvania, Delaware');
    },
  );

  it.each([
    [500, CLAMPED_500],
    [
      1e20,
      'count 100000000000000000000 is above the geocoder’s maximum of 100 matches, so 100 was applied.',
    ],
  ])('lowers count %d to 100 and says so on both surfaces', async (count, clamped) => {
    const tool = await loadTool(undefined);
    mockGetGeocode.mockResolvedValue({ results: ranked(100) });

    const result = await runToolContract(tool, { name: 'Springfield', country: 'US', count });

    expect(result.isError).toBeFalsy();
    expect(sentCounts()).toEqual([100]);
    expect(result.structuredContent).toMatchObject({ count: 100, notice: clamped });
    expect(trailerOf(result)).toBe(clamped);
  });

  it('names country as the way past the 100th match only when country was not set', async () => {
    const tool = await loadTool(undefined);
    mockGetGeocode.mockResolvedValue({ results: ranked(100) });

    const global = await runToolContract(tool, { name: 'Springfield', count: 500 });
    const inCountry = await runToolContract(tool, {
      name: 'Springfield',
      country: 'US',
      count: 500,
    });

    expect(noticeOf(global)).toBe(`${CLAMPED_500} ${COUNTRY_REMEDY}`);
    expect(trailerOf(global)).toBe(`${CLAMPED_500} ${COUNTRY_REMEDY}`);
    expect(noticeOf(inCountry)).toBe(CLAMPED_500);
  });

  it('logs one info line and adds one to the clamp counter per clamped call, and neither at 100', async () => {
    const tool = await loadTool(undefined);
    expect(createCounter.mock.calls.map(([name]) => name)).toEqual([
      'openmeteo.search_locations.count_clamped',
    ]);
    mockGetGeocode.mockResolvedValue({ results: ranked(100) });
    const call = async (count: number) => {
      const ctx = createMockContext({ errors: tool.errors });
      await tool.handler(tool.input.parse({ name: 'Springfield', count }), ctx);
      const lowered = (ctx.log as MockContextLogger).calls.filter(
        (c) => c.msg === 'Geocode count lowered to the geocoder maximum',
      );
      return { lowered, enrichment: getEnrichment(ctx) };
    };

    clampCounter.add.mockClear();
    const clamped = await call(500);
    expect(clamped.lowered).toEqual([
      {
        level: 'info',
        msg: 'Geocode count lowered to the geocoder maximum',
        data: expect.objectContaining({ requested: 500, applied: 100 }),
      },
    ]);
    expect(clampCounter.add).toHaveBeenCalledTimes(1);
    expect(clampCounter.add).toHaveBeenCalledWith(1);

    clampCounter.add.mockClear();
    const atCap = await call(100);
    expect(atCap.lowered).toEqual([]);
    expect(clampCounter.add).not.toHaveBeenCalled();
    expect(atCap.enrichment).toEqual({});
  });

  it('composes the clamp and the low-confidence advisory into one notice on both surfaces', async () => {
    const tool = await loadTool(undefined);
    mockGetGeocode.mockResolvedValue({ results: [SPRINGFIELD_PA, ...ranked(99)] });

    const result = await runToolContract(tool, {
      name: 'Springfield',
      country: 'US',
      count: 500,
    });

    const notice = noticeOf(result) ?? '';
    expect(notice.startsWith(`${CLAMPED_500} Low-confidence match: `)).toBe(true);
    expect(notice).toContain(
      'the top result "Springfield" (United States, feature_code PPL) has a population of 23,363',
    );
    expect(trailerOf(result)).toBe(notice);
  });

  it('sends the applied count on the script-inferred language retry', async () => {
    const tool = await loadTool(undefined);
    mockGetGeocode
      .mockResolvedValueOnce({ generationtime_ms: 0.1 })
      .mockResolvedValueOnce({ results: [SHANGHAI_ZH_RESULT] });

    const result = await runToolContract(tool, { name: '上海', count: 500 });

    expect(result.isError).toBeFalsy();
    expect(mockGetGeocode.mock.calls.map((call) => call.slice(1, 3))).toEqual([
      [100, 'en'],
      [100, 'zh'],
    ]);
  });

  it('advertises a default of 5 and no maximum while clamping is on', async () => {
    expect(advertisedCount(await loadTool(undefined))).toStrictEqual({
      default: 5,
      type: 'integer',
      minimum: 1,
      description: `Matches to return, most relevant first. Default 5; a larger value returns at most 100 and says so. ${COUNT_TAIL}`,
    });
  });

  it('advertises maximum 100 when OPENMETEO_CLAMP_LIMITS=false', async () => {
    expect(advertisedCount(await loadTool('false'))).toStrictEqual({
      default: 5,
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: `Matches to return, most relevant first. Default 5, at most 100. ${COUNT_TAIL}`,
    });
  });

  it('rejects a count above 100 when OPENMETEO_CLAMP_LIMITS=false, naming the maximum, before any request', async () => {
    const tool = await loadTool('false');
    for (const count of [101, 500, 1e20]) {
      const err = await wireError(tool, { name: 'Springfield', count });
      expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(err.message).toContain('count: Too big: expected number to be <=100');
    }
    expect(mockGetGeocode).not.toHaveBeenCalled();
  });

  it('accepts count 100 when OPENMETEO_CLAMP_LIMITS=false', async () => {
    const tool = await loadTool('false');
    mockGetGeocode.mockResolvedValue({ results: ranked(100) });

    const result = await runToolContract(tool, { name: 'Springfield', count: 100 });

    expect(result.isError).toBeFalsy();
    expect(sentCounts()).toEqual([100]);
    expect(noticeOf(result)).toBeUndefined();
  });

  it.each([
    ['on', undefined],
    ['off', 'false'],
  ])('rejects count 0 and 2.5 with clamping %s, before any request', async (_mode, clampLimits) => {
    const tool = await loadTool(clampLimits);
    for (const [count, problem] of [
      [0, 'count: Too small: expected number to be >=1'],
      [2.5, 'count: Invalid input: expected int, received number'],
    ] as const) {
      const err = await wireError(tool, { name: 'Springfield', count });
      expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(err.message).toContain(problem);
    }
    expect(mockGetGeocode).not.toHaveBeenCalled();
  });

  it.each([
    ['on', undefined],
    ['off', 'false'],
  ])(
    'rejects a fraction on the integer rule alone and a count below 1 on the floor alone, with clamping %s, before any request',
    async (_mode, clampLimits) => {
      const tool = await loadTool(clampLimits);
      const NOT_INT = 'Invalid input: expected int, received number';
      const BELOW_FLOOR = 'Too small: expected number to be >=1';
      for (const [count, issueCode, problem] of [
        [0.5, 'invalid_type', NOT_INT],
        [-0.5, 'invalid_type', NOT_INT],
        [-1.5, 'invalid_type', NOT_INT],
        [1e-7, 'invalid_type', NOT_INT],
        [2.5, 'invalid_type', NOT_INT],
        [101.5, 'invalid_type', NOT_INT],
        [0, 'too_small', BELOW_FLOOR],
        [-1, 'too_small', BELOW_FLOOR],
        [-1e20, 'too_small', BELOW_FLOOR],
      ] as const) {
        const parsed = tool.input.safeParse({ name: 'Springfield', count });
        expect(
          parsed.error?.issues.map(({ code, path, message }) => ({ code, path, message })),
        ).toEqual([{ code: issueCode, path: ['count'], message: problem }]);
        const err = await wireError(tool, { name: 'Springfield', count });
        expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(err.message).toBe(
          `Input validation error: Invalid arguments for tool openmeteo_search_locations: count: ${problem}`,
        );
      }
      expect(mockGetGeocode).not.toHaveBeenCalled();
    },
  );

  it('states the 100 cap, never the old 1–10 range, in the tool and notice descriptions', async () => {
    const tool = await loadTool(undefined);
    expect(tool.description).toContain('default 5, at most 100');
    expect(tool.description).not.toMatch(/up to 10 |1–10/);
    expect(tool.enrichment?.notice?.description ?? '').toContain(
      'when count was above the geocoder’s maximum of 100',
    );
  });
});
