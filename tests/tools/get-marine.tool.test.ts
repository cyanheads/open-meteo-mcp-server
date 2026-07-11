/**
 * @fileoverview Tests for openmeteo_get_marine tool.
 * @module tests/tools/get-marine.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoGetMarineTool } from '@/mcp-server/tools/definitions/get-marine.tool.js';

const mockGetMarine = vi.fn();

vi.mock('@/services/open-meteo/open-meteo-service.js', () => ({
  getOpenMeteoService: () => ({ getMarine: mockGetMarine }),
}));

const MOCK_RESPONSE = {
  latitude: 47.8,
  longitude: -122.5,
  elevation: 0,
  utc_offset_seconds: -25200,
  timezone: 'America/Los_Angeles',
  timezone_abbreviation: 'GMT-7',
  generationtime_ms: 0.3,
  hourly_units: { time: 'iso8601', wave_height: 'm', wave_period: 's' },
  hourly: {
    time: ['2026-05-30T00:00', '2026-05-30T01:00'],
    wave_height: [0.5, 0.6],
    wave_period: [8.0, 8.5],
  },
};

describe('openmeteoGetMarineTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reshapes columnar marine response with exact per-timestamp alignment', async () => {
    mockGetMarine.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext();
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height', 'wave_period'],
    });
    const result = await openmeteoGetMarineTool.handler(input, ctx);

    expect(result.hourly).toHaveLength(2);
    expect(result.hourly![0]).toEqual({
      time: '2026-05-30T00:00',
      wave_height: 0.5,
      wave_period: 8.0,
    });
    expect(result.hourly![1]).toEqual({
      time: '2026-05-30T01:00',
      wave_height: 0.6,
      wave_period: 8.5,
    });
    expect(result.hourly_units).toMatchObject({ wave_height: 'm', wave_period: 's' });
  });

  it('preserves null values for ocean_current_velocity (non-open-ocean coordinates)', async () => {
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: { time: 'iso8601', wave_height: 'm', ocean_current_velocity: 'km/h' },
      hourly: {
        time: ['2026-05-30T00:00'],
        wave_height: [0.5],
        ocean_current_velocity: [null],
      },
    });
    const ctx = createMockContext();
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['wave_height', 'ocean_current_velocity'],
    });
    const result = await openmeteoGetMarineTool.handler(input, ctx);
    expect(result.hourly![0]?.ocean_current_velocity).toBeNull();
    expect(result.hourly![0]?.wave_height).toBe(0.5);
  });

  it('throws no_variables_requested with correct reason when none provided', async () => {
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
    });
    await expect(openmeteoGetMarineTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'no_variables_requested' },
    });
  });

  it('frames the upstream unknown-variable rejection with the offending name and recovery hint', async () => {
    // Real upstream reason shape from the live marine endpoint
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason:
        "Data corrupted at path ''. Cannot initialize SurfacePressureAndHeightVariable<VariableAndPreviousDay, VariableOrSpread<ForecastPressureVariable>, ForecastHeightVariable> from invalid String value bogus_wave.",
    });
    const ctx = createMockContext({ errors: openmeteoGetMarineTool.errors });
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      hourly_variables: ['bogus_wave'],
    });
    await expect(openmeteoGetMarineTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringMatching(/^Unknown variable name: bogus_wave\./),
      data: {
        reason: 'invalid_variable',
        recovery: { hint: expect.stringContaining('wave_height') },
      },
    });
  });

  it('reshapes daily marine variables when daily_variables provided', async () => {
    mockGetMarine.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily_units: { time: 'iso8601', wave_height_max: 'm' },
      daily: {
        time: ['2026-05-30', '2026-05-31'],
        wave_height_max: [1.2, 0.9],
      },
    });
    const ctx = createMockContext();
    const input = openmeteoGetMarineTool.input.parse({
      latitude: 47.8,
      longitude: -122.5,
      daily_variables: ['wave_height_max'],
    });
    const result = await openmeteoGetMarineTool.handler(input, ctx);
    expect(result.daily).toHaveLength(2);
    expect(result.daily![0]).toEqual({ time: '2026-05-30', wave_height_max: 1.2 });
    expect(result.daily![1]).toEqual({ time: '2026-05-31', wave_height_max: 0.9 });
    expect(result.daily_units).toMatchObject({ wave_height_max: 'm' });
  });

  it('formats output with attribution', () => {
    const blocks = openmeteoGetMarineTool.format!({
      latitude: 47.8,
      longitude: -122.5,
      timezone: 'America/Los_Angeles',
      hourly: [{ time: '2026-05-30T00:00', wave_height: 0.5 }],
      hourly_units: { wave_height: 'm' },
    });
    expect(blocks[0]?.text).toContain('Marine');
    expect(blocks[0]?.text).toContain('Open-Meteo.com');
  });

  it('renders every hourly row in content[] with no cap or "…and N more" (format parity)', () => {
    // 50 rows is above the former 48-row render cap.
    const hourly = Array.from({ length: 50 }, (_, i) => ({
      time: `2026-05-30T00:00+${i}`,
      wave_height: 1000 + i,
    }));
    const text =
      openmeteoGetMarineTool.format!({
        latitude: 47.8,
        longitude: -122.5,
        timezone: 'America/Los_Angeles',
        hourly,
        hourly_units: { wave_height: 'm' },
      })[0]?.text ?? '';
    expect(text).toContain('### Hourly marine (50 records)');
    expect(text).toContain('wave_height: 1000');
    expect(text).toContain('wave_height: 1049'); // last row — not sliced at 48
    expect(text).not.toMatch(/and \d+ more/);
  });
});
