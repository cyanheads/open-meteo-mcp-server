/**
 * @fileoverview Tests for openmeteo_get_forecast tool.
 * @module tests/tools/get-forecast.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoGetForecastTool } from '@/mcp-server/tools/definitions/get-forecast.tool.js';

const mockGetForecast = vi.fn();

vi.mock('@/services/open-meteo/open-meteo-service.js', () => ({
  getOpenMeteoService: () => ({ getForecast: mockGetForecast }),
}));

const MOCK_RESPONSE = {
  latitude: 47.595562,
  longitude: -122.32443,
  elevation: 59.0,
  utc_offset_seconds: -25200,
  timezone: 'America/Los_Angeles',
  timezone_abbreviation: 'GMT-7',
  generationtime_ms: 0.2,
  hourly_units: { time: 'iso8601', temperature_2m: '°C', precipitation: 'mm' },
  hourly: {
    time: ['2026-05-30T00:00', '2026-05-30T01:00'],
    temperature_2m: [10.1, 9.4],
    precipitation: [0.0, 0.0],
  },
};

describe('openmeteoGetForecastTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reshapes columnar response into per-timestamp records', async () => {
    mockGetForecast.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext();
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m', 'precipitation'],
    });
    const result = await openmeteoGetForecastTool.handler(input, ctx);

    expect(result.hourly).toHaveLength(2);
    expect(result.hourly![0]).toMatchObject({
      time: '2026-05-30T00:00',
      temperature_2m: 10.1,
      precipitation: 0.0,
    });
    expect(result.hourly_units).toEqual({
      time: 'iso8601',
      temperature_2m: '°C',
      precipitation: 'mm',
    });
  });

  it('exact parallel alignment: each timestamp maps to the same-index variable values', async () => {
    // Three timestamps × three variables — verifies position [i] consistency across all arrays.
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: {
        time: 'iso8601',
        temperature_2m: '°C',
        wind_speed_10m: 'km/h',
        cloud_cover: '%',
      },
      hourly: {
        time: ['2026-05-30T00:00', '2026-05-30T01:00', '2026-05-30T02:00'],
        temperature_2m: [10.1, 9.4, 8.8],
        wind_speed_10m: [5.0, 6.2, 7.1],
        cloud_cover: [20, 35, 50],
      },
    });
    const ctx = createMockContext();
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m', 'wind_speed_10m', 'cloud_cover'],
    });
    const result = await openmeteoGetForecastTool.handler(input, ctx);

    expect(result.hourly).toHaveLength(3);
    // position 0
    expect(result.hourly![0]).toEqual({
      time: '2026-05-30T00:00',
      temperature_2m: 10.1,
      wind_speed_10m: 5.0,
      cloud_cover: 20,
    });
    // position 1
    expect(result.hourly![1]).toEqual({
      time: '2026-05-30T01:00',
      temperature_2m: 9.4,
      wind_speed_10m: 6.2,
      cloud_cover: 35,
    });
    // position 2
    expect(result.hourly![2]).toEqual({
      time: '2026-05-30T02:00',
      temperature_2m: 8.8,
      wind_speed_10m: 7.1,
      cloud_cover: 50,
    });
  });

  it('throws no_variables_requested (with correct reason) when neither hourly nor daily provided', async () => {
    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
    });
    await expect(openmeteoGetForecastTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'no_variables_requested' },
    });
  });

  it('throws invalid_variable when API returns error envelope', async () => {
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason: 'Variable "bogus_var" is not a valid hourly variable.',
    });
    const ctx = createMockContext({ errors: openmeteoGetForecastTool.errors });
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['bogus_var'],
    });
    await expect(openmeteoGetForecastTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_variable' },
    });
  });

  it('passes timezone=auto by default', async () => {
    mockGetForecast.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext();
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m'],
    });
    // Default should not override timezone — verify 'auto' is used
    expect(input.timezone).toBe('auto');
    await openmeteoGetForecastTool.handler(input, ctx);
    const callArgs = mockGetForecast.mock.calls[0]?.[2] as { timezone?: string };
    expect(callArgs?.timezone).toBe('auto');
  });

  it('passes explicit timezone through to service', async () => {
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      timezone: 'Europe/Berlin',
      utc_offset_seconds: 7200,
    });
    const ctx = createMockContext();
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 52.52,
      longitude: 13.4,
      hourly_variables: ['temperature_2m'],
      timezone: 'Europe/Berlin',
    });
    const result = await openmeteoGetForecastTool.handler(input, ctx);
    const callArgs = mockGetForecast.mock.calls[0]?.[2] as { timezone?: string };
    expect(callArgs?.timezone).toBe('Europe/Berlin');
    expect(result.timezone).toBe('Europe/Berlin');
  });

  it('surfaces hourly_units and daily_units separately from records', async () => {
    mockGetForecast.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily_units: { time: 'iso8601', temperature_2m_max: '°C' },
      daily: { time: ['2026-05-30'], temperature_2m_max: [15.9] },
    });
    const ctx = createMockContext();
    const input = openmeteoGetForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m'],
      daily_variables: ['temperature_2m_max'],
    });
    const result = await openmeteoGetForecastTool.handler(input, ctx);
    // Units are in the units map, not in each record
    expect(result.daily![0]).not.toHaveProperty('unit');
    expect(result.daily_units).toHaveProperty('temperature_2m_max', '°C');
  });

  it('formats output as markdown with attribution', () => {
    const blocks = openmeteoGetForecastTool.format!({
      latitude: 47.6,
      longitude: -122.3,
      elevation: 59,
      timezone: 'America/Los_Angeles',
      utc_offset_seconds: -25200,
      hourly: [{ time: '2026-05-30T10:00', temperature_2m: 12.0 }],
      hourly_units: { temperature_2m: '°C' },
    });
    expect(blocks[0]?.text).toContain('Weather forecast');
    expect(blocks[0]?.text).toContain('Open-Meteo.com');
  });
});
