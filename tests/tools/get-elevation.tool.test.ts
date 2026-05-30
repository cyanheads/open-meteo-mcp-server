/**
 * @fileoverview Tests for openmeteo_get_elevation tool.
 * @module tests/tools/get-elevation.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoGetElevationTool } from '@/mcp-server/tools/definitions/get-elevation.tool.js';

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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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

  it('formats output as markdown', () => {
    const blocks = openmeteoGetElevationTool.format!({
      elevations: [{ latitude: 47.6, longitude: -122.3, elevation_m: 59 }],
    });
    expect(blocks[0]?.type).toBe('text');
    expect(blocks[0]?.text).toContain('59 m');
    expect(blocks[0]?.text).toContain('Open-Meteo.com');
  });
});
