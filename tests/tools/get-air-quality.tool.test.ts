/**
 * @fileoverview Tests for openmeteo_get_air_quality tool.
 * @module tests/tools/get-air-quality.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoGetAirQualityTool } from '@/mcp-server/tools/definitions/get-air-quality.tool.js';

const mockGetAirQuality = vi.fn();

vi.mock('@/services/open-meteo/open-meteo-service.js', () => ({
  getOpenMeteoService: () => ({ getAirQuality: mockGetAirQuality }),
}));

const MOCK_RESPONSE = {
  latitude: 47.595562,
  longitude: -122.32443,
  elevation: 0,
  utc_offset_seconds: -25200,
  timezone: 'America/Los_Angeles',
  timezone_abbreviation: 'GMT-7',
  generationtime_ms: 0.4,
  hourly_units: { time: 'iso8601', pm2_5: 'μg/m³', european_aqi: 'EAQI' },
  hourly: {
    time: ['2026-05-30T00:00', '2026-05-30T01:00'],
    pm2_5: [3.2, 3.5],
    european_aqi: [10, 11],
  },
};

describe('openmeteoGetAirQualityTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reshapes columnar air quality response with exact alignment', async () => {
    mockGetAirQuality.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext();
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5', 'european_aqi'],
    });
    const result = await openmeteoGetAirQualityTool.handler(input, ctx);

    expect(result.hourly).toHaveLength(2);
    // Exact position check for both records
    expect(result.hourly![0]).toEqual({
      time: '2026-05-30T00:00',
      pm2_5: 3.2,
      european_aqi: 10,
    });
    expect(result.hourly![1]).toEqual({
      time: '2026-05-30T01:00',
      pm2_5: 3.5,
      european_aqi: 11,
    });
    expect(result.data_source).toBe('CAMS');
    expect(result.hourly_units).toMatchObject({ pm2_5: 'μg/m³', european_aqi: 'EAQI' });
  });

  it('throws no_variables_requested with correct reason when hourly_variables not provided', async () => {
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
    });
    await expect(openmeteoGetAirQualityTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'no_variables_requested' },
    });
  });

  it('frames the upstream unknown-variable rejection with the offending name and recovery hint', async () => {
    // Real upstream reason shape from the live air-quality endpoint
    mockGetAirQuality.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason:
        "Data corrupted at path ''. Cannot initialize SurfacePressureAndHeightVariable<VariableAndPreviousDay, VariableOrSpread<ForecastPressureVariable>, ForecastHeightVariable> from invalid String value bogus_aqi.",
    });
    const ctx = createMockContext({ errors: openmeteoGetAirQualityTool.errors });
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['bogus_aqi'],
    });
    await expect(openmeteoGetAirQualityTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringMatching(/^Unknown variable name: bogus_aqi\./),
      data: {
        reason: 'invalid_variable',
        recovery: { hint: expect.stringContaining('pm2_5') },
      },
    });
  });

  it('always includes data_source: CAMS in output regardless of variables requested', async () => {
    mockGetAirQuality.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext();
    const input = openmeteoGetAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['pm2_5'],
    });
    const result = await openmeteoGetAirQualityTool.handler(input, ctx);
    expect(result.data_source).toBe('CAMS');
  });

  it('formats output with CAMS source attribution', () => {
    const blocks = openmeteoGetAirQualityTool.format!({
      latitude: 47.6,
      longitude: -122.3,
      timezone: 'America/Los_Angeles',
      hourly: [{ time: '2026-05-30T00:00', pm2_5: 3.2 }],
      hourly_units: { pm2_5: 'μg/m³' },
      data_source: 'CAMS',
    });
    expect(blocks[0]?.text).toContain('CAMS');
    expect(blocks[0]?.text).toContain('Open-Meteo.com');
  });
});
