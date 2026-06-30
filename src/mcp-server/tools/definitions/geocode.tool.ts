/**
 * @fileoverview Tool: openmeteo_geocode — resolve a place name to ranked coordinate matches.
 * Required prerequisite for weather tools, which take coordinates not place names.
 * @module mcp-server/tools/definitions/geocode
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';

export const openmeteoGeocodeTool = tool('openmeteo_geocode', {
  description:
    'Resolve a place name to ranked coordinate matches with country, region, elevation, ' +
    'timezone, and population. Required prerequisite for name-based queries — all weather ' +
    'tools take latitude/longitude, not place names. Returns up to 10 matches ranked by ' +
    'population/relevance; use country or admin1 to disambiguate when multiple cities share a name.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'The search returned no matching places',
      recovery:
        'Check the spelling, try a broader term (e.g., region instead of street), or search in English.',
      retryable: false,
    },
  ],

  input: z.object({
    name: z
      .string()
      .min(1)
      .max(100)
      .describe(
        'Place name to search. Can be a city, region, or landmark (e.g., "Seattle", "Mount Rainier"). Weather tools require coordinates — use the lat/lon from this result.',
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
        'Response language for place names (ISO 639-1, e.g., "en", "de", "fr"). Default "en".',
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
              .describe(
                'IANA timezone (e.g., "America/Los_Angeles") — pass to weather tools as the timezone parameter',
              ),
            country: z
              .string()
              .nullable()
              .describe('Country name (null for non-populated features like continents)'),
            country_code: z
              .string()
              .nullable()
              .describe('ISO 3166-1 alpha-2 country code (null for non-populated features)'),
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
      .describe('Ranked matches (most relevant first). Empty when no results match.'),
    count: z.number().describe('Number of results returned'),
  }),

  async handler(input, ctx) {
    const service = getOpenMeteoService();
    const response = await service.getGeocode(input.name, input.count, input.language, ctx);

    const results = (response.results ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      latitude: r.latitude,
      longitude: r.longitude,
      elevation: r.elevation ?? null,
      timezone: r.timezone,
      country: r.country ?? null,
      country_code: r.country_code ?? null,
      admin1: r.admin1 ?? null,
      admin2: r.admin2 ?? null,
      population: r.population ?? null,
      feature_code: r.feature_code,
    }));

    if (results.length === 0) {
      throw ctx.fail('no_results', `No places found matching "${input.name}".`);
    }

    ctx.log.info('Geocode results', { name: input.name, count: results.length });
    return { results, count: results.length };
  },

  format: (result) => {
    const lines = [`## Geocoding results for search`];
    for (const r of result.results) {
      const region = [r.admin1, r.admin2].filter(Boolean).join(', ');
      const pop = r.population != null ? ` | pop. ${r.population.toLocaleString()}` : '';
      const elev = r.elevation != null ? ` | ${r.elevation}m` : '';
      const countryPart = r.country ?? '';
      const codePart = r.country_code ?? '';
      const locLabel = [codePart, countryPart].filter(Boolean).join(' — ');
      lines.push(
        `**${r.name}**${locLabel ? ` (${locLabel})` : ''}${region ? `, ${region}` : ''} — ` +
          `${r.latitude}, ${r.longitude}${elev}${pop}`,
        `  id: ${r.id} | timezone: ${r.timezone} | feature: ${r.feature_code}`,
      );
    }
    lines.push(
      `\n_${result.count} result${result.count === 1 ? '' : 's'} — Weather data by Open-Meteo.com_`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
