/**
 * @fileoverview Tool: openmeteo_get_elevation — terrain elevation for coordinate pairs.
 * Accepts up to 100 pairs per call from the Copernicus DEM (~90m resolution).
 * @module mcp-server/tools/definitions/get-elevation
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';

export const openmeteoGetElevationTool = tool('openmeteo_get_elevation', {
  description:
    'Terrain elevation from the Copernicus Digital Elevation Model (~90m resolution) for one ' +
    'or more coordinate pairs. Accepts up to 100 pairs per call. Useful for geographic context, ' +
    'elevation-adjusted weather interpretation, or route planning.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'coordinate_count_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'latitudes and longitudes arrays have different lengths',
      recovery: 'Provide equal-length latitude and longitude arrays.',
      retryable: false,
    },
  ],

  input: z.object({
    latitudes: z
      .array(z.number().min(-90).max(90))
      .min(1)
      .max(100)
      .describe(
        'Array of latitudes in decimal degrees (up to 100). Must be same length as longitudes.',
      ),
    longitudes: z
      .array(z.number().min(-180).max(180))
      .min(1)
      .max(100)
      .describe(
        'Array of longitudes in decimal degrees (up to 100). Must be same length as latitudes.',
      ),
  }),

  output: z.object({
    elevations: z
      .array(
        z
          .object({
            latitude: z.number().describe('Input latitude'),
            longitude: z.number().describe('Input longitude'),
            elevation_m: z.number().describe('Terrain elevation in meters above sea level'),
          })
          .describe('Elevation for a single coordinate pair'),
      )
      .describe('Elevation values in input order'),
  }),

  async handler(input, ctx) {
    if (input.latitudes.length !== input.longitudes.length) {
      throw ctx.fail(
        'coordinate_count_mismatch',
        `latitudes length (${input.latitudes.length}) ≠ longitudes length (${input.longitudes.length}).`,
        ctx.recoveryFor('coordinate_count_mismatch'),
      );
    }

    const service = getOpenMeteoService();
    const response = await service.getElevation(input.latitudes, input.longitudes, ctx);

    const elevations = input.latitudes.map((lat, i) => ({
      latitude: lat,
      longitude: input.longitudes[i] as number,
      elevation_m: response.elevation[i] ?? 0,
    }));

    ctx.log.info('Elevation fetched', { count: elevations.length });
    return { elevations };
  },

  format: (result) => {
    const lines = ['## Terrain elevation'];
    for (const e of result.elevations) {
      lines.push(`**${e.latitude}, ${e.longitude}** → ${e.elevation_m} m`);
    }
    lines.push(
      `\n_${result.elevations.length} point${result.elevations.length === 1 ? '' : 's'} — Weather data by Open-Meteo.com_`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
