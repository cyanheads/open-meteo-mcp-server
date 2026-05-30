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
      data: { reason: 'no_results' },
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
});
