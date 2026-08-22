/**
 * @fileoverview Property-based safety coverage for openmeteo_search_locations.
 * @module tests/fuzz/search-locations.tool.fuzz.test
 */

import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { expect, it, vi } from 'vitest';
import { openmeteoSearchLocationsTool } from '@/mcp-server/tools/definitions/search-locations.tool.js';

const mockGetGeocode = vi.fn(() =>
  Promise.resolve({
    results: [
      {
        id: 5809844,
        name: 'Seattle',
        latitude: 47.60621,
        longitude: -122.33207,
        feature_code: 'PPLA2',
      },
    ],
  }),
);

vi.mock('@/services/open-meteo/open-meteo-service.js', () => ({
  getOpenMeteoService: () => ({ getGeocode: mockGetGeocode }),
}));

it('keeps the geocoding tool safe across generated and adversarial inputs', async () => {
  const report = await fuzzTool(openmeteoSearchLocationsTool, {
    numRuns: 50,
    numAdversarial: 30,
    seed: 20_260_822,
  });

  expect(report.crashes).toHaveLength(0);
  expect(report.leaks).toHaveLength(0);
  expect(report.prototypePollution).toBe(false);
});
