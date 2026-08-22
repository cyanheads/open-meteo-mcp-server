/**
 * @fileoverview Production-pipeline contract coverage for openmeteo_search_locations.
 * @module tests/integration/search-locations-contract.int.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { describe, expect, it, vi } from 'vitest';
import { openmeteoSearchLocationsTool } from '@/mcp-server/tools/definitions/search-locations.tool.js';

const mockGetGeocode = vi.fn((name: string) =>
  Promise.resolve(
    name === 'NoSuchPlace'
      ? {}
      : {
          results: [
            {
              id: 5809844,
              name: 'Seattle',
              latitude: 47.60621,
              longitude: -122.33207,
              elevation: 56,
              feature_code: 'PPLA2',
              country_code: 'US',
              country: 'United States',
              admin1: 'Washington',
              admin2: 'King',
              timezone: 'America/Los_Angeles',
              population: 780995,
            },
          ],
        },
  ),
);

vi.mock('@/services/open-meteo/open-meteo-service.js', () => ({
  getOpenMeteoService: () => ({ getGeocode: mockGetGeocode }),
}));

toolContractSuite(openmeteoSearchLocationsTool, {
  success: [
    {
      name: 'validates, invokes, and formats a successful geocode call',
      input: { name: 'Seattle' },
      expected: { count: 1 },
    },
  ],
  errors: [
    {
      name: 'returns the declared dual-surface no-results envelope',
      input: { name: 'NoSuchPlace' },
      code: JsonRpcErrorCode.NotFound,
      reason: 'no_results',
    },
  ],
});

describe('strict input contract', () => {
  it('rejects undeclared root keys before the handler runs', async () => {
    const callsBefore = mockGetGeocode.mock.calls.length;
    const result = await runToolContract(openmeteoSearchLocationsTool, {
      name: 'Seattle',
      undeclared: true,
    } as never);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining('undeclared'),
      },
    });
    expect(mockGetGeocode).toHaveBeenCalledTimes(callsBefore);
  });
});
