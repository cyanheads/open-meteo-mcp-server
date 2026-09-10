/**
 * @fileoverview Tool: openmeteo_search_locations — resolve a place name to ranked coordinate matches.
 * Required prerequisite for weather tools, which take coordinates not place names.
 * @module mcp-server/tools/definitions/search-locations
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';
import type { GeocodingResult } from '@/services/open-meteo/types.js';

/**
 * Infer a geocoding language from the dominant script of the query. The API
 * matches `name` against the localized name index for the requested language,
 * so a native-script query under language="en" finds nothing. Kana is checked
 * before Han — Japanese text mixes both, Chinese never contains Kana.
 */
const SCRIPT_LANGUAGES: [RegExp, string][] = [
  [/\p{Script=Hiragana}|\p{Script=Katakana}/u, 'ja'],
  [/\p{Script=Hangul}/u, 'ko'],
  [/\p{Script=Han}/u, 'zh'],
  [/\p{Script=Cyrillic}/u, 'ru'],
  [/\p{Script=Arabic}/u, 'ar'],
  [/\p{Script=Greek}/u, 'el'],
  [/\p{Script=Hebrew}/u, 'he'],
  [/\p{Script=Thai}/u, 'th'],
  [/\p{Script=Devanagari}/u, 'hi'],
];

function inferLanguageFromScript(name: string): string | undefined {
  return SCRIPT_LANGUAGES.find(([pattern]) => pattern.test(name))?.[1];
}

/**
 * Population at or above which the top match is treated as a confident city hit.
 *
 * The upstream index owns matching, and it answers a historic or colonial exonym with a
 * non-empty result set that does not contain the modern city at all — "Bangalore" returns
 * a Karachi neighbourhood, "Calcutta" a South African village of 35,864, "Madras" a town
 * in Oregon. Nothing about those responses is an error, so `no_results` never fires and
 * re-ranking cannot help: the intended city is absent from the candidates, not outranked
 * within them. Population is the one signal that separates them — every reproduced miss
 * came back null or under 36,000, while every correctly-resolving query checked, down to
 * the smallest, came back at 780,995 or above.
 *
 * 100,000 sits with room on both sides of that gap — roughly three times the largest
 * observed miss and an eighth of the smallest observed correct match — and reads as a
 * plain rule rather than a number fitted to the sample. A genuine small-town query
 * (Leavenworth, Washington) trips it too; that costs the caller one advisory sentence and
 * nothing else, since the notice never alters `results` or `count`.
 */
const CONFIDENT_MATCH_POPULATION = 100_000;

/** Normalize raw API results — coalesce fields the API omits on sparse features. */
function normalizeResults(results: GeocodingResult[] | undefined) {
  return (results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    elevation: r.elevation ?? null,
    timezone: r.timezone ?? null,
    country: r.country ?? null,
    country_code: r.country_code ?? null,
    admin1: r.admin1 ?? null,
    admin2: r.admin2 ?? null,
    population: r.population ?? null,
    feature_code: r.feature_code,
  }));
}

export const openmeteoSearchLocationsTool = tool('openmeteo_search_locations', {
  description:
    'Resolve a place name to ranked coordinate matches with country, region, elevation, ' +
    'timezone, and population. Required prerequisite for name-based queries — all weather ' +
    'tools take latitude/longitude, not place names. Search by a bare place name (city, ' +
    'region, or landmark); never fold a qualifier into it — pass "Baoding", not "Baoding ' +
    'Hebei", and "Paris", not "Paris, France". To disambiguate places that share a name, set ' +
    'the country input (ISO 3166-1 alpha-2, e.g. "US") and/or read the admin1 and country ' +
    'fields on each ranked result — admin1 is a result field for choosing among matches, not a ' +
    'search input. Returns up to 10 matches ranked by population/relevance.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'The search returned no matching places',
      recovery:
        'If a region or country qualifier was folded into name, drop it and search the bare place name ("Baoding", not "Baoding Hebei") — use the country input or read admin1 on the results to disambiguate. A one- or two-character native-script name ("서울", "大阪", "東京") is matched only against an index entry of exactly that length, so retry with the full administrative name ("서울특별시", "大阪市", "東京都") or the romanized name ("Seoul", "Osaka", "Tokyo") — setting language alone will not resolve it. The index covers populated places only: a physical feature or landmark ("Sahara Desert") often will not resolve, so search the nearest town or city instead. Otherwise check the spelling.',
      retryable: false,
    },
  ],

  input: z.object({
    name: z
      .string()
      .min(1)
      .max(100)
      .describe(
        'Place name to search — a bare city, region, or landmark ("Seattle", "Mount Rainier"). Do not fold in a region or country qualifier ("Baoding", not "Baoding Hebei"); use the country input to disambiguate. A one- or two-character native-script name ("서울", "大阪") needs the full administrative name ("서울특별시", "大阪市") or the romanized name ("Seoul", "Osaka") — see the language field. Weather tools require coordinates — use the lat/lon from this result.',
      ),
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .optional()
      .describe(
        'ISO 3166-1 alpha-2 country code (e.g. "US", "FR") to disambiguate places that share a name. Omit for a global search.',
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe(
        'Max results to return (1–10). Default 5. Return more when disambiguating common names like "Springfield" or "Portland".',
      ),
    language: z
      .string()
      .default('en')
      .describe(
        'Language for matching and returning place names (ISO 639-1, e.g., "en", "de", "zh"). The API matches name against the localized index for this language, so set it to match the script of name — e.g. language "zh" for "上海", "ru" for "Москва". This resolves a native-script name of three or more characters, which is matched by normalized prefix; a one- or two-character name must equal an index entry exactly, so setting language alone will not find "서울" or "大阪" — retry those with the full administrative name ("서울특별시", "大阪市") or the romanized name ("Seoul", "Osaka"). Default "en"; a query in a recognized non-Latin script (CJK, Hangul, Cyrillic, Arabic, Greek, Hebrew, Thai, Devanagari) that misses under "en" is retried once with the language inferred from its script.',
      ),
  }),

  output: z.object({
    results: z
      .array(
        z
          .object({
            id: z.number().describe('Open-Meteo place ID — stable reference for this location'),
            name: z.string().describe('Place name'),
            latitude: z.number().describe('Latitude in decimal degrees'),
            longitude: z.number().describe('Longitude in decimal degrees'),
            elevation: z.number().nullable().describe('Elevation in meters above sea level'),
            timezone: z
              .string()
              .nullable()
              .describe(
                'IANA timezone (e.g., "America/Los_Angeles") — pass to weather tools as the timezone parameter. Null when the API omits it.',
              ),
            country: z
              .string()
              .nullable()
              .describe('Country name — null for non-country features like continents and oceans'),
            country_code: z
              .string()
              .nullable()
              .describe(
                'ISO 3166-1 alpha-2 country code — null for non-country features like continents and oceans',
              ),
            admin1: z.string().nullable().describe('State, province, or region'),
            admin2: z.string().nullable().describe('County or district'),
            population: z
              .number()
              .nullable()
              .describe(
                'Population (when available) — useful for disambiguating same-named cities',
              ),
            feature_code: z
              .string()
              .describe(
                'GeoNames feature code describing the place type (e.g., "PPLA2" = state capital city, "PPL" = populated place)',
              ),
          })
          .describe('A single geocoding result with coordinates and administrative context'),
      )
      .describe(
        'Ranked matches (most relevant first). Never empty — when nothing matches, the tool fails with no_results instead of returning an empty array.',
      ),
    count: z.number().describe('Number of results returned'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Advisory on the confidence of the top match, present only when its population is null or under 100,000 — the shape a historic or colonial exonym returns, where the upstream index answers with an unrelated small feature and never surfaces the modern city. Names the returned place, country, and feature_code, and asks the caller to verify the coordinates or retry with the place’s current official name. Never changes results or count.',
      ),
  },

  async handler(input, ctx) {
    const service = getOpenMeteoService();
    const country = input.country?.toUpperCase();
    const response = await service.getGeocode(
      input.name,
      input.count,
      input.language,
      country,
      ctx,
    );
    let results = normalizeResults(response.results);

    // Native-script fallback: the "en" index has no entry for e.g. "上海", so an
    // empty first pass under the default language retries once with a language
    // inferred from the query's script.
    if (results.length === 0 && input.language === 'en') {
      const inferred = inferLanguageFromScript(input.name);
      if (inferred) {
        ctx.log.info('Retrying geocode with script-inferred language', {
          name: input.name,
          language: inferred,
        });
        const retry = await service.getGeocode(input.name, input.count, inferred, country, ctx);
        results = normalizeResults(retry.results);
      }
    }

    if (results.length === 0) {
      throw ctx.fail(
        'no_results',
        `No places found matching "${input.name}".`,
        ctx.recoveryFor('no_results'),
      );
    }

    /*
     * Confidence advisory on the top match — see CONFIDENT_MATCH_POPULATION. Raised
     * after the no_results throw so there is always a result to name; an empty set is
     * the error path's business, not this one's. Advisory only: results and count are
     * returned exactly as upstream ranked them.
     */
    const top = results[0];
    if (top && (top.population ?? 0) < CONFIDENT_MATCH_POPULATION) {
      const where = top.country ? `${top.country}, ` : '';
      const size =
        top.population == null
          ? 'no recorded population'
          : `a population of ${top.population.toLocaleString('en-US')}`;
      ctx.enrich.notice(
        `Low-confidence match: the top result "${top.name}" (${where}feature_code ${top.feature_code}) has ` +
          `${size}, below the ${CONFIDENT_MATCH_POPULATION.toLocaleString('en-US')} this tool reads as a ` +
          'confident city match. Verify the coordinates before passing them to a weather tool. If the query ' +
          'was a historic or colonial exonym, the index may hold no entry for it at all and has returned an ' +
          'unrelated feature — retry with the place’s current official name.',
      );
    }

    ctx.log.info('Geocode results', { name: input.name, count: results.length });
    return { results, count: results.length };
  },

  format: (result) => {
    const lines = [`## Geocoding results for search`];
    for (const r of result.results) {
      const cc = r.country_code ? ` (${r.country_code})` : '';
      const place = [r.country, r.admin1, r.admin2].filter(Boolean).join(', ');
      const pop = r.population != null ? ` | pop. ${r.population.toLocaleString()}` : '';
      const elev = r.elevation != null ? ` | ${r.elevation}m` : '';
      lines.push(
        `**${r.name}**${cc}${place ? ` — ${place}` : ''} — ` +
          `${r.latitude}, ${r.longitude}${elev}${pop}`,
        `  id: ${r.id} | timezone: ${r.timezone ?? 'unknown'} | feature: ${r.feature_code}`,
      );
    }
    lines.push(
      `\n_${result.count} result${result.count === 1 ? '' : 's'} — Weather data by Open-Meteo.com_`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
