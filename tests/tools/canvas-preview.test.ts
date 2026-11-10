/**
 * @fileoverview Per-tool wiring for the inline preview of the seven spill-capable tools:
 * which row budget each branch hands the preview selector. Once the full result is staged
 * on a canvas, the preview is a small sample beside the canvas pointer; with no canvas the
 * preview is all the caller gets, so it keeps the whole row budget; and a result that fits
 * returns whole. The budget itself is tabled in tests/tools/spill-utils.test.ts.
 *
 * Fixture rows are constant-width — every timestamp and value the same length — so each
 * row costs the same and the expected row count is plain arithmetic over that cost.
 * @module tests/tools/canvas-preview.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as definitions from '@/mcp-server/tools/definitions/index.js';
import { CANVAS_PREVIEW_CHARS, INLINE_CHARS } from '@/mcp-server/tools/spill-utils.js';
import type { UnitsMap } from '@/services/open-meteo/types.js';
import { firstText } from '../helpers/content.js';
import { rowBudgetFor } from '../helpers/inline-surface.js';

const service = {
  getForecast: vi.fn(),
  getHistorical: vi.fn(),
  getMarine: vi.fn(),
  getAirQuality: vi.fn(),
  getEnsemble: vi.fn(),
  getFlood: vi.fn(),
  getClimate: vi.fn(),
};
const mockSpillover = vi.fn();
let canvas: { acquire: ReturnType<typeof vi.fn> } | undefined;

vi.mock('@/services/open-meteo/open-meteo-service.js', () => ({
  getOpenMeteoService: () => service,
}));

vi.mock('@cyanheads/mcp-ts-core/canvas', async (importActual) => ({
  ...(await importActual<typeof import('@cyanheads/mcp-ts-core/canvas')>()),
  spillover: (...args: unknown[]) => mockSpillover(...args),
}));

vi.mock('@/services/canvas-accessor.js', () => ({ getCanvas: () => canvas }));

type Row = Record<string, unknown>;

/** What one row costs against the inline budget: its JSON, plus a character per field and the separator. */
const rowCost = (row: Row): number => JSON.stringify(row).length + Object.keys(row).length + 1;

const cost = (rows: readonly Row[] | undefined): number =>
  (rows ?? []).reduce((chars, row) => chars + rowCost(row), 0);

/** `count` hourly timestamps, every one 16 characters wide. */
const hourlyTimes = (count: number): string[] =>
  Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString().slice(0, 16),
  );

/** `count` daily dates, every one 10 characters wide. */
const dailyDates = (count: number): string[] =>
  Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
  );

/** A columnar block whose every value is the same four-character number. */
const block = (time: string[], variables: readonly string[]) => ({
  time,
  ...Object.fromEntries(variables.map((name) => [name, time.map(() => 12.5)])),
});

const units = (variables: readonly string[]): UnitsMap => ({
  time: 'iso8601',
  ...Object.fromEntries(variables.map((name) => [name, 'u'])),
});

/**
 * Rows per cadence for a result well over the inline ceiling, for one well under it, and
 * for one that fits the row budget while holding several canvas preview budgets of rows.
 */
const OVER = { hourly: 3000, daily: 2000 } as const;
const UNDER = { hourly: 24, daily: 2 } as const;
const MID = { hourly: 400, daily: 400 } as const;

type ServiceMethod = keyof typeof service;
type AnyDefinition = Parameters<typeof runToolContract>[0];

interface ToolCase {
  /** Daily variables the call requests, or undefined for an hourly-only tool. */
  daily?: readonly string[] | undefined;
  /** Hourly variables the call requests, or undefined for a daily-only tool. */
  hourly?: readonly string[] | undefined;
  input: Record<string, unknown>;
  method: ServiceMethod;
  tool: AnyDefinition;
}

const point = { latitude: 47.6, longitude: -122.3 };

const TOOLS: readonly ToolCase[] = [
  {
    tool: definitions.openmeteoGetForecastTool,
    method: 'getForecast',
    input: { ...point, past_days: 92 },
    hourly: ['temperature_2m'],
    daily: ['temperature_2m_max'],
  },
  {
    tool: definitions.openmeteoGetHistoricalTool,
    method: 'getHistorical',
    input: { ...point, start_date: '2020-01-01', end_date: '2025-06-23' },
    hourly: ['temperature_2m'],
    daily: ['temperature_2m_max'],
  },
  {
    tool: definitions.openmeteoGetMarineTool,
    method: 'getMarine',
    input: { latitude: 47.8, longitude: -122.5, past_days: 92 },
    hourly: ['wave_height'],
    daily: ['wave_height_max'],
  },
  {
    tool: definitions.openmeteoGetEnsembleTool,
    method: 'getEnsemble',
    input: { ...point, forecast_days: 35, past_days: 92 },
    hourly: ['temperature_2m'],
    daily: ['temperature_2m_max'],
  },
  {
    tool: definitions.openmeteoGetAirQualityTool,
    method: 'getAirQuality',
    input: { ...point, past_days: 92 },
    hourly: ['pm2_5'],
  },
  {
    tool: definitions.openmeteoGetFloodTool,
    method: 'getFlood',
    input: { ...point, start_date: '2020-01-01', end_date: '2025-06-23' },
    daily: ['river_discharge'],
  },
  {
    tool: definitions.openmeteoGetClimateTool,
    method: 'getClimate',
    input: { ...point, start_date: '2020-01-01', end_date: '2025-06-23' },
    daily: ['temperature_2m_max'],
  },
];

const TWO_CADENCE = TOOLS.filter((c) => c.hourly && c.daily);
const ONE_CADENCE = TOOLS.filter((c) => !(c.hourly && c.daily));

/** The upstream envelope for `toolCase` carrying `rows` per requested cadence. */
function envelope(toolCase: ToolCase, rows: { daily: number; hourly: number }) {
  return {
    latitude: 47.6,
    longitude: -122.3,
    elevation: 59,
    utc_offset_seconds: 0,
    timezone: 'GMT',
    ...(toolCase.hourly && {
      hourly_units: units(toolCase.hourly),
      hourly: block(hourlyTimes(rows.hourly), toolCase.hourly),
    }),
    ...(toolCase.daily && {
      daily_units: units(toolCase.daily),
      daily: block(dailyDates(rows.daily), toolCase.daily),
    }),
  };
}

interface Payload {
  canvas_id?: string;
  daily?: Row[];
  daily_units?: UnitsMap;
  hourly?: Row[];
  hourly_units?: UnitsMap;
  notice?: string;
  record_count: number;
  table_name?: string;
  truncated: boolean;
}

/** Calls the tool for `toolCase` and returns both surfaces. */
async function run(
  toolCase: ToolCase,
  rows: { daily: number; hourly: number },
  requested: { daily: boolean; hourly: boolean } = { hourly: true, daily: true },
) {
  service[toolCase.method].mockResolvedValue(envelope(toolCase, rows));
  const input = {
    ...toolCase.input,
    ...(requested.hourly && toolCase.hourly && { hourly_variables: [...toolCase.hourly] }),
    ...(requested.daily && toolCase.daily && { daily_variables: [...toolCase.daily] }),
  };
  const result = await runToolContract(toolCase.tool, input as never);
  expect(result.isError).toBeFalsy();
  return {
    payload: result.structuredContent as unknown as Payload,
    text: firstText(result.content),
  };
}

/** Records the call staged: every row of every requested cadence. */
const stagedTotal = (toolCase: ToolCase, rows: { daily: number; hourly: number }) =>
  (toolCase.hourly ? rows.hourly : 0) + (toolCase.daily ? rows.daily : 0);

/** Lines `format()` rendered as records — each opens with its bold timestamp. */
const renderedRecords = (text: string): number =>
  text.split('\n').filter((line) => /^\*\*\d{4}-\d{2}-\d{2}/.test(line)).length;

describe('inline preview budget per branch (#95)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canvas = undefined;
    mockSpillover.mockImplementation(({ source }: { source: readonly Row[] }) =>
      Promise.resolve({
        spilled: true,
        handle: { rowCount: source.length, tableName: 'spilled_preview' },
        previewRows: [],
        truncated: false,
      }),
    );
  });

  const enableCanvas = () => {
    canvas = { acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-preview' }) };
  };

  describe('staged on a canvas', () => {
    it.each(TWO_CADENCE)(
      '$tool.name previews both cadences inside the canvas preview budget',
      async (toolCase) => {
        enableCanvas();
        const { payload, text } = await run(toolCase, OVER);

        expect(payload.truncated).toBe(true);
        expect(payload.canvas_id).toBe('canvas-preview');
        expect(payload.table_name).toBe('spilled_preview');
        expect(payload.record_count).toBe(stagedTotal(toolCase, OVER));
        expect(payload.hourly_units).toEqual(units(toolCase.hourly ?? []));
        expect(payload.daily_units).toEqual(units(toolCase.daily ?? []));
        expect(payload.notice).toContain('canvas canvas-preview');

        expect(payload.hourly!.length).toBeGreaterThan(0);
        expect(payload.daily!.length).toBeGreaterThan(0);
        expect(cost(payload.hourly) + cost(payload.daily)).toBeLessThanOrEqual(
          CANVAS_PREVIEW_CHARS,
        );
        expect(payload.hourly![0]).toMatchObject({ time: '2026-01-01T00:00' });
        expect(payload.daily![0]).toMatchObject({ time: '2026-01-01' });

        // content[] renders exactly the rows structuredContent carries, under the staged total.
        expect(renderedRecords(text)).toBe(payload.hourly!.length + payload.daily!.length);
        expect(text).toContain(`of ${stagedTotal(toolCase, OVER)} total rows on canvas`);
      },
    );

    it.each(ONE_CADENCE)(
      '$tool.name previews as many rows as the canvas preview budget holds',
      async (toolCase) => {
        enableCanvas();
        const { payload, text } = await run(toolCase, OVER);
        const rows = (toolCase.hourly ? payload.hourly : payload.daily) ?? [];
        const sample = rows[0]!;

        expect(payload.truncated).toBe(true);
        expect(payload.canvas_id).toBe('canvas-preview');
        expect(payload.record_count).toBe(stagedTotal(toolCase, OVER));
        expect(rows).toHaveLength(Math.floor(CANVAS_PREVIEW_CHARS / rowCost(sample)));
        expect(renderedRecords(text)).toBe(rows.length);
      },
    );

    it('leaves an unrequested cadence absent when a two-cadence tool spills one', async () => {
      enableCanvas();
      const historical = TWO_CADENCE.find((c) => c.method === 'getHistorical')!;
      service.getHistorical.mockResolvedValue({
        ...envelope(historical, OVER),
        hourly_units: undefined,
        hourly: undefined,
      });
      const result = await runToolContract(historical.tool, {
        ...historical.input,
        daily_variables: [...(historical.daily ?? [])],
      } as never);
      const payload = result.structuredContent as unknown as Payload;

      expect(payload.truncated).toBe(true);
      expect(payload.hourly).toBeUndefined();
      expect(payload.daily).toHaveLength(
        Math.floor(CANVAS_PREVIEW_CHARS / rowCost(payload.daily![0]!)),
      );
    });

    it.each(TOOLS)("$tool.name stages under the caller's cancellation", async (toolCase) => {
      enableCanvas();
      service[toolCase.method].mockResolvedValue(envelope(toolCase, OVER));
      const controller = new AbortController();
      const result = await runToolContract(
        toolCase.tool,
        {
          ...toolCase.input,
          ...(toolCase.hourly && { hourly_variables: [...toolCase.hourly] }),
          ...(toolCase.daily && { daily_variables: [...toolCase.daily] }),
        } as never,
        { context: { signal: controller.signal } },
      );
      expect(result.isError).toBeFalsy();
      const staged = mockSpillover.mock.calls[0]?.[0] as { signal?: AbortSignal } | undefined;

      expect(staged?.signal?.aborted).toBe(false);
      controller.abort();
      expect(staged?.signal?.aborted).toBe(true);
    });
  });

  describe('with no canvas (CANVAS_PROVIDER_TYPE=none)', () => {
    it.each(TWO_CADENCE)(
      '$tool.name previews both cadences across the whole row budget',
      async (toolCase) => {
        const { payload } = await run(toolCase, OVER);
        const budget = rowBudgetFor(payload);

        expect(payload.truncated).toBe(true);
        expect(payload.canvas_id).toBeUndefined();
        expect(payload.record_count).toBe(stagedTotal(toolCase, OVER));
        expect(payload.hourly!.length).toBeGreaterThan(0);
        expect(payload.daily!.length).toBeGreaterThan(0);
        // Within one hourly row of the whole budget — the preview is all this caller gets.
        const spent = cost(payload.hourly) + cost(payload.daily);
        expect(spent).toBeLessThanOrEqual(budget);
        expect(spent).toBeGreaterThan(budget - rowCost(payload.hourly![0]!));
      },
    );

    it.each(ONE_CADENCE)(
      '$tool.name previews as many rows as the whole row budget holds',
      async (toolCase) => {
        const { payload } = await run(toolCase, OVER);
        const rows = (toolCase.hourly ? payload.hourly : payload.daily) ?? [];

        expect(payload.truncated).toBe(true);
        expect(payload.canvas_id).toBeUndefined();
        expect(rows).toHaveLength(Math.floor(rowBudgetFor(payload) / rowCost(rows[0]!)));
      },
    );

    it('still returns a 10-day 51-member hourly ensemble as a full-budget preview', async () => {
      /*
       * The regression the canvas-only change must not reach: one variable across a
       * 51-member model (the control column plus 50 member columns), 240 hourly rows.
       * Each row is about 1.5k characters, so the full budget holds dozens of rows and
       * the canvas preview budget only a handful.
       */
      const variables = [
        'precipitation',
        ...Array.from(
          { length: 50 },
          (_, i) => `precipitation_member${String(i + 1).padStart(2, '0')}`,
        ),
      ];
      const ensemble: ToolCase = {
        ...TWO_CADENCE.find((c) => c.method === 'getEnsemble')!,
        input: { ...point, forecast_days: 10 },
        hourly: variables,
        daily: undefined,
      };
      service.getEnsemble.mockResolvedValue(envelope(ensemble, { hourly: 240, daily: 0 }));
      const result = await runToolContract(ensemble.tool, {
        ...ensemble.input,
        hourly_variables: ['precipitation'],
      } as never);
      const payload = result.structuredContent as unknown as Payload;
      const perRow = rowCost(payload.hourly![0]!);

      expect(payload.truncated).toBe(true);
      expect(payload.hourly).toHaveLength(Math.floor(rowBudgetFor(payload) / perRow));
      expect(payload.record_count).toBe(240);
    });
  });

  describe('a result that fits', () => {
    it.each(
      TOOLS.flatMap((toolCase) => [
        { ...toolCase, label: 'a canvas configured', withCanvas: true },
        { ...toolCase, label: 'no canvas', withCanvas: false },
      ]),
    )('$tool.name returns every row with $label', async ({ withCanvas, ...toolCase }) => {
      if (withCanvas) enableCanvas();
      const { payload } = await run(toolCase, UNDER);

      expect(payload.truncated).toBe(false);
      expect(payload.canvas_id).toBeUndefined();
      expect(payload.record_count).toBe(stagedTotal(toolCase, UNDER));
      if (toolCase.hourly) expect(payload.hourly).toHaveLength(UNDER.hourly);
      if (toolCase.daily) expect(payload.daily).toHaveLength(UNDER.daily);
      if (withCanvas) expect(canvas!.acquire).not.toHaveBeenCalled();
      expect(mockSpillover).not.toHaveBeenCalled();
      expect(JSON.stringify(payload).length).toBeLessThan(INLINE_CHARS);
    });

    it.each(
      TOOLS.flatMap((toolCase) => [
        { ...toolCase, label: 'a canvas configured', withCanvas: true },
        { ...toolCase, label: 'no canvas', withCanvas: false },
      ]),
    )(
      '$tool.name returns whole a result larger than the canvas preview budget with $label',
      async ({ withCanvas, ...toolCase }) => {
        if (withCanvas) enableCanvas();
        const { payload } = await run(toolCase, MID);

        expect(payload.truncated).toBe(false);
        expect(payload.canvas_id).toBeUndefined();
        expect(payload.record_count).toBe(stagedTotal(toolCase, MID));
        if (toolCase.hourly) expect(payload.hourly).toHaveLength(MID.hourly);
        if (toolCase.daily) expect(payload.daily).toHaveLength(MID.daily);
        if (withCanvas) expect(canvas!.acquire).not.toHaveBeenCalled();
        expect(mockSpillover).not.toHaveBeenCalled();
        // The rows outweigh the canvas preview budget, so this row tells the two budgets apart.
        expect(cost(payload.hourly) + cost(payload.daily)).toBeGreaterThan(
          2 * CANVAS_PREVIEW_CHARS,
        );
      },
    );
  });
});
