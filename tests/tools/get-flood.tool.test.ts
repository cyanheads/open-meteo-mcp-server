/**
 * @fileoverview Tests for openmeteo_get_flood tool.
 * @module tests/tools/get-flood.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoGetFloodTool } from '@/mcp-server/tools/definitions/get-flood.tool.js';

const mockGetFlood = vi.fn();

vi.mock('@/services/open-meteo/open-meteo-service.js', () => ({
  getOpenMeteoService: () => ({ getFlood: mockGetFlood }),
}));

const MOCK_RESPONSE = {
  latitude: 47.6,
  longitude: -122.3,
  utc_offset_seconds: -25200,
  timezone: 'America/Los_Angeles',
  timezone_abbreviation: 'GMT-7',
  generationtime_ms: 1.1,
  daily_units: { time: 'iso8601', river_discharge: 'm³/s', river_discharge_p25: 'm³/s' },
  daily: {
    time: ['2026-06-03', '2026-06-04'],
    river_discharge: [120.5, 118.0],
    river_discharge_p25: [95.0, 92.5],
  },
};

describe('openmeteoGetFloodTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reshapes daily discharge response into per-date records', async () => {
    mockGetFlood.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext();
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge', 'river_discharge_p25'],
    });
    const result = await openmeteoGetFloodTool.handler(input, ctx);

    expect(result.daily).toHaveLength(2);
    expect(result.daily[0]).toEqual({
      time: '2026-06-03',
      river_discharge: 120.5,
      river_discharge_p25: 95.0,
    });
    expect(result.daily[1]).toEqual({
      time: '2026-06-04',
      river_discharge: 118.0,
      river_discharge_p25: 92.5,
    });
    expect(result.daily_units).toMatchObject({ river_discharge: 'm³/s' });
  });

  it('preserves null values for coordinates outside GloFAS coverage', async () => {
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily: {
        time: ['2026-06-03'],
        river_discharge: [null],
      },
    });
    const ctx = createMockContext();
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 0,
      longitude: 0,
      daily_variables: ['river_discharge'],
    });
    const result = await openmeteoGetFloodTool.handler(input, ctx);
    expect(result.daily[0]?.river_discharge).toBeNull();
  });

  it('throws no_variables_requested when daily_variables is empty', async () => {
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    // Input schema requires min(1) so we bypass parse and pass manually
    await expect(
      openmeteoGetFloodTool.handler(
        { latitude: 47.6, longitude: -122.3, daily_variables: [], timezone: 'auto' },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'no_variables_requested' },
    });
  });

  it('throws date_order_invalid when end_date before start_date', async () => {
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
      start_date: '2023-07-10',
      end_date: '2023-07-01',
    });
    await expect(openmeteoGetFloodTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'date_order_invalid' },
    });
  });

  it('throws date_out_of_range when start_date before 1984', async () => {
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
      start_date: '1980-01-01',
      end_date: '1980-12-31',
    });
    await expect(openmeteoGetFloodTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'date_out_of_range' },
    });
  });

  it('throws date_out_of_range when API error envelope has date-related reason', async () => {
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason: 'start_date is out of allowed date range.',
    });
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['river_discharge'],
    });
    await expect(openmeteoGetFloodTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'date_out_of_range' },
    });
  });

  it('throws invalid_variable when API error envelope has non-date reason', async () => {
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason: 'Variable "bogus_discharge" is not a valid flood variable.',
    });
    const ctx = createMockContext({ errors: openmeteoGetFloodTool.errors });
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['bogus_discharge'],
    });
    await expect(openmeteoGetFloodTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_variable' },
    });
  });

  it('returns empty daily array when API returns no daily block', async () => {
    mockGetFlood.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily: undefined,
    });
    const ctx = createMockContext();
    const input = openmeteoGetFloodTool.input.parse({
      latitude: 0,
      longitude: 0,
      daily_variables: ['river_discharge'],
    });
    const result = await openmeteoGetFloodTool.handler(input, ctx);
    expect(result.daily).toHaveLength(0);
  });

  it('formats output with GloFAS label and attribution', () => {
    const blocks = openmeteoGetFloodTool.format!({
      latitude: 47.6,
      longitude: -122.3,
      timezone: 'America/Los_Angeles',
      daily: [{ time: '2026-06-03', river_discharge: 120.5 }],
      daily_units: { river_discharge: 'm³/s' },
    });
    expect(blocks[0]?.text).toContain('GloFAS');
    expect(blocks[0]?.text).toContain('river_discharge');
    expect(blocks[0]?.text).toContain('Open-Meteo.com');
  });

  it('formats empty result with coverage notice', () => {
    const blocks = openmeteoGetFloodTool.format!({
      latitude: 0,
      longitude: 0,
      timezone: 'UTC',
      daily: [],
    });
    expect(blocks[0]?.text).toContain('GloFAS coverage');
  });
});
