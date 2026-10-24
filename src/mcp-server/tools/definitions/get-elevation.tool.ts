/**
 * @fileoverview Tool: openmeteo_get_elevation — terrain elevation for coordinate pairs.
 * Accepts up to 1,000 pairs, samples the first 100 (the Elevation API's per-request limit)
 * from the Copernicus DEM (~90m resolution), and reports the rest for resubmission.
 * @module mcp-server/tools/definitions/get-elevation
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';
import {
  RATE_LIMITED_ERROR,
  UPSTREAM_TIMEOUT_ERROR,
  UPSTREAM_UNAVAILABLE_ERROR,
} from '../upstream-error.js';

/** Upstream's per-request limit: 101 coordinates answer HTTP 400. */
const SAMPLE_SIZE = 100;

/** Ten requests' worth — a ceiling against absurd input, not a per-call limit. */
const MAX_PAIRS = 1000;

export const openmeteoGetElevationTool = tool('openmeteo_get_elevation', {
  description: `Terrain elevation from the Copernicus Digital Elevation Model (~90m resolution) for one or more coordinate pairs. Accepts up to ${MAX_PAIRS.toLocaleString('en-US')} pairs and samples the first ${SAMPLE_SIZE} in one upstream request; when more were submitted, unprocessed_count says how many remain and next_offset is where to resume — resubmit latitudes.slice(next_offset) and longitudes.slice(next_offset) of the arrays just sent, until next_offset is null. Open-Meteo counts each sampled pair as one call against its per-IP limit of 600 a minute, so a seventh full slice inside one minute comes back rate_limited — space later slices about a minute apart. Useful for geographic context, elevation-adjusted weather interpretation, or route planning. A point the DEM has no value for (latitude 90) returns elevation_m null; the other points in the call are unaffected.`,
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'coordinate_count_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The latitudes and longitudes arrays have different lengths.',
      recovery: 'Provide equal-length latitude and longitude arrays.',
      retryable: false,
    },
    RATE_LIMITED_ERROR,
    UPSTREAM_UNAVAILABLE_ERROR,
    UPSTREAM_TIMEOUT_ERROR,
  ],

  input: z.object({
    latitudes: z
      .array(z.number().min(-90).max(90))
      .min(1)
      .max(MAX_PAIRS)
      .describe(
        `Array of latitudes in decimal degrees (up to ${MAX_PAIRS.toLocaleString('en-US')}; the first ${SAMPLE_SIZE} are sampled per call). Must be same length as longitudes.`,
      ),
    longitudes: z
      .array(z.number().min(-180).max(180))
      .min(1)
      .max(MAX_PAIRS)
      .describe(
        `Array of longitudes in decimal degrees (up to ${MAX_PAIRS.toLocaleString('en-US')}; the first ${SAMPLE_SIZE} are sampled per call). Must be same length as latitudes.`,
      ),
  }),

  output: z.object({
    elevations: z
      .array(
        z
          .object({
            latitude: z.number().describe('Input latitude'),
            longitude: z.number().describe('Input longitude'),
            elevation_m: z
              .number()
              .nullable()
              .describe(
                'Terrain elevation in meters above sea level; null when the DEM has no value for this point',
              ),
          })
          .describe('Elevation for a single coordinate pair'),
      )
      .describe(
        `Elevation values for the sampled pairs (the first ${SAMPLE_SIZE}), in input order`,
      ),
    unprocessed_count: z
      .number()
      .describe(
        `Submitted pairs that were not sampled in this call; 0 when ${SAMPLE_SIZE} or fewer were submitted`,
      ),
    next_offset: z
      .number()
      .nullable()
      .describe(
        'Index to resume from: resubmit latitudes.slice(next_offset) and longitudes.slice(next_offset) of the arrays sent in this call. null when every submitted pair was sampled.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        `Present only when more than ${SAMPLE_SIZE} pairs were submitted: names how many were sampled and how many remain, and the slice of the submitted arrays to resubmit for the rest.`,
      ),
  },

  async handler(input, ctx) {
    // Compared on the full submitted arrays, before anything is sliced.
    if (input.latitudes.length !== input.longitudes.length) {
      throw ctx.fail(
        'coordinate_count_mismatch',
        `latitudes length (${input.latitudes.length}) ≠ longitudes length (${input.longitudes.length}).`,
      );
    }

    const latitudes = input.latitudes.slice(0, SAMPLE_SIZE);
    const longitudes = input.longitudes.slice(0, SAMPLE_SIZE);
    const unprocessed_count = input.latitudes.length - latitudes.length;
    const next_offset = unprocessed_count > 0 ? latitudes.length : null;

    const service = getOpenMeteoService();
    const response = await service.getElevation(latitudes, longitudes, ctx);

    const elevations = latitudes.map((lat, i) => ({
      latitude: lat,
      longitude: longitudes[i] as number,
      elevation_m: response.elevation[i] ?? null,
    }));

    if (next_offset !== null) {
      ctx.enrich.notice(
        `Sampled the first ${latitudes.length} of ${input.latitudes.length} submitted pairs; ${unprocessed_count} remain unprocessed. Resubmit latitudes.slice(${next_offset}) and longitudes.slice(${next_offset}) of the arrays sent in this call to continue.`,
      );
    }

    ctx.log.info('Elevation fetched', { count: elevations.length, unprocessed_count });
    return { elevations, unprocessed_count, next_offset };
  },

  format: (result) => {
    const lines = ['## Terrain elevation'];
    for (const e of result.elevations) {
      const value = e.elevation_m === null ? 'unavailable (no DEM value)' : `${e.elevation_m} m`;
      lines.push(`**${e.latitude}, ${e.longitude}** → ${value}`);
    }
    lines.push(
      `\n**unprocessed_count:** ${result.unprocessed_count} · **next_offset:** ${result.next_offset ?? 'null'}`,
      `\n_${result.elevations.length} point${result.elevations.length === 1 ? '' : 's'} — Weather data by Open-Meteo.com_`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
