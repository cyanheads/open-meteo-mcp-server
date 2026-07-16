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

// Mock spillover only — the real inferSchemaFromRows backs deriveSpillSchema, so the
// schema the handler hands to spillover() is genuinely derived, not stubbed.
vi.mock('@cyanheads/mcp-ts-core/canvas', async (importActual) => ({
  ...(await importActual<typeof import('@cyanheads/mcp-ts-core/canvas')>()),
  spillover: (...args: unknown[]) => mockSpillover(...args),
}));

let mockCanvasInstance: unknown;

/** Column type by name from the schema handed to spillover(). */
const spilledSchemaType = (name: string): string | undefined => {
  const [opts] = mockSpillover.mock.calls[0] as [{ schema?: { name: string; type: string }[] }];
  return opts.schema?.find((c) => c.name === name)?.type;
};

/** Column names in the schema handed to spillover(). */
const spilledSchemaNames = (): string[] => {
  const [opts] = mockSpillover.mock.calls[0] as [{ schema?: { name: string }[] }];
  return (opts.schema ?? []).map((c) => c.name);
};

/**
 * A gfs025-shaped hourly block: 31 member columns per variable. Wide enough that a
 * real 16-day pull overflows the inline budget, matching the live repro.
 */
const memberBlock = (
  time: string[],
  valueAt: (row: number, member: number) => number | null,
  variable = 'temperature_2m',
): Record<string, (number | null)[] | string[]> => {
  const block: Record<string, (number | null)[] | string[]> = { time };
  for (let m = 1; m <= 31; m++) {
    block[`${variable}_member${String(m).padStart(2, '0')}`] = time.map((_, row) =>
      valueAt(row, m),
    );
  }
  return block;
};

/** `count` consecutive hourly ISO timestamps. */
const hourlyTimes = (count: number, from = '2026-06-18T00:00'): string[] =>
  Array.from({ length: count }, (_, i) => {
    const d = new Date(from);
    d.setHours(d.getHours() + i);
    return d.toISOString().slice(0, 16);
  });

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

  it('spills to DataCanvas and sets truncated=true when the payload exceeds the inline budget', async () => {
    const time = hourlyTimes(384, '2026-06-01T00:00');

    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: memberBlock(time, (row, m) => 10 + ((row + m) % 20) + m / 100),
      hourly_units: { time: 'iso8601', temperature_2m_member01: '°C' },
    });

    const previewRows = time
      .slice(0, 5)
      .map((t, i) => ({ time: t, temperature_2m_member01: 10 + i }));
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: time.length, tableName: 'spilled_ens123' },
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
    expect(result.record_count).toBe(time.length);
    expect(result.table_name).toBe('spilled_ens123'); // #18: exact staged table name surfaced
    // Spillover path also derives member_count from the source columns
    expect(result.member_count).toBe(31);
  });

  it('spills a wide member fan-out that sits far below 500 rows', async () => {
    // #23: 384 rows × 31 member columns — the old row-count gate let this return
    // ~376 KB inline with no canvas_id and no retrieval path.
    const time = hourlyTimes(384, '2026-06-01T00:00');
    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: memberBlock(time, (row, m) => 10 + ((row + m) % 20) + m / 100),
    });

    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: time.length, tableName: 'spilled_wide' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-wide' }) };

    const ctx = createMockContext();
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m'],
      models: 'gfs025',
      forecast_days: 16,
    });

    const result = await openmeteoGetEnsembleTool.handler(input, ctx);
    expect(time.length).toBeLessThan(500);
    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBe('canvas-wide');
    expect(result.table_name).toBe('spilled_wide');
  });

  it('returns no canvas handles when spillover declines to stage a table', async () => {
    // The handler must never surface a canvas_id pointing at an empty canvas —
    // spilled.handle only exists on the spilled branch of the union.
    const time = hourlyTimes(600, '2026-06-01T00:00');
    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: memberBlock(time, () => 15.0),
    });

    mockSpillover.mockResolvedValue({
      spilled: false,
      previewRows: time.map((t) => ({ time: t, temperature_2m_member01: 15.0 })),
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-unused-2' }) };

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
    expect(result.table_name).toBeUndefined();
  });

  it('returns inline without touching a canvas when the payload fits', async () => {
    const time = hourlyTimes(500, '2026-06-01T00:00');
    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: { time, temperature_2m_member01: time.map(() => 15.0) },
    });

    const acquire = vi.fn();
    mockCanvasInstance = { acquire };

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
    expect(result.table_name).toBeUndefined(); // #18: no table name on the non-spill path
    // A result that fits must not mint a canvas — an acquired-but-unused canvas
    // holds a per-tenant slot the caller never learns about.
    expect(acquire).not.toHaveBeenCalled();
  });

  it('types member columns from real values when past_days leads with an all-null run', async () => {
    // #21: the leading placeholder rows exhaust spillover()'s own sniff window, so
    // every member column would be typed VARCHAR and its numbers String()-coerced.
    const total = 624;
    const nullLead = 240;
    const time = hourlyTimes(total);

    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: memberBlock(time, (row, m) => (row < nullLead ? null : 15 + ((row + m) % 10) + 0.9)),
    });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: total, tableName: 'spilled_types' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-types' }) };

    const ctx = createMockContext();
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m'],
      models: 'gfs025',
      forecast_days: 16,
      past_days: 10,
    });
    await openmeteoGetEnsembleTool.handler(input, ctx);

    // An explicit schema is passed at all — spillover() must never infer here.
    const [opts] = mockSpillover.mock.calls[0] as [{ schema?: unknown }];
    expect(opts.schema).toBeDefined();
    expect(spilledSchemaType('temperature_2m_member01')).toBe('DOUBLE');
    expect(spilledSchemaType('temperature_2m_member31')).toBe('DOUBLE');
    expect(spilledSchemaType('time')).toBe('VARCHAR');
  });

  it('covers both cadences in the spill schema when hourly and daily are requested', async () => {
    // #22: hourly records are concatenated ahead of daily ones, so a preview-sized
    // sniff window never reaches a daily row and daily-only columns are never created.
    const hourlyTime = hourlyTimes(400);
    const dailyTime = Array.from(
      { length: 16 },
      (_, i) => `2026-06-${String(i + 1).padStart(2, '0')}`,
    );

    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: memberBlock(hourlyTime, (row, m) => 10 + ((row + m) % 20) + 0.5),
      daily: memberBlock(dailyTime, (row, m) => 20 + ((row + m) % 8) + 0.5, 'temperature_2m_max'),
    });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: hourlyTime.length + dailyTime.length, tableName: 'spilled_union' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-union' }) };

    const ctx = createMockContext();
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: ['temperature_2m'],
      daily_variables: ['temperature_2m_max'],
      models: 'gfs025',
      forecast_days: 16,
      past_days: 10,
    });
    await openmeteoGetEnsembleTool.handler(input, ctx);

    const columns = spilledSchemaNames();
    expect(columns).toContain('temperature_2m_member01');
    expect(columns).toContain('temperature_2m_max_member01'); // daily-only column survives
    expect(columns).toContain('temperature_2m_max_member31');
    expect(spilledSchemaType('temperature_2m_max_member01')).toBe('DOUBLE');
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
    const time = hourlyTimes(total);

    // member01 starts at 15 and member02 at 14 on the first row carrying data.
    const valueAt = (row: number, member: number) => {
      if (row < nullLead) return null;
      return member === 1 ? 15 + (row % 10) : 14 + (row % 8);
    };

    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: memberBlock(time, valueAt),
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
    expect(result.table_name).toBe('spilled_ens789'); // #18: exact staged table name surfaced
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

  it('renders every hourly row (non-truncated) with no cap or "…and N more" (format parity)', () => {
    // 30 rows is above the former 24-row render cap.
    const hourly = Array.from({ length: 30 }, (_, i) => ({
      time: `2026-06-03T00:00+${i}`,
      temperature_2m_member01: 1000 + i,
    }));
    const text =
      openmeteoGetEnsembleTool.format!({
        latitude: 47.6,
        longitude: -122.3,
        elevation: 59,
        timezone: 'America/Los_Angeles',
        model: 'gfs025',
        member_count: 1,
        record_count: 30,
        truncated: false,
        hourly,
        hourly_units: { temperature_2m_member01: '°C' },
      })[0]?.text ?? '';
    expect(text).toContain('### Hourly ensemble (30 records)');
    expect(text).toContain('temperature_2m_member01: 1000');
    expect(text).toContain('temperature_2m_member01: 1029'); // last row — not sliced at 24
    expect(text).not.toMatch(/and \d+ more/);
  });
});
