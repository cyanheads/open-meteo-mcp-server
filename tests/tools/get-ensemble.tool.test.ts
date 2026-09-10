/**
 * @fileoverview Tests for openmeteo_get_ensemble tool.
 * @module tests/tools/get-ensemble.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoGetEnsembleTool } from '@/mcp-server/tools/definitions/get-ensemble.tool.js';
import { INLINE_CHARS } from '@/mcp-server/tools/spill-utils.js';
import { firstText } from '../helpers/content.js';
import { rowBudgetFor, structuredSize } from '../helpers/inline-surface.js';

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
    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
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
    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
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
    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
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
    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
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

  it('sends an undocumented model name upstream unrejected (#31)', async () => {
    // The advertised list is not an allowlist: a model Open-Meteo adds after this
    // release must reach the API rather than die on a local check.
    mockGetEnsemble.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m'],
      models: 'a_model_open_meteo_added_later',
    });

    const result = await openmeteoGetEnsembleTool.handler(input, ctx);

    const params = mockGetEnsemble.mock.calls[0]?.[2] as { models?: string };
    expect(params?.models).toBe('a_model_open_meteo_added_later');
    expect(result.model).toBe('a_model_open_meteo_added_later');
  });

  it('advertises the documented ensemble models in the description and recovery hint (#31)', () => {
    const invalidVariable = openmeteoGetEnsembleTool.errors?.find(
      (entry) => entry.reason === 'invalid_variable',
    );

    for (const model of [
      'ecmwf_ifs025_ensemble',
      'ecmwf_aifs025_ensemble',
      'ukmo_global_ensemble_20km',
      'google_weathernext2_ensemble',
    ]) {
      expect(openmeteoGetEnsembleTool.description).toContain(model);
      expect(invalidVariable?.recovery).toContain(model);
    }
  });

  it('throws no_variables_requested when neither hourly nor daily provided', async () => {
    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const input = openmeteoGetEnsembleTool.input.parse({ latitude: 47.6, longitude: -122.3 });
    await expect(openmeteoGetEnsembleTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'no_variables_requested' },
    });
  });

  it('names a misplaced ensemble variable and its field (#26)', async () => {
    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m', 'precipitation_sum'],
    });

    await expect(openmeteoGetEnsembleTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining(
        'precipitation_sum is not valid in hourly_variables — Open-Meteo publishes it as a daily variable.',
      ),
      data: { reason: 'variable_wrong_cadence' },
    });
    expect(mockGetEnsemble).not.toHaveBeenCalled();
  });

  it('accepts temperature_2m_max in hourly_variables — the ensemble API publishes it there', async () => {
    // The forecast endpoint publishes it under daily only, so a shared catalog would
    // reject this valid request. The ensemble catalog is its own.
    mockGetEnsemble.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m_max'],
    });

    await openmeteoGetEnsembleTool.handler(input, ctx);

    const callArgs = mockGetEnsemble.mock.calls[0]?.[2] as { hourly?: string[] };
    expect(callArgs?.hourly).toEqual(['temperature_2m_max']);
  });

  it('sends an unknown ensemble variable name upstream unrejected (#7)', async () => {
    mockGetEnsemble.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m', 'a_variable_open_meteo_added_later'],
    });

    await openmeteoGetEnsembleTool.handler(input, ctx);

    const callArgs = mockGetEnsemble.mock.calls[0]?.[2] as { hourly?: string[] };
    expect(callArgs?.hourly).toEqual(['temperature_2m', 'a_variable_open_meteo_added_later']);
  });

  it('notices a variable the selected model does not carry, naming it once per variable', async () => {
    // temperature_2m_max under hourly is real data on ecmwf_ifs025 and an all-null
    // column with unit "undefined" on gfs025 — verified live. The notice strips the
    // _memberNN suffix so a wide fan-out names the variable once.
    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: {
        time: 'iso8601',
        temperature_2m_max: 'undefined',
        temperature_2m_max_member01: 'undefined',
        temperature_2m_max_member02: 'undefined',
      },
      hourly: {
        time: ['2026-06-03T00:00', '2026-06-03T01:00'],
        temperature_2m_max_member01: [null, null],
        temperature_2m_max_member02: [null, null],
      },
    });
    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m_max'],
      models: 'gfs025',
    });

    await openmeteoGetEnsembleTool.handler(input, ctx);

    const notice = getEnrichment(ctx).notice;
    expect(notice).toContain('temperature_2m_max returned no data on any member');
    expect(notice).toContain('gfs025');
    expect(notice).not.toContain('member01');
  });

  it('stays quiet when every requested column carries a real unit', async () => {
    mockGetEnsemble.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m'],
      models: 'ecmwf_ifs025',
    });

    await openmeteoGetEnsembleTool.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  // --- timezone (#38) --------------------------------------------------------

  it('rejects a blank timezone before the network call (#38)', async () => {
    // openMeteoUrl omits an empty value, so a blank timezone used to fall through to
    // upstream's GMT default rather than the documented "auto".
    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m'],
      models: 'ecmwf_ifs025',
      timezone: '',
    });
    await expect(openmeteoGetEnsembleTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('timezone was blank'),
      data: {
        reason: 'invalid_timezone',
        recovery: { hint: expect.stringContaining('IANA') },
      },
    });
    expect(mockGetEnsemble).not.toHaveBeenCalled();
  });

  it('reclassifies the upstream Invalid timezone envelope away from invalid_variable (#38)', async () => {
    // Live upstream shape for an unknown zone: HTTP 400, {"reason":"Invalid timezone","error":true}.
    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason: 'Invalid timezone',
    });
    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m'],
      models: 'ecmwf_ifs025',
      timezone: 'Mars/Olympus',
    });
    await expect(openmeteoGetEnsembleTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('Open-Meteo rejected the requested timezone'),
      data: {
        reason: 'invalid_timezone',
        recovery: { hint: expect.stringContaining('auto') },
      },
    });
  });

  it('still defaults an omitted timezone to auto (#38)', async () => {
    mockGetEnsemble.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m'],
      models: 'ecmwf_ifs025',
    });
    await openmeteoGetEnsembleTool.handler(input, ctx);
    expect(mockGetEnsemble).toHaveBeenCalledWith(
      47.6,
      -122.3,
      expect.objectContaining({ timezone: 'auto' }),
      ctx,
    );
  });

  it('passes a valid IANA zone through unchanged (#38)', async () => {
    mockGetEnsemble.mockResolvedValue(MOCK_RESPONSE);
    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m'],
      models: 'ecmwf_ifs025',
      timezone: 'America/Los_Angeles',
    });
    await openmeteoGetEnsembleTool.handler(input, ctx);
    expect(mockGetEnsemble).toHaveBeenCalledWith(
      47.6,
      -122.3,
      expect.objectContaining({ timezone: 'America/Los_Angeles' }),
      ctx,
    );
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

  it('classifies the upstream too-much-data rejection as request_too_large (#50)', async () => {
    // A member fan-out wide enough to trip the volume limit: the names and the model
    // are valid, so the unknown-name framing pointed the caller at spelling instead.
    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      error: true,
      reason:
        'Your API call requests too much data. Please reduce the number of variables, locations and/or weather models.',
    });
    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m', 'precipitation', 'wind_speed_10m'],
      models: 'ecmwf_ifs025_ensemble',
      forecast_days: 16,
      past_days: 92,
    });

    const error = await Promise.resolve(openmeteoGetEnsembleTool.handler(input, ctx)).catch(
      (e: Error) => e,
    );

    if (!(error instanceof Error)) throw new Error('Expected the ensemble handler to reject');
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'request_too_large',
        recovery: { hint: expect.stringContaining('Narrow the request') },
      },
    });
    expect(error.message).toContain('too much data at once');
    expect(error.message).toContain('a models value with fewer members');
    expect(error.message).not.toMatch(/exact Open-Meteo API name/);
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
    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
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

    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
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

    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
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

  it('stages on its own budget decision rather than re-asking spillover (#41)', async () => {
    // spillover() measures rows by JSON length alone, where this server's ceiling also
    // charges the row separators and the wider markdown rendering. Handing it the same
    // budget would let it decline a set the ceiling already rejected and return the
    // whole thing inline under truncated: false — the overshoot the ceiling exists to
    // prevent. It is told to stage instead, and truncated follows the decision made here.
    const time = hourlyTimes(600, '2026-06-01T00:00');
    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: memberBlock(time, () => 15.0),
    });
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount: time.length, tableName: 'spilled_ens02' },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-ens-2' }) };

    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m'],
      forecast_days: 16,
    });

    const result = await openmeteoGetEnsembleTool.handler(input, ctx);

    const [opts] = mockSpillover.mock.calls[0] as [{ previewChars: number }];
    expect(opts.previewChars).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBe('canvas-ens-2');
    expect(result.table_name).toBe('spilled_ens02');
    expect(result.record_count).toBe(time.length);
  });

  it('returns inline without touching a canvas when the payload fits', async () => {
    const time = hourlyTimes(500, '2026-06-01T00:00');
    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: { time, temperature_2m_member01: time.map(() => 15.0) },
    });

    const acquire = vi.fn();
    mockCanvasInstance = { acquire };

    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
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

    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
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

    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
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
    expect(firstText(blocks)).toContain('Ensemble');
    expect(firstText(blocks)).toContain('ecmwf_ifs025');
    expect(firstText(blocks)).toContain('51');
    expect(firstText(blocks)).toContain('Open-Meteo.com');
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

    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
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

    const text = firstText(openmeteoGetEnsembleTool.format!(result));
    // #13: heading references the staged total (624), not the preview length.
    expect(text).toContain(`of ${total} total`);
    // #14: discloses that omitted preview rows may be null past-day rows.
    expect(text).toContain('past_days');
    // Shown preview rows carry real values, not nulls.
    expect(text).not.toContain('temperature_2m_member01: null');
  });

  it.each([
    ['canvas', true],
    ['canvas-less', false],
  ])(
    'holds a two-cadence preview inside one budget on the %s branch (#35)',
    async (_label, canvasEnabled) => {
      /*
       * Both branches used to call the single-collection boundedPreview once per
       * cadence, each measured against the whole INLINE_CHARS, so a two-cadence
       * response carried roughly twice the ceiling every other spill-capable tool
       * caps at — on the widest payload the server serves, since a member fan-out
       * suffixes every variable per member.
       */
      const hourlyTime = hourlyTimes(2592);
      const dailyTime = Array.from(
        { length: 108 },
        (_, i) =>
          `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      );
      mockGetEnsemble.mockResolvedValue({
        ...MOCK_RESPONSE,
        hourly: memberBlock(hourlyTime, (row, m) => 10 + ((row + m) % 20) + 0.5),
        daily_units: { time: 'iso8601', temperature_2m_max_member01: '°C' },
        daily: memberBlock(dailyTime, (row, m) => 20 + ((row + m) % 8) + 0.5, 'temperature_2m_max'),
      });
      if (canvasEnabled) {
        mockSpillover.mockResolvedValue({
          spilled: true,
          handle: {
            rowCount: hourlyTime.length + dailyTime.length,
            tableName: 'spilled_ens_budget',
          },
          previewRows: hourlyTime
            .slice(0, 50)
            .map((t) => ({ time: t, temperature_2m_member01: 1 })),
        });
        mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-budget' }) };
      } else {
        mockCanvasInstance = undefined;
      }

      const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
      const input = openmeteoGetEnsembleTool.input.parse({
        latitude: 47.6,
        longitude: -122.3,
        hourly_variables: ['temperature_2m'],
        daily_variables: ['temperature_2m_max'],
        models: 'ecmwf_ifs025_ensemble',
        forecast_days: 16,
        past_days: 92,
      });
      const result = await openmeteoGetEnsembleTool.handler(input, ctx);

      expect(result.truncated).toBe(true);
      // Neither cadence is starved — each keeps rows even at the widest column count.
      expect(result.hourly?.length ?? 0).toBeGreaterThan(0);
      expect(result.daily?.length ?? 0).toBeGreaterThan(0);
      // …and the pair shares one budget rather than claiming one each.
      const hourlyChars = JSON.stringify(result.hourly ?? []).length;
      const dailyChars = JSON.stringify(result.daily ?? []).length;
      expect(hourlyChars + dailyChars).toBeLessThanOrEqual(rowBudgetFor(result));
      // The old shape let either cadence alone approach the whole budget.
      expect(hourlyChars).toBeLessThan(INLINE_CHARS);
      expect(dailyChars).toBeLessThan(INLINE_CHARS);
      expect(result.record_count).toBe(hourlyTime.length + dailyTime.length);
    },
  );

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
    expect(firstText(blocks)).toContain('default blend');
    expect(firstText(blocks)).toContain('**Members:** 30');
  });

  it('renders every hourly row (non-truncated) with no cap or "…and N more" (format parity)', () => {
    // 30 rows is above the former 24-row render cap.
    const hourly = Array.from({ length: 30 }, (_, i) => ({
      time: `2026-06-03T00:00+${i}`,
      temperature_2m_member01: 1000 + i,
    }));
    const text = firstText(
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
      }),
    );
    expect(text).toContain('### Hourly ensemble (30 records)');
    expect(text).toContain('temperature_2m_member01: 1000');
    expect(text).toContain('temperature_2m_member01: 1029'); // last row — not sliced at 24
    expect(text).not.toMatch(/and \d+ more/);
  });
  it('bounds the preview and sets truncated=true when the payload is oversized and canvas is disabled', async () => {
    // #28: the budget check used to act only inside the `if (canvas)` branch, so a
    // default deployment (CANVAS_PROVIDER_TYPE=none) fell through to an unbounded
    // inline return carrying truncated: false — the field a client reads to decide
    // whether anything is missing.
    const time = hourlyTimes(384);
    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: memberBlock(time, (row, member) => 12 + member / 10 + (row % 7)),
    });
    mockCanvasInstance = undefined; // CANVAS_PROVIDER_TYPE=none

    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m'],
      models: 'gfs025',
      forecast_days: 16,
    });
    const result = await openmeteoGetEnsembleTool.handler(input, ctx);

    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBeUndefined();
    expect(result.table_name).toBeUndefined();
    expect(mockSpillover).not.toHaveBeenCalled();
    // Bounded by the same budget the canvas path measures against.
    expect(result.hourly?.length ?? 0).toBeLessThan(time.length);
    expect(JSON.stringify(result.hourly ?? []).length).toBeLessThanOrEqual(rowBudgetFor(result));
    // record_count stays the full upstream total, not the preview length.
    expect(result.record_count).toBe(time.length);
  });

  it('skips the leading all-null past_days run in the canvas-less preview', async () => {
    // Without a canvas the preview is everything the caller gets, so spending it on
    // the placeholder rows the models do not hindcast would return no data at all.
    const time = hourlyTimes(600);
    const firstUseful = 240;
    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly: memberBlock(time, (row, member) =>
        row < firstUseful ? null : 12 + member / 10 + (row % 7),
      ),
    });
    mockCanvasInstance = undefined;

    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const input = openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m'],
      models: 'gfs025',
      forecast_days: 16,
      past_days: 10,
    });
    const result = await openmeteoGetEnsembleTool.handler(input, ctx);

    expect(result.truncated).toBe(true);
    expect(result.hourly?.[0]?.time).toBe(time[firstUseful]);
    expect(result.hourly?.[0]?.temperature_2m_member01).not.toBeNull();
    // The skipped rows still count toward the upstream total.
    expect(result.record_count).toBe(time.length);
  });

  it('names the disabled canvas and the narrowing levers in the truncated no-canvas format()', () => {
    const text = firstText(
      openmeteoGetEnsembleTool.format!({
        latitude: 47.6,
        longitude: -122.3,
        elevation: 59,
        timezone: 'America/Los_Angeles',
        model: 'gfs025',
        member_count: 31,
        record_count: 384,
        truncated: true,
        canvas_id: undefined,
        table_name: undefined,
        hourly: [{ time: '2026-06-18T00:00', temperature_2m_member01: 12.1 }],
        hourly_units: { temperature_2m_member01: '°C' },
      }),
    );
    expect(text).toContain('CANVAS_PROVIDER_TYPE=none');
    expect(text).toContain('CANVAS_PROVIDER_TYPE=duckdb');
    // models takes one model, so the lever is a lighter model — not a shorter list.
    expect(text).toContain('a models value with fewer members');
    // Heading reports the upstream total and does not claim a canvas holds it.
    expect(text).toContain('1 shown of 384 total rows)');
    expect(text).not.toContain('total rows on canvas');
  });

  // --- inline size ceiling (#41), canvas pointer (#44), coverage gaps (#40) ---

  /** `count` consecutive ISO dates from `from`. */
  const dailyDates = (count: number, from = '2026-09-09'): string[] =>
    Array.from({ length: count }, (_, i) => {
      const d = new Date(`${from}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    });

  /** A 31-member block across several variables — the gefs025 fan-out. */
  const memberColumns = (
    time: string[],
    variables: readonly string[],
    valueAt: (row: number, member: number) => number | null,
  ): Record<string, (number | null)[] | string[]> => {
    const block: Record<string, (number | null)[] | string[]> = { time };
    for (const variable of variables) {
      for (let m = 1; m <= 31; m++) {
        block[`${variable}_member${String(m).padStart(2, '0')}`] = time.map((_, row) =>
          valueAt(row, m),
        );
      }
    }
    return block;
  };

  /** The matching units map — one entry per member column, plus `time`. */
  const memberUnits = (variables: readonly string[], unit: string): Record<string, string> => {
    const units: Record<string, string> = { time: 'iso8601' };
    for (const variable of variables) {
      for (let m = 1; m <= 31; m++) {
        units[`${variable}_member${String(m).padStart(2, '0')}`] = unit;
      }
    }
    return units;
  };

  const CASE_A_HOURLY = ['temperature_2m', 'precipitation', 'wind_speed_10m'];
  const CASE_A_DAILY = ['temperature_2m_max', 'precipitation_sum'];

  /**
   * #41 Case A, as reported: ncep_gefs025 over 16 days with 3 hourly and 2 daily
   * variables. 94 hourly + 63 daily unit entries — the repeated member-suffixed maps
   * that sit outside a rows-only budget and carried the whole overshoot.
   */
  const caseAResponse = () => ({
    ...MOCK_RESPONSE,
    hourly_units: memberUnits(CASE_A_HOURLY, '°C'),
    daily_units: memberUnits(CASE_A_DAILY, '°C'),
    hourly: memberColumns(hourlyTimes(384), CASE_A_HOURLY, (row, m) => 12 + m / 10 + (row % 7)),
    daily: memberColumns(dailyDates(16), CASE_A_DAILY, (row, m) => 20 + m / 10 + (row % 5)),
  });

  const caseAInput = () =>
    openmeteoGetEnsembleTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      hourly_variables: CASE_A_HOURLY,
      daily_variables: CASE_A_DAILY,
      models: 'ncep_gefs025',
      forecast_days: 16,
      timezone: 'America/Los_Angeles',
    });

  const stageOnCanvas = (tableName: string, canvasId: string, rowCount: number) => {
    mockSpillover.mockResolvedValue({
      spilled: true,
      handle: { rowCount, tableName },
      previewRows: [],
    });
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId }) };
  };

  it('keeps both inline surfaces inside the ceiling when a wide spill stages (#41)', async () => {
    // The row arrays alone fit the old budget; the unit maps, the scalar fields and
    // format()'s own header text were added afterwards and pushed both surfaces past it.
    mockGetEnsemble.mockResolvedValue(caseAResponse());
    stageOnCanvas('spilled_abc123', 'VST_9urb2C', 400);

    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const result = await openmeteoGetEnsembleTool.handler(caseAInput(), ctx);

    expect(result.truncated).toBe(true);
    expect(structuredSize(result, ctx)).toBeLessThanOrEqual(INLINE_CHARS);
    expect(firstText(openmeteoGetEnsembleTool.format!(result)).length).toBeLessThanOrEqual(
      INLINE_CHARS,
    );
  });

  it('keeps both inline surfaces inside the ceiling with canvas disabled (#41)', async () => {
    mockGetEnsemble.mockResolvedValue(caseAResponse());
    mockCanvasInstance = undefined; // CANVAS_PROVIDER_TYPE=none

    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const result = await openmeteoGetEnsembleTool.handler(caseAInput(), ctx);

    expect(result.truncated).toBe(true);
    expect(structuredSize(result, ctx)).toBeLessThanOrEqual(INLINE_CHARS);
    expect(firstText(openmeteoGetEnsembleTool.format!(result)).length).toBeLessThanOrEqual(
      INLINE_CHARS,
    );
  });

  it('names openmeteo_dataframe_describe before openmeteo_dataframe_query on both surfaces (#44)', async () => {
    mockGetEnsemble.mockResolvedValue(caseAResponse());
    stageOnCanvas('spilled_abc123', 'VST_9urb2C', 400);

    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const result = await openmeteoGetEnsembleTool.handler(caseAInput(), ctx);

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('spilled_abc123');
    expect(notice.indexOf('openmeteo_dataframe_describe')).toBeGreaterThanOrEqual(0);
    expect(notice.indexOf('openmeteo_dataframe_describe')).toBeLessThan(
      notice.indexOf('openmeteo_dataframe_query'),
    );

    const text = firstText(openmeteoGetEnsembleTool.format!(result));
    expect(text.indexOf('openmeteo_dataframe_describe')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('openmeteo_dataframe_describe')).toBeLessThan(
      text.indexOf('openmeteo_dataframe_query'),
    );
  });

  it('keeps the unserved-variable warning when the canvas pointer fires in the same call (#44)', async () => {
    // Both notice sources fire together: an unserved name and a spill. ctx.enrich.notice
    // is last-write-wins on one key, so the second must not silently drop the first.
    const response = caseAResponse();
    mockGetEnsemble.mockResolvedValue({
      ...response,
      hourly_units: { ...response.hourly_units, snowfall_height_member01: 'undefined' },
      hourly: {
        ...response.hourly,
        snowfall_height_member01: (response.hourly.time as string[]).map(() => null),
      },
    });
    stageOnCanvas('spilled_abc123', 'VST_9urb2C', 400);

    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    await openmeteoGetEnsembleTool.handler(
      openmeteoGetEnsembleTool.input.parse({
        latitude: 47.6062,
        longitude: -122.3321,
        hourly_variables: [...CASE_A_HOURLY, 'snowfall_height'],
        daily_variables: CASE_A_DAILY,
        models: 'ncep_gefs025',
        forecast_days: 16,
      }),
      ctx,
    );

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('snowfall_height returned no data on any member');
    expect(notice).toContain('openmeteo_dataframe_describe');
  });

  it('reports the trailing-null run past the model horizon on both surfaces (#40)', async () => {
    // Live ncep_gefs025 on 2026-09-09: daily returns 16 rows of which the last 6 are
    // null and hourly returns 384 of which the last 136 are, matching the model's
    // ~10-day horizon. Units stay real (°C), so the unserved-name check never fires.
    const hourlyTime = hourlyTimes(384);
    const dailyTime = dailyDates(16);
    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: memberUnits(['temperature_2m'], '°C'),
      daily_units: memberUnits(['temperature_2m_max'], '°C'),
      hourly: memberColumns(hourlyTime, ['temperature_2m'], (row, m) =>
        row < 248 ? 12 + m / 10 : null,
      ),
      daily: memberColumns(dailyTime, ['temperature_2m_max'], (row, m) =>
        row < 10 ? 20 + m / 10 : null,
      ),
    });
    mockCanvasInstance = undefined;

    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const result = await openmeteoGetEnsembleTool.handler(
      openmeteoGetEnsembleTool.input.parse({
        latitude: 47.6062,
        longitude: -122.3321,
        hourly_variables: ['temperature_2m'],
        daily_variables: ['temperature_2m_max'],
        models: 'ncep_gefs025',
        forecast_days: 16,
      }),
      ctx,
    );

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('Partial hourly coverage for temperature_2m');
    expect(notice).toContain(`data runs ${hourlyTime[0]} to ${hourlyTime[247]}`);
    expect(notice).toContain('136 of 384 rows are null');
    expect(notice).toContain('Partial daily coverage for temperature_2m_max');
    expect(notice).toContain('6 of 16 rows are null');
    // record_count still reports rows, not non-null values.
    expect(result.record_count).toBe(400);
  });

  // --- no-canvas disclosure (#51), unrequested cadence (#53) -----------------

  it.each([
    ['canvas enabled', true],
    ['canvas disabled', false],
  ])('omits daily on a truncated hourly-only request — %s (#53)', async (_label, canvasEnabled) => {
    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: memberUnits(CASE_A_HOURLY, '°C'),
      hourly: memberColumns(hourlyTimes(384), CASE_A_HOURLY, (row, m) => 12 + m / 10 + (row % 7)),
      daily_units: undefined,
      daily: undefined,
    });
    if (canvasEnabled) stageOnCanvas('spilled_ens53', 'canvas-ens-53', 384);
    else mockCanvasInstance = undefined;

    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const result = await openmeteoGetEnsembleTool.handler(
      openmeteoGetEnsembleTool.input.parse({
        latitude: 47.6062,
        longitude: -122.3321,
        hourly_variables: CASE_A_HOURLY,
        models: 'ncep_gefs025',
        forecast_days: 16,
      }),
      ctx,
    );

    expect(result.truncated).toBe(true);
    expect(result.daily).toBeUndefined();
    expect(result.hourly?.length ?? 0).toBeGreaterThan(0);
    expect(firstText(openmeteoGetEnsembleTool.format!(result))).not.toContain(
      '### Daily ensemble summary',
    );
  });

  it.each([
    ['canvas enabled', true],
    ['canvas disabled', false],
  ])('omits hourly on a truncated daily-only request — %s (#53)', async (_label, canvasEnabled) => {
    const dailyTime = dailyDates(108);
    mockGetEnsemble.mockResolvedValue({
      ...MOCK_RESPONSE,
      hourly_units: undefined,
      hourly: undefined,
      daily_units: memberUnits(CASE_A_DAILY, '°C'),
      daily: memberColumns(dailyTime, CASE_A_DAILY, (row, m) => 20 + m / 10 + (row % 5)),
    });
    if (canvasEnabled) stageOnCanvas('spilled_ens53d', 'canvas-ens-53d', dailyTime.length);
    else mockCanvasInstance = undefined;

    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const result = await openmeteoGetEnsembleTool.handler(
      openmeteoGetEnsembleTool.input.parse({
        latitude: 47.6062,
        longitude: -122.3321,
        daily_variables: CASE_A_DAILY,
        models: 'ncep_gefs025',
        forecast_days: 16,
        past_days: 92,
      }),
      ctx,
    );

    expect(result.truncated).toBe(true);
    expect(result.hourly).toBeUndefined();
    expect(result.daily?.length ?? 0).toBeGreaterThan(0);
    expect(firstText(openmeteoGetEnsembleTool.format!(result))).not.toContain(
      '### Hourly ensemble',
    );
  });

  it('composes the no-canvas disclosure into the notice, not only into content[] (#51)', async () => {
    mockGetEnsemble.mockResolvedValue(caseAResponse());
    mockCanvasInstance = undefined; // CANVAS_PROVIDER_TYPE=none

    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    const result = await openmeteoGetEnsembleTool.handler(caseAInput(), ctx);

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('There is no canvas_id because DataCanvas is disabled');
    expect(notice).toContain('CANVAS_PROVIDER_TYPE=duckdb');
    expect(notice).toContain('a models value with fewer members');
    expect(firstText(openmeteoGetEnsembleTool.format!(result))).toContain(
      'CANVAS_PROVIDER_TYPE=none',
    );
  });

  it('says nothing about a disabled canvas when the spill actually staged (#51)', async () => {
    mockGetEnsemble.mockResolvedValue(caseAResponse());
    stageOnCanvas('spilled_ens51', 'canvas-ens-51', 400);

    const ctx = createMockContext({ errors: openmeteoGetEnsembleTool.errors });
    await openmeteoGetEnsembleTool.handler(caseAInput(), ctx);

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('spilled_ens51');
    expect(notice).not.toContain('DataCanvas is disabled');
  });
});
