/**
 * @fileoverview Tests for openmeteo_get_ensemble tool.
 * @module tests/tools/get-ensemble.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoGetEnsembleTool } from '@/mcp-server/tools/definitions/get-ensemble.tool.js';

const mockGetEnsemble = vi.fn();
const mockSpillover = vi.fn();

vi.mock('@/services/open-meteo/open-meteo-service.js', () => ({
  getOpenMeteoService: () => ({ getEnsemble: mockGetEnsemble }),
}));

vi.mock('@cyanheads/mcp-ts-core/canvas', () => ({
  spillover: (...args: unknown[]) => mockSpillover(...args),
}));

let mockCanvasInstance: unknown;

vi.mock('@/services/canvas-accessor.js', () => ({
  getCanvas: () => mockCanvasInstance,
}));

/**
 * Real upstream envelope shape: the ensemble API returns NO top-level
 * models/members fields — member identity lives only in the column names.
 */
const MOCK_RESPONSE = {
  latitude: 47.595562,
  longitude: -122.32443,
  elevation: 59.0,
  utc_offset_seconds: -25200,
  timezone: 'America/Los_Angeles',
  timezone_abbreviation: 'GMT-7',
  generationtime_ms: 4.2,
  hourly_units: {
    time: 'iso8601',
    temperature_2m_member01: '°C',
    temperature_2m_member02: '°C',
  },
  hourly: {
    time: ['2026-06-03T00:00', '2026-06-03T01:00'],
    temperature_2m_member01: [14.2, 13.8],
    temperature_2m_member02: [14.9, 14.3],
  },
};

describe('openmeteoGetEnsembleTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasInstance = undefined;
    mockSpillover.mockResolvedValue({ spilled: false, previewRows: [] });
  });

  it('reshapes per-member columnar response into per-timestamp records', async () => {
    mockGetEnsemble.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext();
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m'],
      models: 'ecmwf_ifs025',
    });
    const result = await openmeteoGetEnsembleTool.handler(input, ctx);

    expect(result.hourly).toHaveLength(2);
    expect(result.hourly![0]).toEqual({
      time: '2026-06-03T00:00',
      temperature_2m_member01: 14.2,
      temperature_2m_member02: 14.9,
    });
    expect(result.hourly![1]).toEqual({
      time: '2026-06-03T01:00',
      temperature_2m_member01: 13.8,
      temperature_2m_member02: 14.3,
    });
    expect(result.model).toBe('ecmwf_ifs025');
    expect(result.member_count).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.hourly_units).toMatchObject({
      temperature_2m_member01: '°C',
      temperature_2m_member02: '°C',
    });
  });

  it('returns daily ensemble records when daily_variables provided', async () => {
    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: undefined,
      hourly_units: undefined,
      daily_units: { time: 'iso8601', temperature_2m_max_member01: '°C' },
      daily: {
        time: ['2026-06-03', '2026-06-04'],
        temperature_2m_max_member01: [18.5, 20.1],
      },
    });
    const ctx = createMockContext();
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      daily_variables: ['temperature_2m_max'],
    });
    const result = await openmeteoGetEnsembleTool.handler(input, ctx);

    expect(result.daily).toHaveLength(2);
    expect(result.daily![0]).toEqual({
      time: '2026-06-03',
      temperature_2m_max_member01: 18.5,
    });
    expect(result.daily_units).toMatchObject({ temperature_2m_max_member01: '°C' });
  });

  it('derives member_count from distinct _memberNN column suffixes across hourly and daily blocks', async () => {
    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: {
        time: ['2026-06-03T00:00'],
        temperature_2m: [14.0], // base/control column — not a member
        temperature_2m_member01: [14.2],
        temperature_2m_member02: [14.9],
      },
      daily_units: { time: 'iso8601', temperature_2m_max_member01: '°C' },
      daily: {
        time: ['2026-06-03'],
        temperature_2m_max: [18.0],
        temperature_2m_max_member01: [18.5],
        temperature_2m_max_member02: [19.0],
        temperature_2m_max_member03: [17.8],
      },
    });
    const ctx = createMockContext();
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m'],
      daily_variables: ['temperature_2m_max'],
    });
    const result = await openmeteoGetEnsembleTool.handler(input, ctx);

    // Distinct suffixes are 01, 02, 03 — the same member across variables/blocks counts once
    expect(result.member_count).toBe(3);
    // models omitted from input → no provenance to echo
    expect(result.model).toBeUndefined();
  });

  it('echoes the requested model and leaves member_count absent when no member columns exist', async () => {
    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: {
        time: ['2026-06-03T00:00'],
        temperature_2m: [14.0],
      },
    });
    const ctx = createMockContext();
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m'],
      models: 'gfs025',
    });
    const result = await openmeteoGetEnsembleTool.handler(input, ctx);

    expect(result.model).toBe('gfs025');
    expect(result.member_count).toBeUndefined();
  });

  it('throws no_variables_requested when neither hourly nor daily provided', async () => {
    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const input = openmeteoGetEnsembleTool.input.parse({ latitude: 47.6, longitude: -122.3 });
    await expect(openmeteoGetEnsembleTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'no_variables_requested' },
    });
  });

  it('frames the upstream unknown-variable rejection with the offending name and recovery hint', async () => {
    // Real upstream reason shape from the live ensemble endpoint
    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason:
        "Data corrupted at path ''. Cannot initialize SurfacePressureAndHeightVariable<VariableAndPreviousDay, VariableOrSpread<ForecastPressureVariable>, ForecastHeightVariable> from invalid String value bogus_ens_xyz.",
    });
    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['bogus_ens_xyz'],
    });
    await expect(openmeteoGetEnsembleTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringMatching(/^Unknown variable or model name: bogus_ens_xyz\./),
      data: {
        reason: 'invalid_variable',
        recovery: { hint: expect.stringContaining('ecmwf_ifs025') },
      },
    });
  });

  it('frames an unsupported-model rejection the same way', async () => {
    // Real upstream reason shape when models=<bogus> is rejected
    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason:
        "Data corrupted at path ''. Cannot initialize MultiDomains from invalid String value not_a_model.",
    });
    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m'],
      models: 'not_a_model',
    });
    await expect(openmeteoGetEnsembleTool.handler(input, ctx)).rejects.toMatchObject({
      message: expect.stringMatching(/^Unknown variable or model name: not_a_model\./),
      data: { reason: 'invalid_variable' },
    });
  });

  it('preserves null values from sparse member arrays', async () => {
    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: {
        time: ['2026-06-03T00:00'],
        temperature_2m_member01: [null],
        temperature_2m_member02: [14.9],
      },
    });
    const ctx = createMockContext();
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m'],
    });
    const result = await openmeteoGetEnsembleTool.handler(input, ctx);
    expect(result.hourly![0]?.temperature_2m_member01).toBeNull();
    expect(result.hourly![0]?.temperature_2m_member02).toBe(14.9);
  });

  it('spills to DataCanvas and sets truncated=true when records exceed INLINE_LIMIT', async () => {
    const count = 502;
    const time = Array.from({ length: count }, (_, i) => {
      const d = new Date('2026-06-01T00:00');
      d.setHours(d.getHours() + i);
      return d.toISOString().slice(0, 16);
    });
    const temperature_2m_member01 = Array.from({ length: count }, (_, i) => 10 + (i % 20));

    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: { time, temperature_2m_member01 },
      hourly_units: { time: 'iso8601', temperature_2m_member01: '°C' },
    });

    const previewRows = time
      .slice(0, 5)
      .map((t, i) => ({ time: t, temperature_2m_member01: 10 + i }));
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: count, tableName: 'spilled_ens123' },
      previewRows,
    });

    const mockInstance = { canvasId: 'canvas-ens-456' };
    const mockCanvas = { acquire: vi.fn().mockResolvedValue(mockInstance) };
    mockCanvasInstance = mockCanvas;

    const ctx = createMockContext();
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m'],
      forecast_days: 16,
    });

    const result = await openmeteoGetEnsembleTool.handler(input, ctx);
    expect(mockCanvas.acquire).toHaveBeenCalled();
    expect(mockSpillover).toHaveBeenCalled();
    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBe('canvas-ens-456');
    expect(result.record_count).toBe(count);
    // Spillover path also derives member_count from the source columns
    expect(result.member_count).toBe(1);
  });

  it('omits canvas_id when records exceed INLINE_LIMIT but spillover stays under its byte threshold', async () => {
    // Regression: spillover() stages a table only past its byte threshold — when it
    // returns spilled: false, no canvas_id must be surfaced (it would be empty).
    const count = 502;
    const time = Array.from({ length: count }, (_, i) => {
      const d = new Date('2026-06-01T00:00');
      d.setHours(d.getHours() + i);
      return d.toISOString().slice(0, 16);
    });
    const temperature_2m_member01 = Array.from({ length: count }, () => 15.0);

    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: { time, temperature_2m_member01 },
    });

    mockSpillover.mockResolvedValue({
      spilled: false,
      previewRows: time.map((t) => ({ time: t, temperature_2m_member01: 15.0 })),
    });

    const mockInstance = { canvasId: 'canvas-unused-2' };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext();
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m'],
      forecast_days: 16,
    });

    const result = await openmeteoGetEnsembleTool.handler(input, ctx);
    expect(result.truncated).toBe(false);
    expect(result.canvas_id).toBeUndefined();
    expect(result.record_count).toBe(count);
  });

  it('returns inline without canvas when records are within INLINE_LIMIT', async () => {
    const count = 500;
    const time = Array.from({ length: count }, (_, i) => {
      const d = new Date('2026-06-01T00:00');
      d.setHours(d.getHours() + i);
      return d.toISOString().slice(0, 16);
    });
    const temperature_2m_member01 = Array.from({ length: count }, () => 15.0);

    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: { time, temperature_2m_member01 },
    });

    const ctx = createMockContext();
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m'],
    });
    const result = await openmeteoGetEnsembleTool.handler(input, ctx);
    expect(result.truncated).toBe(false);
    expect(result.canvas_id).toBeUndefined();
    expect(result.record_count).toBe(500);
  });

  it('formats output with model info and attribution', () => {
    const blocks = openmeteoGetEnsembleTool.format!({
      latitude: 47.6,
      longitude: -122.3,
      elevation: 59,
      timezone: 'America/Los_Angeles',
      model: 'ecmwf_ifs025',
      member_count: 51,
      record_count: 2,
      truncated: false,
      hourly: [{ time: '2026-06-03T00:00', temperature_2m_member01: 14.2 }],
      hourly_units: { temperature_2m_member01: '°C' },
    });
    expect(blocks[0]?.text).toContain('Ensemble');
    expect(blocks[0]?.text).toContain('ecmwf_ifs025');
    expect(blocks[0]?.text).toContain('51');
    expect(blocks[0]?.text).toContain('Open-Meteo.com');
  });

  it('surfaces non-null rows in the truncated preview when past_days leads with nulls, and reports the staged total in the heading', async () => {
    // Issue repro: past_days=10 → the ensemble models don't hindcast, so the earliest
    // rows are all-null placeholders. A chronological head-drain preview would be all
    // null while the staged canvas holds the useful forecast rows.
    const total = 624;
    const nullLead = 240; // leading all-null past-day rows
    const time = Array.from({ length: total }, (_, i) => {
      const d = new Date('2026-06-18T00:00');
      d.setHours(d.getHours() + i);
      return d.toISOString().slice(0, 16);
    });
    const temperature_2m_member01 = Array.from({ length: total }, (_, i) =>
      i < nullLead ? null : 15 + (i % 10),
    );
    const temperature_2m_member02 = Array.from({ length: total }, (_, i) =>
      i < nullLead ? null : 14 + (i % 8),
    );

    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: { time, temperature_2m_member01, temperature_2m_member02 },
      hourly_units: {
        time: 'iso8601',
        temperature_2m_member01: '°C',
        temperature_2m_member02: '°C',
      },
    });

    // spillover stages the full chronological set; its byte-drained previewRows would
    // be all-null here — the handler must build the inline preview independently.
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: total, tableName: 'spilled_ens789' },
      previewRows: time.slice(0, 5).map((t) => ({ time: t, temperature_2m_member01: null })),
    });

    const mockInstance = { canvasId: 'Ij7fx6D3bo' };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext();
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m'],
      models: 'gfs025',
      forecast_days: 16,
      past_days: 10,
    });
    const result = await openmeteoGetEnsembleTool.handler(input, ctx);

    expect(result.truncated).toBe(true);
    expect(result.record_count).toBe(total);
    // #14: the preview no longer leads with the all-null past-day rows — it starts at
    // the first row carrying data (index nullLead), with real member values.
    expect(result.hourly!.length).toBeGreaterThan(0);
    expect(result.hourly![0]?.time).toBe(time[nullLead]);
    expect(result.hourly![0]?.temperature_2m_member01).toBe(15);
    expect(result.hourly![0]?.temperature_2m_member02).toBe(14);
    // The staged canvas keeps every row; the preview is a strict subset of them.
    expect(result.hourly!.length).toBeLessThan(total);

    const text = openmeteoGetEnsembleTool.format!(result)[0]?.text ?? '';
    // #13: heading references the staged total (624), not the preview length.
    expect(text).toContain(`of ${total} total`);
    // #14: discloses that omitted preview rows may be null past-day rows.
    expect(text).toContain('past_days');
    // Shown preview rows carry real values, not nulls.
    expect(text).not.toContain('temperature_2m_member01: null');
  });

  it('formats member count for the default blend (no model)', () => {
    const blocks = openmeteoGetEnsembleTool.format!({
      latitude: 47.6,
      longitude: -122.3,
      elevation: 59,
      timezone: 'America/Los_Angeles',
      member_count: 30,
      record_count: 2,
      truncated: false,
      daily: [{ time: '2026-06-03', temperature_2m_max_member01: 18.5 }],
      daily_units: { temperature_2m_max_member01: '°C' },
    });
    expect(blocks[0]?.text).toContain('default blend');
    expect(blocks[0]?.text).toContain('**Members:** 30');
  });
});
