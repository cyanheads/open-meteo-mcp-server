/**
 * @fileoverview Tests for openmeteo_get_historical tool.
 * @module tests/tools/get-historical.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoGetHistoricalTool } from '@/mcp-server/tools/definitions/get-historical.tool.js';

const mockGetHistorical = vi.fn();
const mockSpillover = vi.fn();

vi.mock('@/services/open-meteo/open-meteo-service.js', () => ({
  getOpenMeteoService: () => ({ getHistorical: mockGetHistorical }),
}));

// Mock the canvas spillover helper — allows per-test control over spill behaviour
vi.mock('@cyanheads/mcp-ts-core/canvas', () => ({
  spillover: (...args: unknown[]) => mockSpillover(...args),
}));

// Canvas mock — returns undefined by default; individual tests can override
let mockCanvasInstance: unknown;

vi.mock('@/services/canvas-accessor.js', () => ({
  getCanvas: () => mockCanvasInstance,
}));

const MOCK_RESPONSE = {
  latitude: 47.595562,
  longitude: -122.32443,
  elevation: 59.0,
  utc_offset_seconds: -25200,
  timezone: 'America/Los_Angeles',
  timezone_abbreviation: 'GMT-7',
  generationtime_ms: 1.2,
  daily_units: { time: 'iso8601', temperature_2m_max: '°C', precipitation_sum: 'mm' },
  daily: {
    time: ['2024-07-01', '2024-07-02'],
    temperature_2m_max: [22.5, 20.1],
    precipitation_sum: [0.0, 1.2],
  },
};

describe('openmeteoGetHistoricalTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasInstance = undefined; // reset canvas to disabled state
    // Default spillover mock: fit result (no spill) — overridden per test
    mockSpillover.mockResolvedValue({
      spilled: false,
      previewRows: [],
    });
  });

  it('reshapes daily ERA5 data into per-date records with exact values', async () => {
    mockGetHistorical.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext();
    const input = openmeteoGetHistoricalTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      start_date: '2024-07-01',
      end_date: '2024-07-02',
      daily_variables: ['temperature_2m_max', 'precipitation_sum'],
    });
    const result = await openmeteoGetHistoricalTool.handler(input, ctx);

    expect(result.daily).toHaveLength(2);
    // Exact position check — both variables at each date
    expect(result.daily![0]).toEqual({
      time: '2024-07-01',
      temperature_2m_max: 22.5,
      precipitation_sum: 0.0,
    });
    expect(result.daily![1]).toEqual({
      time: '2024-07-02',
      temperature_2m_max: 20.1,
      precipitation_sum: 1.2,
    });
    expect(result.truncated).toBe(false);
    expect(result.record_count).toBe(2);
  });

  it('throws no_variables_requested with correct reason when none provided', async () => {
    const ctx = createMockContext({ errors: openmeteoGetHistoricalTool.errors });
    const input = openmeteoGetHistoricalTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      start_date: '2024-07-01',
      end_date: '2024-07-02',
    });
    await expect(openmeteoGetHistoricalTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'no_variables_requested' },
    });
  });

  it('throws date_order_invalid with correct reason when end before start', async () => {
    const ctx = createMockContext({ errors: openmeteoGetHistoricalTool.errors });
    const input = openmeteoGetHistoricalTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      start_date: '2024-07-10',
      end_date: '2024-07-01',
      daily_variables: ['temperature_2m_max'],
    });
    await expect(openmeteoGetHistoricalTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'date_order_invalid' },
    });
  });

  it('throws date_out_of_range with correct reason when start_date before 1940', async () => {
    const ctx = createMockContext({ errors: openmeteoGetHistoricalTool.errors });
    const input = openmeteoGetHistoricalTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      start_date: '1900-01-01',
      end_date: '1900-12-31',
      daily_variables: ['temperature_2m_max'],
    });
    await expect(openmeteoGetHistoricalTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'date_out_of_range' },
    });
  });

  it('throws date_out_of_range when API returns error envelope with date-related reason', async () => {
    mockGetHistorical.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason: 'start_date is out of allowed date range.',
    });
    const ctx = createMockContext({ errors: openmeteoGetHistoricalTool.errors });
    const input = openmeteoGetHistoricalTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      start_date: '2024-07-01',
      end_date: '2024-07-02',
      daily_variables: ['temperature_2m_max'],
    });
    await expect(openmeteoGetHistoricalTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'date_out_of_range' },
    });
  });

  it('throws invalid_variable (not date_out_of_range) when API error envelope has non-date reason', async () => {
    // Regression: the handler catch-all previously mapped ALL API errors to date_out_of_range,
    // including invalid variable names. Non-date errors must produce invalid_variable.
    mockGetHistorical.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason: 'Variable "bogus_historical_var" is not a valid historical variable.',
    });
    const ctx = createMockContext({ errors: openmeteoGetHistoricalTool.errors });
    const input = openmeteoGetHistoricalTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      start_date: '2024-07-01',
      end_date: '2024-07-02',
      hourly_variables: ['bogus_historical_var'],
    });
    await expect(openmeteoGetHistoricalTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_variable' },
    });
  });

  it('throws date_out_of_range when API error reason contains "range"', async () => {
    // Verifies the "range" keyword path is also classified correctly.
    mockGetHistorical.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason: 'Parameter start_date is out of allowed range from 1940-01-01 to 2026-05-30.',
    });
    const ctx = createMockContext({ errors: openmeteoGetHistoricalTool.errors });
    const input = openmeteoGetHistoricalTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      start_date: '2024-07-01',
      end_date: '2024-07-02',
      daily_variables: ['temperature_2m_max'],
    });
    await expect(openmeteoGetHistoricalTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'date_out_of_range' },
    });
  });

  it('spills to DataCanvas and sets truncated=true when records exceed INLINE_LIMIT', async () => {
    // Build a response with 502 daily records (> INLINE_LIMIT of 500)
    const days = 502;
    const time = Array.from({ length: days }, (_, i) => {
      const d = new Date('2022-01-01');
      d.setDate(d.getDate() + i);
      return d.toISOString().slice(0, 10);
    });
    const temperature_2m_max = Array.from({ length: days }, (_, i) => 10 + (i % 20));

    mockGetHistorical.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily_units: { time: 'iso8601', temperature_2m_max: '°C' },
      daily: { time, temperature_2m_max },
    });

    // Configure spillover mock to simulate a successful spill
    const previewRows = time.slice(0, 5).map((t, i) => ({ time: t, temperature_2m_max: 10 + i }));
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: days, tableName: 'spilled_abc123' },
      previewRows,
    });

    // Enable canvas
    const mockInstance = { canvasId: 'canvas-test-123' };
    const mockCanvas = { acquire: vi.fn().mockResolvedValue(mockInstance) };
    mockCanvasInstance = mockCanvas;

    const ctx = createMockContext();
    const input = openmeteoGetHistoricalTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      start_date: '2022-01-01',
      end_date: '2023-05-17',
      daily_variables: ['temperature_2m_max'],
    });

    const result = await openmeteoGetHistoricalTool.handler(input, ctx);

    expect(mockCanvas.acquire).toHaveBeenCalled();
    expect(mockSpillover).toHaveBeenCalled();
    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBe('canvas-test-123');
    expect(result.record_count).toBe(days);
  });

  it('returns inline result without canvas when records are within INLINE_LIMIT', async () => {
    // Exactly 500 daily records — at the limit, not over
    const days = 500;
    const time = Array.from({ length: days }, (_, i) => {
      const d = new Date('2023-01-01');
      d.setDate(d.getDate() + i);
      return d.toISOString().slice(0, 10);
    });
    const temperature_2m_max = Array.from({ length: days }, () => 15.0);

    mockGetHistorical.mockResolvedValue({
      ...MOCK_RESPONSE,
      daily_units: { time: 'iso8601', temperature_2m_max: '°C' },
      daily: { time, temperature_2m_max },
    });

    const ctx = createMockContext();
    const input = openmeteoGetHistoricalTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      start_date: '2023-01-01',
      end_date: '2024-05-15',
      daily_variables: ['temperature_2m_max'],
    });

    const result = await openmeteoGetHistoricalTool.handler(input, ctx);
    expect(result.truncated).toBe(false);
    expect(result.canvas_id).toBeUndefined();
    expect(result.record_count).toBe(500);
    expect(result.daily).toHaveLength(500);
  });

  it('formats output with attribution', () => {
    const blocks = openmeteoGetHistoricalTool.format!({
      latitude: 47.6,
      longitude: -122.3,
      elevation: 59,
      timezone: 'America/Los_Angeles',
      date_range: { start: '2024-07-01', end: '2024-07-02' },
      record_count: 2,
      daily: [{ time: '2024-07-01', temperature_2m_max: 22.5 }],
      hourly_units: undefined,
      daily_units: { temperature_2m_max: '°C' },
      canvas_id: undefined,
      truncated: false,
    });
    expect(blocks[0]?.text).toContain('ERA5');
    expect(blocks[0]?.text).toContain('Open-Meteo.com');
  });

  it('formats truncated result with canvas_id notice', () => {
    const blocks = openmeteoGetHistoricalTool.format!({
      latitude: 47.6,
      longitude: -122.3,
      elevation: 59,
      timezone: 'America/Los_Angeles',
      date_range: { start: '2020-01-01', end: '2025-12-31' },
      record_count: 43800,
      daily: [{ time: '2020-01-01', temperature_2m_max: 5.0 }],
      hourly_units: undefined,
      daily_units: { temperature_2m_max: '°C' },
      canvas_id: 'canvas-xyz-789',
      truncated: true,
    });
    expect(blocks[0]?.text).toContain('canvas-xyz-789');
    // Format uses bold label: **Truncated:** true
    expect(blocks[0]?.text).toContain('Truncated:');
    expect(blocks[0]?.text).toContain('true');
  });
});
