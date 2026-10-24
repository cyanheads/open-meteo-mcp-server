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
      unprocessed_count: 0,
      next_offset: null,
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
      unprocessed_count: 0,
      next_offset: null,
    });
    expect(blocks[0]?.type).toBe('text');
    expect(firstText(blocks)).toContain('59 m');
    expect(firstText(blocks)).toContain('Open-Meteo.com');
  });

  // --- more than one request's worth of pairs (#82) ---------------------------

  describe('pairs past the 100-per-request sample', () => {
    /** `count` distinct, in-range coordinate pairs, so input order is checkable. */
    const pairs = (count: number) => ({
      latitudes: Array.from({ length: count }, (_, i) => (i - 500) / 10),
      longitudes: Array.from({ length: count }, (_, i) => (i - 500) / 5),
    });

    type Elevation = { latitude: number; longitude: number; elevation_m: number | null };
    type Output = {
      elevations: Elevation[];
      unprocessed_count: number;
      next_offset: number | null;
    };

    beforeEach(() => {
      // One reading per pair the service is handed, 3 m apart, so position is checkable.
      mockGetElevation.mockImplementation((latitudes: number[]) =>
        Promise.resolve({ elevation: latitudes.map((_, i) => i * 3) }),
      );
    });

    it('samples the first 100 of 150 in input order and names the 50 left to resubmit', async () => {
      const input = pairs(150);

      const result = await runToolContract(openmeteoGetElevationTool, input);

      expect(result.isError).toBeFalsy();
      // One upstream request carrying exactly the first 100 pairs.
      expect(mockGetElevation).toHaveBeenCalledTimes(1);
      expect(mockGetElevation).toHaveBeenCalledWith(
        input.latitudes.slice(0, 100),
        input.longitudes.slice(0, 100),
        expect.anything(),
      );

      const out = result.structuredContent as Output & { notice?: string };
      expect(out.elevations).toHaveLength(100);
      expect(out.elevations[0]).toEqual({ latitude: -50, longitude: -100, elevation_m: 0 });
      expect(out.elevations[99]).toEqual({ latitude: -40.1, longitude: -80.2, elevation_m: 297 });
      expect(out.elevations.map((e) => e.latitude)).toEqual(input.latitudes.slice(0, 100));
      expect(out.unprocessed_count).toBe(50);
      expect(out.next_offset).toBe(100);

      const notice =
        'Sampled the first 100 of 150 submitted pairs; 50 remain unprocessed. Resubmit latitudes.slice(100) and longitudes.slice(100) of the arrays sent in this call to continue.';
      expect(out.notice).toBe(notice);

      const text = firstText(result.content);
      expect(text).toContain('**unprocessed_count:** 50 · **next_offset:** 100\n');
      expect(text).toContain('_100 points — Weather data by Open-Meteo.com_');
      // The 101st pair is not rendered — it was never sampled.
      expect(text).not.toContain('**-40, -80** →');
      // The framework renders the notice as its own block after format()'s.
      expect(result.content[1]).toEqual({ type: 'text', text: `\n\n> ${notice}` });
    });

    it('reports one pair left at 101, the first count past the sample', async () => {
      const result = await runToolContract(openmeteoGetElevationTool, pairs(101));

      const out = result.structuredContent as Output & { notice?: string };
      expect(out.elevations).toHaveLength(100);
      expect(out.unprocessed_count).toBe(1);
      expect(out.next_offset).toBe(100);
      expect(out.notice).toContain('first 100 of 101 submitted pairs; 1 remain');
    });

    it('returns all 100 at exactly 100, with 0 / null and no notice', async () => {
      const input = pairs(100);

      const result = await runToolContract(openmeteoGetElevationTool, input);

      expect(mockGetElevation).toHaveBeenCalledTimes(1);
      expect(mockGetElevation).toHaveBeenCalledWith(
        input.latitudes,
        input.longitudes,
        expect.anything(),
      );
      const out = result.structuredContent as Output;
      expect(out.elevations).toHaveLength(100);
      expect(out.elevations[99]).toEqual({ latitude: -40.1, longitude: -80.2, elevation_m: 297 });
      expect(out).toMatchObject({ unprocessed_count: 0, next_offset: null });
      expect(out).not.toHaveProperty('notice');
      expect(firstText(result.content)).toContain(
        '**unprocessed_count:** 0 · **next_offset:** null\n',
      );
      // format()'s block only — no notice block follows.
      expect(result.content).toHaveLength(1);
    });

    it('accepts 1,000 pairs and still sends only the first 100', async () => {
      const input = pairs(1000);

      const result = await runToolContract(openmeteoGetElevationTool, input);

      expect(result.isError).toBeFalsy();
      expect(mockGetElevation).toHaveBeenCalledTimes(1);
      expect(mockGetElevation.mock.calls[0]?.[0]).toHaveLength(100);
      expect(mockGetElevation.mock.calls[0]?.[1]).toHaveLength(100);
      const out = result.structuredContent as Output & { notice?: string };
      expect(out).toMatchObject({ unprocessed_count: 900, next_offset: 100 });
      expect(out.notice).toContain('first 100 of 1000 submitted pairs; 900 remain');
    });

    it.each([
      ['latitudes', { ...pairs(1000), latitudes: pairs(1001).latitudes }],
      ['longitudes', { ...pairs(1000), longitudes: pairs(1001).longitudes }],
      ['both arrays', pairs(1001)],
    ])('rejects 1,001 %s at the input schema, before any request', async (_label, input) => {
      const result = await runToolContract(openmeteoGetElevationTool, input);

      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: { code: number; message: string } })
        .error;
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.message).toMatch(/<=1000/);
      expect(mockGetElevation).not.toHaveBeenCalled();
    });

    it('fails 150 vs 149 as coordinate_count_mismatch, comparing the full arrays', async () => {
      const input = { latitudes: pairs(150).latitudes, longitudes: pairs(149).longitudes };

      const result = await runToolContract(openmeteoGetElevationTool, input);

      expect(result.isError).toBe(true);
      const error = (
        result.structuredContent as { error: { code: number; message: string; data: unknown } }
      ).error;
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toBe('latitudes length (150) ≠ longitudes length (149).');
      expect(error.data).toMatchObject({ reason: 'coordinate_count_mismatch' });
      expect(mockGetElevation).not.toHaveBeenCalled();
    });

    it('advertises the 1,000 ceiling on both arrays', () => {
      const { latitudes, longitudes } = openmeteoGetElevationTool.input.shape;
      for (const field of [latitudes, longitudes]) {
        expect(field.safeParse(pairs(1000).latitudes).success).toBe(true);
        expect(field.safeParse(pairs(1001).latitudes).success).toBe(false);
        expect(field.description).toContain('up to 1,000; the first 100 are sampled per call');
      }
    });

    it('declares unprocessed_count and next_offset as always present', () => {
      const { shape } = openmeteoGetElevationTool.output;
      expect(shape.unprocessed_count.safeParse(undefined).success).toBe(false);
      expect(shape.next_offset.safeParse(undefined).success).toBe(false);
      expect(shape.next_offset.safeParse(null).success).toBe(true);
    });
  });
});
