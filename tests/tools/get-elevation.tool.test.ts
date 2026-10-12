/**
 * @fileoverview Tests for openmeteo_get_elevation tool.
 * @module tests/tools/get-elevation.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoGetElevationTool } from '@/mcp-server/tools/definitions/get-elevation.tool.js';
import { firstText } from '../helpers/content.js';

const mockGetElevation = vi.fn();

vi.mock('@/services/open-meteo/open-meteo-service.js', () => ({
  getOpenMeteoService: () => ({ getElevation: mockGetElevation }),
}));

describe('openmeteoGetElevationTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns elevations zipped with input coordinates in input order', async () => {
    mockGetElevation.mockResolvedValue({ elevation: [59.0, 1800.0] });
    const ctx = createMockContext({ errors: openmeteoGetElevationTool.errors });
    const input = openmeteoGetElevationTool.input.parse({
      latitudes: [47.6062, 46.853],
      longitudes: [-122.3321, -121.734],
    });
    const result = await openmeteoGetElevationTool.handler(input, ctx);
    expect(result.elevations).toHaveLength(2);
    // Verify both coordinates and elevation_m are correctly zipped
    expect(result.elevations[0]).toEqual({
      latitude: 47.6062,
      longitude: -122.3321,
      elevation_m: 59.0,
    });
    expect(result.elevations[1]).toEqual({
      latitude: 46.853,
      longitude: -121.734,
      elevation_m: 1800.0,
    });
  });

  it('handles a single coordinate pair', async () => {
    mockGetElevation.mockResolvedValue({ elevation: [432.0] });
    const ctx = createMockContext({ errors: openmeteoGetElevationTool.errors });
    const input = openmeteoGetElevationTool.input.parse({
      latitudes: [46.853],
      longitudes: [-121.734],
    });
    const result = await openmeteoGetElevationTool.handler(input, ctx);
    expect(result.elevations).toHaveLength(1);
    expect(result.elevations[0]?.elevation_m).toBe(432.0);
  });

  it('throws coordinate_count_mismatch with correct reason when arrays differ in length', async () => {
    const ctx = createMockContext({ errors: openmeteoGetElevationTool.errors });
    const input = openmeteoGetElevationTool.input.parse({
      latitudes: [47.6062],
      longitudes: [-122.3321, -121.734],
    });
    await expect(openmeteoGetElevationTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'coordinate_count_mismatch' },
    });
  });

  // --- missing DEM values (#61) ------------------------------------------------

  it('reports a point with no DEM value as null on both surfaces, never 0 m', async () => {
    mockGetElevation.mockResolvedValue({ elevation: [325, 59, 0, null] });

    const result = await runToolContract(openmeteoGetElevationTool, {
      latitudes: [46.6021, 47.6062, 0, 90],
      longitudes: [-120.5059, -122.3321, 0, 0],
    });

    expect(result.isError).toBeFalsy();
    const { elevations } = result.structuredContent as {
      elevations: { latitude: number; longitude: number; elevation_m: number | null }[];
    };
    expect(elevations.map((e) => e.elevation_m)).toEqual([325, 59, 0, null]);
    const text = firstText(result.content);
    expect(text).toContain('**90, 0** → unavailable (no DEM value)');
    expect(text).not.toContain('**90, 0** → 0 m');
    // A real sea-level reading still renders as 0 m.
    expect(text).toContain('**0, 0** → 0 m');
    expect(text).toContain('**47.6062, -122.3321** → 59 m');
  });

  it('maps a missing index (a response shorter than the input) to null, not 0', async () => {
    mockGetElevation.mockResolvedValue({ elevation: [59] });

    const result = await runToolContract(openmeteoGetElevationTool, {
      latitudes: [47.6062, 46.853],
      longitudes: [-122.3321, -121.734],
    });

    const { elevations } = result.structuredContent as {
      elevations: { elevation_m: number | null }[];
    };
    expect(elevations.map((e) => e.elevation_m)).toEqual([59, null]);
    expect(firstText(result.content)).toContain('**46.853, -121.734** → unavailable');
  });

  it('keeps negative elevations and echoes the caller’s longitude 180', async () => {
    mockGetElevation.mockResolvedValue({ elevation: [-427, 128] });

    const result = await runToolContract(openmeteoGetElevationTool, {
      latitudes: [31.5, 66],
      longitudes: [35.5, 180],
    });

    expect(result.structuredContent).toEqual({
      elevations: [
        { latitude: 31.5, longitude: 35.5, elevation_m: -427 },
        { latitude: 66, longitude: 180, elevation_m: 128 },
      ],
    });
    // The service receives the caller's value; it owns the 180 → -180 wire mapping.
    expect(mockGetElevation).toHaveBeenCalledWith([31.5, 66], [35.5, 180], expect.anything());
    expect(firstText(result.content)).toContain('**66, 180** → 128 m');
  });

  it('describes null in the output schema', () => {
    const point = openmeteoGetElevationTool.output.shape.elevations.element;
    expect(point.shape.elevation_m.description).toMatch(/null.*no value/i);
    expect(point.shape.elevation_m.safeParse(null).success).toBe(true);
  });

  it('formats output as markdown', () => {
    const blocks = openmeteoGetElevationTool.format!({
      elevations: [{ latitude: 47.6, longitude: -122.3, elevation_m: 59 }],
    });
    expect(blocks[0]?.type).toBe('text');
    expect(firstText(blocks)).toContain('59 m');
    expect(firstText(blocks)).toContain('Open-Meteo.com');
  });
});
