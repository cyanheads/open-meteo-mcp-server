/**
 * @fileoverview Tests for openmeteo_dataframe_query tool.
 * @module tests/tools/dataframe-query.tool.test
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
  type IDataCanvasProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { resetConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoDataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { openmeteoDataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { stageSpill } from '@/mcp-server/tools/spill-utils.js';
import { renderedText } from '../helpers/commonmark.js';
import { firstText } from '../helpers/content.js';
import { cpuMicrosPerCall } from '../helpers/cpu-time.js';
import { gfmTable } from '../helpers/gfm-table.js';
import { type WireError, wireError } from '../helpers/wire-error.js';

// Canvas mock — returns undefined by default; individual tests override
let mockCanvasInstance: unknown;

vi.mock('@/services/canvas-accessor.js', () => ({
  getCanvas: () => mockCanvasInstance,
}));

/** Stands in for every counter the tool creates, so a test can count its increments. */
const clampCounter = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: () => clampCounter,
}));

const MOCK_ROWS = [
  { time: '2020-01-01T00:00', temperature_2m: -2.3 },
  { time: '2020-01-01T01:00', temperature_2m: -2.8 },
];

describe('openmeteoDataframeQueryTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasInstance = undefined;
  });

  it('throws canvas_not_enabled when canvas is not configured', async () => {
    mockCanvasInstance = undefined;
    const ctx = createMockContext({ errors: openmeteoDataframeQueryTool.errors });
    const input = openmeteoDataframeQueryTool.input.parse({
      canvas_id: 'abc1234567',
      sql: 'SELECT * FROM spilled_abc1234567',
    });
    await expect(openmeteoDataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      data: { reason: 'canvas_not_enabled' },
    });
  });

  it('rethrows the framework acquire() NotFound as canvas_not_found with the tool recovery', async () => {
    mockCanvasInstance = {
      acquire: vi.fn().mockRejectedValue(
        notFound('Canvas not found or expired. Omit canvas_id to start a new canvas.', {
          canvasId: 'fakeCanvas',
        }),
      ),
    };
    const input = openmeteoDataframeQueryTool.input.parse({
      canvas_id: 'fakeCanvas',
      sql: 'SELECT 1',
    });
    await expect(wireError(openmeteoDataframeQueryTool, input)).resolves.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.not.stringContaining('Omit canvas_id'),
      data: {
        reason: 'canvas_not_found',
        recovery: {
          hint: expect.stringContaining(
            'openmeteo_get_historical, openmeteo_get_marine, openmeteo_get_air_quality, openmeteo_get_ensemble, openmeteo_get_flood, or openmeteo_get_climate',
          ),
        },
      },
    });
  });

  it('maps the real registry NotFound for a never-minted, well-formed id to canvas_not_found', async () => {
    // The framework's own registry, not a hand-built NotFound: the lookup misses before
    // any provider call, so an empty stub provider carries the rest.
    const provider = { name: 'stub' } as unknown as IDataCanvasProvider;
    mockCanvasInstance = new DataCanvas(
      provider,
      new CanvasRegistry(provider, { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, sweeperIntervalMs: 0 }),
    );
    const input = openmeteoDataframeQueryTool.input.parse({
      canvas_id: 'neverMint1',
      sql: 'SELECT 1',
    });
    await expect(
      wireError(openmeteoDataframeQueryTool, input, { context: { tenantId: 'tenant-query' } }),
    ).resolves.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'Canvas "neverMint1" not found or expired (24 h sliding TTL).',
      data: {
        reason: 'canvas_not_found',
        recovery: { hint: expect.stringContaining('Re-run openmeteo_get_forecast') },
      },
    });
  });

  it('rewraps the framework system_catalog_access error with the declared recovery hint', async () => {
    // Real framework throw shape (sqlGate.assertNoSystemCatalogs): a ValidationError
    // with data.reason but NO recovery of its own — the tool's declared recovery is
    // the only possible source of a hint on this path.
    const mockInstance = {
      canvasId: 'testCanv01',
      query: vi
        .fn()
        .mockRejectedValue(
          validationError(
            'Canvas query references a system catalog: information_schema. System catalogs are not permitted when denySystemCatalogs is enabled.',
            { reason: 'system_catalog_access', catalog: 'information_schema' },
          ),
        ),
    };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };
    const input = openmeteoDataframeQueryTool.input.parse({
      canvas_id: 'testCanv01',
      sql: 'SELECT * FROM information_schema.tables',
    });
    await expect(wireError(openmeteoDataframeQueryTool, input)).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'system_catalog_access',
        recovery: { hint: expect.stringContaining('openmeteo_dataframe_describe') },
      },
    });
  });

  it('rewraps the framework missing_table error to name openmeteo_dataframe_describe, not framework methods', async () => {
    // Real framework throw shape (DuckdbProvider query() prepare-error path): a
    // NotFound whose default recovery names registerTable()/describe(). The tool must
    // replace that with caller-facing guidance and preserve the offending table name.
    const mockInstance = {
      canvasId: 'testCanv01',
      query: vi.fn().mockRejectedValue(
        notFound(
          'Canvas table "spillover_0" does not exist. The table may have expired or been dropped — re-stage it or call describe() to inspect the canvas.',
          {
            reason: 'missing_table',
            tableName: 'spillover_0',
            recovery: {
              hint: 'Re-stage the table via registerTable() or call describe() to see what tables are currently available.',
            },
          },
        ),
      ),
    };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const input = openmeteoDataframeQueryTool.input.parse({
      canvas_id: 'testCanv01',
      sql: 'SELECT COUNT(*) FROM spillover_0',
    });

    const err = await wireError(openmeteoDataframeQueryTool, input);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data?.reason).toBe('missing_table');
    expect(err.message).toContain('spillover_0');
    expect(err.data?.recovery?.hint).toContain('openmeteo_dataframe_describe');
    // The framework leak is gone from both the message and the recovery hint.
    expect(err.data?.recovery?.hint).not.toContain('registerTable');
    expect(err.data?.recovery?.hint).not.toContain('describe()');
    expect(err.message).not.toContain('describe()');
  });

  it('passes non-target query errors (invalid_sql) through unchanged', async () => {
    // A ValidationError with a different reason must not be reclassified — consumers
    // key on code + data.reason, and the binder detail must survive.
    const mockInstance = {
      canvasId: 'testCanv01',
      query: vi.fn().mockRejectedValue(
        validationError(
          'Canvas query failed to prepare: Referenced column "tempxyz" not found in FROM clause!',
          {
            reason: 'invalid_sql',
            statementType: 'UNKNOWN',
            binderMessage: 'Referenced column "tempxyz" not found in FROM clause!',
          },
        ),
      ),
    };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext({ errors: openmeteoDataframeQueryTool.errors });
    const input = openmeteoDataframeQueryTool.input.parse({
      canvas_id: 'testCanv01',
      sql: 'SELECT tempxyz FROM spilled_testCanv01',
    });
    await expect(openmeteoDataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_sql', binderMessage: expect.stringContaining('tempxyz') },
    });
  });

  it('returns rows and row_count from a valid query', async () => {
    const mockInstance = {
      canvasId: 'testCanv01',
      query: vi.fn().mockResolvedValue({ rows: MOCK_ROWS, rowCount: 2 }),
    };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext({ errors: openmeteoDataframeQueryTool.errors });
    const input = openmeteoDataframeQueryTool.input.parse({
      canvas_id: 'testCanv01',
      sql: 'SELECT time, temperature_2m FROM spilled_testCanv01 LIMIT 2',
    });
    const result = await openmeteoDataframeQueryTool.handler(input, ctx);

    expect(result.canvas_id).toBe('testCanv01');
    expect(result.rows).toHaveLength(2);
    expect(result.row_count).toBe(2);
    expect(result.rows[0]).toEqual({ time: '2020-01-01T00:00', temperature_2m: -2.3 });
    expect(mockInstance.query).toHaveBeenCalledWith(
      'SELECT time, temperature_2m FROM spilled_testCanv01 LIMIT 2',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('asks the canvas for a 25-row page by default while row_count reflects the full result', async () => {
    // The canvas returns at most rowLimit rows and flags a cut result; the tool then counts
    // the full result, so row_count stays the true total the agent pages the rest from.
    const fullRows = Array.from({ length: 250 }, (_, i) => ({ i, v: i * 2 }));
    const query = vi.fn((sql: string, options: { rowLimit?: number }) =>
      Promise.resolve(
        sql.startsWith('SELECT COUNT(*)')
          ? { rows: [{ n: 250 }], rowCount: 1, truncated: false }
          : {
              rows: fullRows.slice(0, options.rowLimit),
              rowCount: options.rowLimit,
              truncated: true,
            },
      ),
    );
    mockCanvasInstance = {
      acquire: vi.fn().mockResolvedValue({ canvasId: 'testCanv01', query }),
    };

    const ctx = createMockContext({ errors: openmeteoDataframeQueryTool.errors });
    const input = openmeteoDataframeQueryTool.input.parse({
      canvas_id: 'testCanv01',
      sql: 'SELECT i, v FROM spilled_testCanv01',
    });
    const result = await openmeteoDataframeQueryTool.handler(input, ctx);

    expect(query.mock.calls[0]?.[1]).toMatchObject({ rowLimit: 25 });
    expect(result.rows).toHaveLength(25);
    expect(result.row_count).toBe(250); // true total preserved for paging guidance
    expect(result.rows[0]).toEqual({ i: 0, v: 0 });
    expect(result.rows[24]).toEqual({ i: 24, v: 48 });
  });

  it('passes canvas_id to canvas.acquire', async () => {
    const mockInstance = {
      canvasId: 'myCanvas01',
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    };
    const mockAcquire = vi.fn().mockResolvedValue(mockInstance);
    mockCanvasInstance = { acquire: mockAcquire };

    const ctx = createMockContext({ errors: openmeteoDataframeQueryTool.errors });
    const input = openmeteoDataframeQueryTool.input.parse({
      canvas_id: 'myCanvas01',
      sql: 'SELECT COUNT(*) AS n FROM spilled_myCanvas01',
    });
    await openmeteoDataframeQueryTool.handler(input, ctx);

    expect(mockAcquire).toHaveBeenCalledWith('myCanvas01', ctx);
  });

  it('formats empty result correctly', () => {
    const blocks = openmeteoDataframeQueryTool.format!({
      canvas_id: 'testCanv01',
      rows: [],
      row_count: 0,
      truncated: false,
    });
    expect(firstText(blocks)).toContain('testCanv01');
    expect(firstText(blocks)).toContain('No rows returned');
  });

  it('formats result rows as a markdown table', () => {
    const blocks = openmeteoDataframeQueryTool.format!({
      canvas_id: 'testCanv01',
      rows: [
        { time: '2020-01', avg_temp: -1.5 },
        { time: '2020-02', avg_temp: 2.1 },
      ],
      row_count: 2,
      truncated: false,
    });
    const text = firstText(blocks) ?? '';
    expect(text).toContain('testCanv01');
    expect(text).toContain('time');
    expect(text).toContain('avg_temp');
    expect(text).toContain('-1.5');
    expect(text).toContain('2.1');
  });

  it('serializes struct and list cells instead of coercing them to strings (#20)', () => {
    // Real shape from `SELECT struct_pack(temp := ..., rain := ...) AS nested,
    // [temperature_2m, precipitation] AS values`. String() renders the struct as
    // [object Object] and flattens the list to a bare comma join — content[] must
    // carry the same values structuredContent.rows does.
    const text = firstText(
      openmeteoDataframeQueryTool.format!({
        canvas_id: 'testCanv01',
        rows: [
          { nested: { temp: 3.6, rain: 0 }, values: [3.6, 0] },
          { nested: { temp: 3.2, rain: 0 }, values: [3.2, 0] },
        ],
        row_count: 2,
        truncated: false,
      }),
    );
    expect(text).toContain('| {"temp":3.6,"rain":0} | \\[3.6,0\\] |');
    expect(text).toContain('| {"temp":3.2,"rain":0} | \\[3.2,0\\] |');
    expect(text).not.toContain('[object Object]');
    expect(gfmTable(text)[1]?.map((cell) => cell.text)).toEqual([
      '{"temp":3.6,"rain":0}',
      '[3.6,0]',
    ]);
  });

  it('escapes literal pipes so a cell cannot break the table row', () => {
    // A pipe is not JSON-significant, so JSON.stringify passes it through verbatim;
    // unescaped it ends the cell early and misaligns the row's column count. Plain
    // string cells carry the same hazard.
    const text = firstText(
      openmeteoDataframeQueryTool.format!({
        canvas_id: 'testCanv01',
        rows: [{ nested: { note: 'pipe|test' }, plain: 'a|b' }],
        row_count: 1,
        truncated: false,
      }),
    );
    expect(text).toContain('| {"note":"pipe\\|test"} | a\\|b |');
    // Header + separator + one data row, each with exactly 2 columns.
    const dataRow = text.split('\n').find((l) => l.includes('pipe'));
    expect(dataRow?.split(/(?<!\\)\|/).length).toBe(4); // '' + 2 cells + ''
  });

  it('renders primitive and null cells on the unserialized path', () => {
    // BIGINT/DATE/TIMESTAMP arrive pre-marshaled as strings, so they must render
    // bare — not JSON-quoted — and a null cell stays empty.
    const text = firstText(
      openmeteoDataframeQueryTool.format!({
        canvas_id: 'testCanv01',
        rows: [
          {
            big: '123456789012345',
            day: '2020-01-01',
            stamp: '2020-01-01 00:00:00',
            n: -2.3,
            ok: true,
            missing: null,
          },
        ],
        row_count: 1,
        truncated: false,
      }),
    );
    expect(text).toContain(
      '| 123456789012345 | 2020-01-01 | 2020-01-01 00:00:00 | -2.3 | true |  |',
    );
  });

  it('shows truncation notice when row_count exceeds 100', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      time: `2020-01-${String(i + 1).padStart(2, '0')}`,
      v: i,
    }));
    const blocks = openmeteoDataframeQueryTool.format!({
      canvas_id: 'testCanv01',
      rows,
      row_count: 150,
      truncated: true,
    });
    const text = firstText(blocks) ?? '';
    expect(text).toContain('Showing first 100 of 150 rows');
    expect(text).toContain('LIMIT / OFFSET');
  });

  it('names the page as the limit it applied, and the next OFFSET (#65, #94)', () => {
    const text = firstText(
      openmeteoDataframeQueryTool.format!({
        canvas_id: 'testCanv01',
        rows: [{ v: 1 }, { v: 2 }, { v: 3 }],
        row_count: 8784,
        truncated: true,
      }),
    );
    expect(text).toContain('Showing first 3 of 8784 rows');
    expect(text).toContain('(limit 3)');
    expect(text).not.toContain('inline ceiling');
    expect(text).toContain('Continue at OFFSET 3');
    expect(text).not.toContain('OFFSET 100');
  });

  it('tells the caller to shrink any LIMIT by the rows shown and to page under an ORDER BY (#65)', () => {
    const text = firstText(
      openmeteoDataframeQueryTool.format!({
        canvas_id: 'testCanv01',
        rows: Array.from({ length: 100 }, (_, i) => ({ v: i })),
        row_count: 250,
        truncated: true,
      }),
    );
    expect(text.split('\n').at(-1)).toBe(
      '_Showing first 100 of 250 rows (limit 100). Continue at OFFSET 100: re-issue the SQL with LIMIT / OFFSET, adding 100 to any OFFSET it already applies and subtracting it from any LIMIT. Page under an ORDER BY: without one, DuckDB guarantees no row order between calls._',
    );
  });

  it('describes the same LIMIT and ORDER BY rules on the rows field (#65)', () => {
    const rows = openmeteoDataframeQueryTool.output.shape.rows.description ?? '';
    expect(rows).toContain(
      'continue by re-issuing the SQL with OFFSET <rows.length>, added to any OFFSET it already applies, with any LIMIT reduced by the same amount.',
    );
    expect(rows).toContain(
      'Page under an ORDER BY: without one, DuckDB guarantees no row order between calls.',
    );
  });
});

describe('openmeteoDataframeQueryTool limit (#94)', () => {
  const WHOLE_ROWS =
    "Rows come back whole, so a page's size rests on limit and on the columns the SQL selects: from a member-suffixed ensemble table, select only the columns the question needs. A page over 8,000,000 characters of row data fails as result_too_large rather than being cut. A LIMIT in the SQL still applies; the page holds the smaller of the two.";

  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfig();
  });

  /** A fresh tool module, so its server config parses the `OPENMETEO_CLAMP_LIMITS` stubbed here. */
  async function loadTool(clampLimits: string | undefined) {
    vi.resetModules();
    vi.stubEnv('OPENMETEO_CLAMP_LIMITS', clampLimits);
    return (await import('@/mcp-server/tools/definitions/dataframe-query.tool.js'))
      .openmeteoDataframeQueryTool;
  }

  /** The `limit` property of the inputSchema tools/list advertises, as it crosses the wire. */
  function advertisedLimit(tool: typeof openmeteoDataframeQueryTool): unknown {
    const schema = tool.input['~standard'].jsonSchema.input({ target: 'draft-2020-12' }) as {
      properties: Record<string, unknown>;
    };
    return JSON.parse(JSON.stringify(schema.properties.limit));
  }

  it('advertises a default of 25 and no maximum while clamping is on', async () => {
    expect(advertisedLimit(await loadTool(undefined))).toStrictEqual({
      default: 25,
      type: 'integer',
      minimum: 1,
      description: `Rows to return: the page size. Default 25; a larger value returns at most 10,000 rows and says so. ${WHOLE_ROWS}`,
    });
  });

  it('advertises maximum 10000 when OPENMETEO_CLAMP_LIMITS=false', async () => {
    expect(advertisedLimit(await loadTool('false'))).toStrictEqual({
      default: 25,
      type: 'integer',
      minimum: 1,
      maximum: 10000,
      description: `Rows to return: the page size. Default 25, at most 10,000. ${WHOLE_ROWS}`,
    });
  });

  it('takes its cap from a lower CANVAS_DEFAULT_ROW_LIMIT in both modes', async () => {
    resetConfig({ CANVAS_DEFAULT_ROW_LIMIT: '500' });
    expect(advertisedLimit(await loadTool('false'))).toMatchObject({
      maximum: 500,
      description: expect.stringContaining('Default 25, at most 500.'),
    });
    expect(advertisedLimit(await loadTool(undefined))).toMatchObject({
      description: expect.stringContaining('a larger value returns at most 500 rows and says so.'),
    });
  });

  it('lowers the default to a cap below 25 in both modes', async () => {
    resetConfig({ CANVAS_DEFAULT_ROW_LIMIT: '5' });
    expect(advertisedLimit(await loadTool('false'))).toMatchObject({
      default: 5,
      maximum: 5,
      description: expect.stringContaining('Default 5, at most 5.'),
    });
    expect(advertisedLimit(await loadTool(undefined))).toMatchObject({
      default: 5,
      description: expect.stringContaining(
        'Default 5; a larger value returns at most 5 rows and says so.',
      ),
    });
  });

  it('holds the cap at 10,000 when CANVAS_DEFAULT_ROW_LIMIT is higher', async () => {
    resetConfig({ CANVAS_DEFAULT_ROW_LIMIT: '50000' });
    expect(advertisedLimit(await loadTool('false'))).toMatchObject({ maximum: 10000 });
  });

  it('rejects a limit above the cap when OPENMETEO_CLAMP_LIMITS=false, naming the maximum', async () => {
    const tool = await loadTool('false');
    const err = await wireError(tool, { canvas_id: 'testCanv01', sql: 'SELECT 1', limit: 20000 });
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.message).toContain('limit');
    expect(err.message).toContain('10000');
    expect(err.message).not.toContain('Unrecognized');
  });

  it.each([
    ['on', undefined],
    ['off', 'false'],
  ])('rejects limit 0 and 2.5 with clamping %s', async (_mode, clampLimits) => {
    const tool = await loadTool(clampLimits);
    for (const [limit, problem] of [
      [0, '>=1'],
      [2.5, 'int'],
    ] as const) {
      const err = await wireError(tool, { canvas_id: 'testCanv01', sql: 'SELECT 1', limit });
      expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(err.message).toContain(problem);
      expect(err.message).not.toContain('Unrecognized');
    }
  });
});

describe('openmeteoDataframeQueryTool response ceiling', () => {
  /** Recovery for a page whose first row alone is over the ceiling. */
  const RETURN_LESS_PER_ROW =
    'Return less per row: select fewer columns, shorten long strings with left() or substr(), trim long lists with list_slice(), or aggregate.';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Serves `rows` as a data-query page with more rows behind it; returns the canvas query spy. */
  function serve(rows: Record<string, unknown>[]) {
    const query = vi.fn((sql: string) =>
      Promise.resolve(
        sql.startsWith('SELECT COUNT(*)')
          ? { rows: [{ n: 1000 }], rowCount: 1, truncated: false }
          : { rows, rowCount: rows.length, truncated: true },
      ),
    );
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue({ canvasId: 'testCanv01', query }) };
    return query;
  }

  /** The failed call's error envelope, and its content[] text as a CommonMark parse reads it. */
  async function failure() {
    const result = await runToolContract(openmeteoDataframeQueryTool, {
      canvas_id: 'testCanv01',
      sql: 'SELECT * FROM t',
    });
    expect(result.isError).toBe(true);
    return {
      error: (result.structuredContent as { error: WireError }).error,
      raw: firstText(result.content),
      text: renderedText(firstText(result.content)),
    };
  }

  it('refuses a page over 8,000,000 characters of row data on both surfaces, naming the rows that fit', async () => {
    const query = serve(['a', 'b', 'c'].map((ch) => ({ note: ch.repeat(3_000_000) })));
    const { error, text } = await failure();
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message:
        'This page of 3 rows holds more than 8,000,000 characters of row data, the most one response carries, and rows are never cut; its first 2 rows fit.',
      data: {
        reason: 'result_too_large',
        retryable: false,
        recovery: {
          hint: 'Set limit to 2 or less and page the rest with LIMIT / OFFSET, or select fewer columns.',
        },
      },
    });
    expect(text.split('\n').slice(0, 3)).toEqual([
      `Error: ${error.message}`,
      `Recovery: ${error.data?.recovery?.hint}`,
      '(reason result_too_large · not retryable)',
    ]);
    // The data query ran; the COUNT(*) behind a truncated page never did.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('says the first row fits when only it does', async () => {
    serve([{ note: 'a'.repeat(5_000_000) }, { note: 'b'.repeat(5_000_000) }]);
    const { error } = await failure();
    expect(error.message).toBe(
      'This page of 2 rows holds more than 8,000,000 characters of row data, the most one response carries, and rows are never cut; its first row fits.',
    );
    expect(error.data?.recovery?.hint).toBe(
      'Set limit to 1 or less and page the rest with LIMIT / OFFSET, or select fewer columns.',
    );
  });

  it.each([
    ['a one-row page', [{ note: 'x'.repeat(8_000_001) }]],
    ['a page whose first row alone is over', [{ note: 'x'.repeat(8_000_001) }, { note: 'y' }]],
  ])('tells %s to return less per row, not to lower limit', async (_page, rows) => {
    const query = serve(rows);
    const { error, raw, text } = await failure();
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message:
        'The first row alone holds more than 8,000,000 characters of row data, the most one response carries, and rows are never cut.',
      data: { reason: 'result_too_large', recovery: { hint: RETURN_LESS_PER_ROW } },
    });
    expect(text).toContain(`Recovery: ${RETURN_LESS_PER_ROW}`);
    expect(raw).not.toContain('limit');
    expect(raw).not.toContain('xxxxxxxxxx');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('declares result_too_large as the ValidationError the previous row_too_large was, not retryable', () => {
    expect(
      openmeteoDataframeQueryTool.errors?.find((e) => e.reason === 'result_too_large'),
    ).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      retryable: false,
      when: expect.stringContaining('8,000,000 characters of row data'),
    });
    expect(openmeteoDataframeQueryTool.description).toContain(
      'One response carries at most 8,000,000 characters of row data',
    );
  });

  describe('relayed error text', () => {
    /** A canvas whose data query rejects with `err`. */
    function failWith(err: unknown) {
      mockCanvasInstance = {
        acquire: vi.fn().mockResolvedValue({
          canvasId: 'testCanv01',
          query: vi.fn().mockRejectedValue(err),
        }),
      };
    }

    const marker = (length: number) =>
      ` … (cut to 2,000 of ${length.toLocaleString('en-US')} characters)`;

    it('cuts a relayed engine message and the data field quoting it to 2,000 characters, keeping code, reason, and recovery', async () => {
      const binderMessage = `Binder Error: Referenced column "${'a'.repeat(10_000)}" not found in FROM clause!`;
      const message = `Canvas query failed to prepare: ${binderMessage}`;
      failWith(
        validationError(message, {
          reason: 'invalid_sql',
          statementType: 'UNKNOWN',
          binderMessage,
          recovery: { hint: 'Correct the column name the message reports missing.' },
        }),
      );
      const { error, text } = await failure();
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({
        reason: 'invalid_sql',
        statementType: 'UNKNOWN',
        recovery: { hint: 'Correct the column name the message reports missing.' },
      });
      expect(error.message).toHaveLength(2_000);
      expect(
        error.message.startsWith(
          'Canvas query failed to prepare: Binder Error: Referenced column "aaa',
        ),
      ).toBe(true);
      expect(error.message.endsWith(marker(message.length))).toBe(true);
      const quoted = error.data?.binderMessage as string;
      expect(quoted).toHaveLength(2_000);
      expect(quoted.endsWith(marker(binderMessage.length))).toBe(true);
      expect(text.split('\n')[0]).toBe(`Error: ${error.message}`);
    });

    it('relays a message of exactly 2,000 characters whole and cuts one of 2,001', async () => {
      const whole = `Canvas query failed: Invalid Input Error: ${'x'.repeat(2_000 - 42)}`;
      expect(whole).toHaveLength(2_000);
      failWith(validationError(whole, { reason: 'sql_execution_error' }));
      expect((await failure()).error.message).toBe(whole);

      failWith(validationError(`${whole}y`, { reason: 'sql_execution_error' }));
      const { error } = await failure();
      expect(error.message).toHaveLength(2_000);
      expect(error.message.endsWith(marker(2_001))).toBe(true);
      expect(error.data?.reason).toBe('sql_execution_error');
    });

    it.each([
      ['an even', ''],
      ['an odd', 'x'],
    ])('cuts on a code-point boundary at %s offset', async (_parity, lead) => {
      const message = `${lead}${'😀'.repeat(3_000)}`;
      failWith(validationError(message, { reason: 'sql_execution_error' }));
      const { error } = await failure();
      expect(error.message.isWellFormed()).toBe(true);
      const [head, tail] = error.message.split(' … (cut to ');
      expect(message.startsWith(head ?? '')).toBe(true);
      expect(`(cut to ${tail}`).toBe(marker(message.length).slice(3));
      expect(error.message.length).toBeGreaterThanOrEqual(1_999);
      expect(error.message.length).toBeLessThanOrEqual(2_000);
    });

    it('cuts the error a cancelled count rethrows', async () => {
      const controller = new AbortController();
      const long = `Canvas query failed: Invalid Input Error: ${'x'.repeat(50_000)}`;
      const query = vi.fn((sql: string) => {
        if (!sql.startsWith('SELECT COUNT(*)')) {
          return Promise.resolve({ rows: [{ v: 1 }], rowCount: 1, truncated: true });
        }
        controller.abort();
        return Promise.reject(validationError(long, { reason: 'sql_execution_error' }));
      });
      mockCanvasInstance = {
        acquire: vi.fn().mockResolvedValue({ canvasId: 'testCanv01', query }),
      };
      const ctx = createMockContext({
        signal: controller.signal,
        errors: openmeteoDataframeQueryTool.errors,
      });
      const input = openmeteoDataframeQueryTool.input.parse({
        canvas_id: 'testCanv01',
        sql: 'SELECT v FROM t',
      });
      const outcome = await Promise.resolve(openmeteoDataframeQueryTool.handler(input, ctx)).then(
        () => undefined,
        (err: unknown) => err as { code: number; message: string; data?: { reason?: string } },
      );
      expect(outcome?.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(outcome?.data?.reason).toBe('sql_execution_error');
      expect(outcome?.message).toHaveLength(2_000);
      expect(outcome?.message.endsWith(marker(long.length))).toBe(true);
    });
  });
});

/**
 * Split a rendered table line into cells the way a GFM table parser does: a backslash
 * escapes the character after it (so `\\` is one escaped backslash and `\|` one escaped
 * pipe), and only an unescaped `|` delimits. Returns the cells between the outer pipes.
 */
function gfmCells(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      cell += ch + line[i + 1];
      i++;
    } else if (ch === '|') {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells.slice(1, -1).map((c) => c.trim());
}

/** The table lines of a rendered result: header, separator, then one line per row. */
function tableLines(text: string): string[] {
  return text.split('\n').filter((line) => line.startsWith('|'));
}

describe('openmeteoDataframeQueryTool content[] cell encoding (#66)', () => {
  const render = (rows: Record<string, unknown>[]) =>
    firstText(
      openmeteoDataframeQueryTool.format!({
        canvas_id: 'testCanv01',
        rows,
        row_count: rows.length,
        truncated: false,
      }),
    );

  /** Each table line's cells as a GFM parse reads them. */
  const parsed = (text: string) => gfmTable(text).map((row) => row.map((cell) => cell.text));

  it('keeps a newline-bearing value on one table row, read back whole', () => {
    const text = render([{ note: '<b>**A**\nB</b>' }]);
    expect(tableLines(text)).toEqual(['| note |', '| --- |', '| \\<b>\\*\\*A\\*\\*&#10;B\\</b> |']);
    expect(parsed(text)).toEqual([['note'], ['<b>**A**\nB</b>']]);
  });

  it('escapes pipes and newlines in column names so the header parses as a table', () => {
    const text = render([{ 'a|b': 1, 'line\nbreak': 'x' }]);
    const lines = tableLines(text);
    expect(lines[0]).toBe('| a\\|b | line&#10;break |');
    expect(lines.map((line) => gfmCells(line).length)).toEqual([2, 2, 2]);
    expect(parsed(text)[0]).toEqual(['a|b', 'line\nbreak']);
  });

  it('renders the empty string as "" and null as an empty cell', () => {
    const text = render([{ n: null, e: '' }]);
    expect(tableLines(text)[2]).toBe('|  | "" |');
  });

  it('reads back backslashes, carriage returns, quotes, and tabs as written', () => {
    const values = { bs: 'x\\|y', crlf: '\r\n', q: 'say "hi"', tab: 'a\tb' };
    const text = render([values]);
    const row = tableLines(text)[2] ?? '';
    expect(row).toBe('| x\\\\\\|y | &#13;&#10; | say "hi" | a\tb |');
    // The escaped backslash is consumed as its own pair, so the pipe stays escaped.
    expect(gfmCells(row)).toHaveLength(4);
    expect(parsed(text)[1]).toEqual(Object.values(values));
  });

  describe('characters a table cell would split or trim', () => {
    const LINE_SEPARATOR = String.fromCharCode(0x2028);
    const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
    const NBSP = String.fromCharCode(0xa0);

    it.each([
      ['a line separator', `a${LINE_SEPARATOR}b`, 'a&#8232;b'],
      ['a paragraph separator', `a${PARAGRAPH_SEPARATOR}b`, 'a&#8233;b'],
      ['a lone no-break space', NBSP, '&#160;'],
      ['a no-break space between words', `a${NBSP}b`, `a${NBSP}b`],
      ['a single space', ' ', '&#32;'],
      ['leading and trailing spaces', '  pad  ', '&#32;&#32;pad&#32;&#32;'],
      ['a space inside a value', 'a b', 'a b'],
    ])('renders %s on one row the parser cannot trim', (_label, value, cell) => {
      const text = render([{ v: value, n: null }]);
      const lines = tableLines(text);
      expect(lines[2]).toBe(`| ${cell} |  |`);
      expect(lines).toHaveLength(3);
      expect(parsed(text)[1]).toEqual([value, '']);
    });

    it('keeps a single space distinct from null and from the empty string', () => {
      const text = render([{ space: ' ', empty: '', missing: null }]);
      expect(tableLines(text)[2]).toBe('| &#32; | "" |  |');
      expect(parsed(text)[1]).toEqual([' ', '""', '']);
    });

    it('encodes the same characters in a column name', () => {
      const text = render([{ ' padded ': 1, [`x${LINE_SEPARATOR}y`]: 2 }]);
      expect(tableLines(text)[0]).toBe('| &#32;padded&#32; | x&#8232;y |');
      expect(parsed(text)[0]).toEqual([' padded ', `x${LINE_SEPARATOR}y`]);
    });
  });

  it('leaves structuredContent values untouched while content[] escapes them', async () => {
    const rows = [{ note: 'a|b\nc', empty: '', missing: null }];
    const query = vi.fn().mockResolvedValue({ rows, rowCount: 1 });
    mockCanvasInstance = {
      acquire: vi.fn().mockResolvedValue({ canvasId: 'testCanv01', query }),
    };
    const result = await runToolContract(openmeteoDataframeQueryTool, {
      canvas_id: 'testCanv01',
      sql: 'SELECT 1',
    });
    expect((result.structuredContent as { rows: unknown[] }).rows).toEqual(rows);
    expect(tableLines(firstText(result.content))[2]).toBe('| a\\|b&#10;c | "" |  |');
  });
});

describe('openmeteoDataframeQueryTool content[] round trip (#86)', () => {
  const render = (rows: Record<string, unknown>[]) =>
    firstText(
      openmeteoDataframeQueryTool.format!({
        canvas_id: 'testCanv01',
        rows,
        row_count: rows.length,
        truncated: false,
      }),
    );

  /** The text a reader should see for `value`: itself, `""` for the empty string, JSON for a struct or list. */
  const readsAs = (value: unknown) =>
    value === null
      ? ''
      : value === ''
        ? '""'
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);

  /**
   * Asserts `value` reads back exactly, with no markup opened, as a cell and — when it
   * is a string — as a header, under both HTML settings, every row keeping two columns.
   */
  function expectRoundTrip(value: unknown) {
    const asCell = render([{ v: value, n: null }]);
    const asHeader =
      typeof value === 'string' && value !== '' ? render([{ [value]: 1, k: 2 }]) : undefined;
    for (const html of [false, true]) {
      const cells = gfmTable(asCell, { html });
      expect(cells.map((row) => row.length)).toEqual([2, 2]);
      expect(cells[1]).toEqual([
        { text: readsAs(value), markup: [] },
        { text: '', markup: [] },
      ]);
      if (asHeader === undefined) continue;
      const headers = gfmTable(asHeader, { html });
      expect(headers.map((row) => row.length)).toEqual([2, 2]);
      expect(headers[0]?.[0]).toEqual({ text: value, markup: [] });
    }
  }

  const LINE_SEPARATOR = String.fromCharCode(0x2028);
  const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
  const NBSP = String.fromCharCode(0xa0);

  /** Markdown syntax, entities, and line terminators: each read as something else before #86. */
  const SYNTAX_VALUES: [string, unknown][] = [
    ['emphasis', '*x*'],
    ['underscore emphasis', '_a_b_'],
    ['strong emphasis', '__x__'],
    ['a code span', 'a `code` b'],
    ['a link', '[t](u)'],
    ['an image', '![a](b)'],
    ['strikethrough', '~~s~~'],
    ['inline HTML', '<b>x</b>'],
    ['an autolink', '<http://x.io>'],
    ['an email autolink', '<a@b.io>'],
    ['a backslash before a pipe', 'x\\|y'],
    ['an entity', '&copy;'],
    ['a numeric character reference', '&#10;'],
    ['a leading heading marker', '# h'],
    ['a leading list marker', '- item'],
    ['a leading ordered-list marker', '1. x'],
    ['a thematic break', '---'],
    ['a newline', 'a\nb'],
    ['a CRLF', 'a\r\nb'],
    ['a carriage return', 'a\rb'],
    ['a trailing newline', 'a\n'],
    ['a backslash before a newline', 'a\\\nb'],
    ['a tab', 'a\tb'],
    ['edge spaces', '  pad  '],
    ['a single space', ' '],
    ['a lone no-break space', NBSP],
    ['a line separator', `a${LINE_SEPARATOR}b`],
    ['a paragraph separator', `a${PARAGRAPH_SEPARATOR}b`],
    ['edge pipes', '|a|'],
    ['a struct holding Markdown', { s: '`x`', l: ['[t](u)', null], note: 'a*b|c' }],
    ['a list holding Markdown', ['*a*', '~~b~~', 1]],
  ];

  describe('values carrying Markdown syntax or line breaks', () => {
    it.each(SYNTAX_VALUES)('%s', (_label, value) => expectRoundTrip(value));
  });

  describe('running time over caller-sized cells', () => {
    /** Generous per-character CPU ceiling for rendering one cell and its header. */
    const CPU_MICROS_PER_CHAR = 2;
    const BASE = 5_000;

    /**
     * Shapes grown by doubling from 5k characters: the digit run to 320k, the full 64×
     * span, and every other shape to 80k.
     */
    const SHAPES: [string, (size: number) => string, number][] = [
      ['a repeated opener with no closer', (size) => '['.repeat(size), 80_000],
      ['repeated backticks', (size) => '`'.repeat(size), 80_000],
      ['nested openers', (size) => '[!['.repeat(size / 3), 80_000],
      ['overlapping prefixes', (size) => '&#'.repeat(size / 2), 80_000],
      ['overlapping tag prefixes', (size) => '<a'.repeat(size / 2), 80_000],
      ['a whitespace run inside one line', (size) => `a${' '.repeat(size)}b`, 80_000],
      ['one long line ending in a break', (size) => `${'§1 x'.repeat(size / 4)}\ny`, 80_000],
      ['breaks throughout', (size) => '  \r\n'.repeat(size / 4), 80_000],
      ['a long digit run', (size) => '1'.repeat(size), 320_000],
    ];

    it.each(SHAPES)('stays linear on %s', (_shape, build, largest) => {
      const timeAt = (size: number) => {
        const value = build(size);
        const rows = [{ [value]: value }];
        return cpuMicrosPerCall(() => render(rows), Math.max(4, Math.ceil(400_000 / size)));
      };

      const base = timeAt(BASE);
      expect(base).toBeLessThan(BASE * CPU_MICROS_PER_CHAR);
      let atLargest = base;
      for (let size = BASE * 2; size <= largest; size *= 2) {
        atLargest = timeAt(size);
        expect(atLargest, `${size} characters`).toBeLessThan(size * CPU_MICROS_PER_CHAR);
      }

      // Linear growth over the span is its own size; quadratic would be its square.
      const span = largest / BASE;
      expect(atLargest / base).toBeLessThan(4 * span);
    });
  });

  it('leaves structuredContent rows exactly as the canvas returned them', async () => {
    const rows = [Object.fromEntries(SYNTAX_VALUES.map(([label, value]) => [label, value]))];
    const query = vi.fn().mockResolvedValue({ rows, rowCount: 1 });
    mockCanvasInstance = {
      acquire: vi.fn().mockResolvedValue({ canvasId: 'testCanv01', query }),
    };
    const result = await runToolContract(openmeteoDataframeQueryTool, {
      canvas_id: 'testCanv01',
      sql: 'SELECT 1',
    });
    expect((result.structuredContent as { rows: unknown[] }).rows).toStrictEqual(
      structuredClone(rows),
    );
    const table = gfmTable(firstText(result.content));
    expect(table[1]?.map((cell) => cell.text)).toEqual(SYNTAX_VALUES.map(([, v]) => readsAs(v)));
  });

  describe('values that already read back as themselves', () => {
    it.each([
      ['an intraword underscore', 'a_b_c'],
      ['double quotes', 'say "hi"'],
      ['a backslash before a star', 'x\\*y'],
      ['a backslash before a letter', 'x\\y'],
      ['a lone backslash', '\\'],
      ['a pipe', 'a|b'],
      ['a BIGINT marshaled as a string', '123456789012345'],
      ['a timestamp', '2020-01-01 00:00:00'],
      ['the empty string', ''],
      ['null', null],
      ['a number', -2.3],
      ['a boolean', true],
      ['a plain struct', { temp: 3.6, rain: 0 }],
      ['a plain list', [3.6, 0]],
    ])('%s', (_label, value) => expectRoundTrip(value));
  });
});

/** Hourly timestamps as Open-Meteo stages them (`YYYY-MM-DDTHH:MM`), from 2024-01-01 by default. */
function hourlyTimes(count: number, from = '2024-01-01T00:00'): string[] {
  const start = Date.parse(`${from}:00Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(start + i * 3_600_000).toISOString().slice(0, 16),
  );
}

const round1 = (n: number) => Math.round(n * 10) / 10;

describe('openmeteoDataframeQueryTool against a real DuckDB canvas', () => {
  const TENANT = 'tenant-query';
  let canvas: DataCanvas;
  let provider: DuckdbProvider;
  let exportRoot: string;
  let canvasId: string;

  beforeAll(async () => {
    exportRoot = mkdtempSync(join(tmpdir(), 'openmeteo-query-test-'));
    provider = new DuckdbProvider({
      defaultRowLimit: 10_000,
      exportRootPath: exportRoot,
      memoryLimitMb: 256,
      schemaSniffRows: 100,
    });
    canvas = new DataCanvas(
      provider,
      new CanvasRegistry(provider, { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, sweeperIntervalMs: 0 }),
    );
    const instance = await canvas.acquire(undefined, createMockContext({ tenantId: TENANT }));
    canvasId = instance.canvasId;

    // One-variable hourly year: the shape openmeteo_get_historical stages.
    await instance.registerTable(
      'hist',
      hourlyTimes(8784).map((time, i) => ({
        time,
        temperature_2m: round1(8 + 6 * Math.sin((i / 24) * 2 * Math.PI) + (i % 7) / 10),
      })),
    );
    // A 51-member, three-variable, 7-day ensemble: 154 columns, 168 rows.
    const members = [
      '',
      ...Array.from({ length: 50 }, (_, m) => `_member${String(m + 1).padStart(2, '0')}`),
    ];
    await instance.registerTable(
      'ens',
      hourlyTimes(168).map((time, i) => {
        const row: Record<string, unknown> = { time };
        members.forEach((suffix, m) => {
          row[`temperature_2m${suffix}`] = round1(10 + ((i + m) % 13) / 3);
          row[`precipitation${suffix}`] = round1(((i * m) % 9) / 10);
          row[`wind_speed_10m${suffix}`] = round1(12 + ((i + 2 * m) % 11) / 2);
        });
        return row;
      }),
    );
    await instance.registerTable('u', [{ k: 1 }, { k: 2 }, { k: 3 }]);
  });

  afterAll(async () => {
    await canvas.shutdown(createMockContext({ tenantId: TENANT }));
    rmSync(exportRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockCanvasInstance = canvas;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const run = (sql: string, limit?: number) =>
    runToolContract(
      openmeteoDataframeQueryTool,
      { canvas_id: canvasId, sql, ...(limit === undefined ? {} : { limit }) },
      { context: { tenantId: TENANT } },
    );

  type Structured = {
    rows: Record<string, unknown>[];
    row_count: number;
    count_error?: string;
    truncated: boolean;
  };

  /** Both serialized surfaces, plus every content[] block the framework emits. */
  function surfaces(result: Awaited<ReturnType<typeof run>>) {
    const structured = result.structuredContent as Structured;
    const contentTotal = result.content.reduce(
      (sum, block) => sum + (block.type === 'text' ? block.text.length : 0),
      0,
    );
    return {
      structured,
      structuredChars: JSON.stringify(structured).length,
      text: firstText(result.content),
      textChars: firstText(result.content).length,
      contentTotal,
      blocks: result.content.length,
    };
  }

  describe('whole rows, never cut (#65, #94)', () => {
    it('returns a 150,000-character value whole on both surfaces', async () => {
      const s = surfaces(await run("SELECT repeat('x', 150000) AS note"));
      expect(s.structured.rows).toEqual([{ note: 'x'.repeat(150_000) }]);
      expect(gfmTable(s.text)[1]?.[0]?.text).toBe('x'.repeat(150_000));
    });

    it('returns limit wide rows whole on both surfaces, with the continuation', async () => {
      const result = await run("SELECT repeat('x', 10000) AS note FROM hist");
      const s = surfaces(result);
      expect(s.blocks).toBe(1);
      expect(s.structured.rows).toHaveLength(25);
      for (const row of s.structured.rows) expect(row.note).toHaveLength(10_000);
      expect(s.structured.row_count).toBe(8784);
      expect(tableLines(s.text)).toHaveLength(27);
      expect(s.text).toContain('Showing first 25 of 8784 rows (limit 25)');
      expect(s.text).toContain('Continue at OFFSET 25');
    });

    it('returns SELECT * on a 154-column ensemble table as 25 identical rows on both surfaces', async () => {
      const s = surfaces(await run('SELECT * FROM ens'));
      const shown = s.structured.rows.length;
      expect(shown).toBe(25);
      expect(s.structured.row_count).toBe(168);
      const lines = tableLines(s.text);
      expect(lines).toHaveLength(shown + 2);
      expect(lines.map((line) => gfmCells(line).length)).toEqual(Array(shown + 2).fill(154));
      s.structured.rows.forEach((row, i) => {
        expect(gfmCells(lines[i + 2] ?? '')).toEqual(Object.values(row).map(String));
      });
    });

    it('returns the first limit of 50 wide rows under a SQL LIMIT, with the continuation', async () => {
      const s = surfaces(await run(`SELECT repeat('x', 9000) AS note FROM hist LIMIT 50`));
      expect(s.structured.row_count).toBe(50);
      expect(s.structured.rows).toHaveLength(25);
      expect(s.text).toContain('Showing first 25 of 50 rows');
    });

    it('returns both 30,000-pipe rows whole, each pipe reading back as itself', async () => {
      const s = surfaces(await run("SELECT repeat('|', 30000) AS p FROM u ORDER BY k LIMIT 2"));
      expect(s.structured.rows).toHaveLength(2);
      expect(s.structured.row_count).toBe(2);
      expect(s.text).not.toContain('Continue at OFFSET');
      expect(gfmTable(s.text).map((row) => row.map((cell) => cell.text))).toEqual([
        ['p'],
        ['|'.repeat(30_000)],
        ['|'.repeat(30_000)],
      ]);
    });

    it('returns limit rows under a 1,000-character alias, which renders once in the header', async () => {
      const alias = 'a'.repeat(1_000);
      const s = surfaces(await run(`SELECT temperature_2m AS "${alias}" FROM hist`));
      expect(s.structured.rows).toHaveLength(25);
      expect(s.structured.row_count).toBe(8784);
      expect(gfmTable(s.text)[0]?.map((cell) => cell.text)).toEqual([alias]);
    });

    it('returns a 12-row monthly aggregate whole, with no notice', async () => {
      const s = surfaces(
        await run(
          'SELECT substr(time, 1, 7) AS month, round(avg(temperature_2m), 2) AS avg_t FROM hist GROUP BY month ORDER BY month',
        ),
      );
      expect(s.structured.rows).toHaveLength(12);
      expect(s.structured.row_count).toBe(12);
      expect(s.text).not.toContain('Showing first');
    });

    it('returns the first 25 of 8784 rows by default for SELECT * over a one-variable hourly table', async () => {
      const s = surfaces(await run('SELECT * FROM hist'));
      expect(s.structured.rows).toHaveLength(25);
      expect(s.structured.row_count).toBe(8784);
      expect(s.structured.truncated).toBe(true);
      expect(s.text).toContain('**Rows:** 8784 | **Truncated:** true');
      expect(s.structured).not.toHaveProperty('notice');
      expect(s.text.split('\n').at(-1)).toBe(
        '_Showing first 25 of 8784 rows (limit 25). Continue at OFFSET 25: re-issue the SQL with LIMIT / OFFSET, adding 25 to any OFFSET it already applies and subtracting it from any LIMIT. Page under an ORDER BY: without one, DuckDB guarantees no row order between calls._',
      );
    });

    it('returns a whole-year list() as one row', async () => {
      const s = surfaces(await run('SELECT list(temperature_2m) AS temps FROM hist'));
      expect(s.structured.rows).toHaveLength(1);
      expect(s.structured.rows[0]?.temps).toHaveLength(8784);
    });

    it('returns a left()-shortened value whole', async () => {
      const s = surfaces(await run("SELECT left(repeat('x', 150000), 20) AS note"));
      expect(s.structured.rows).toEqual([{ note: 'x'.repeat(20) }]);
    });

    it('returns no rows for an empty result and for an OFFSET past the end', async () => {
      for (const sql of ['SELECT * FROM hist WHERE false', 'SELECT * FROM hist OFFSET 100000']) {
        const s = surfaces(await run(sql));
        expect(s.structured).toMatchObject({ rows: [], row_count: 0 });
        expect(s.text).toContain('No rows returned');
      }
    });
  });

  /**
   * Every example SQL in the `sql` description, read from the description itself and run
   * through the tool on tables staged the way the spilling tools stage them
   * (`stageSpill`), so `time` is the VARCHAR the real union table carries (#78).
   */
  describe('the sql description examples (#78)', () => {
    const description = openmeteoDataframeQueryTool.input.shape.sql.description ?? '';
    const examples = [...description.matchAll(/`(SELECT [^`]+)`/g)].map((m) => m[1] as string);
    const dateExample = examples.find((sql) => sql.includes('strftime'));
    const memberExample = examples.find((sql) => sql.includes('COLUMNS('));
    const tables: Record<'daily' | 'hourly' | 'mixed' | 'members', string> = {
      daily: '',
      hourly: '',
      mixed: '',
      members: '',
    };

    /** Two days either side of a month boundary; each month holds one value per column. */
    const dailyRecords = ['2024-01-30', '2024-01-31', '2024-02-01', '2024-02-02'].map(
      (time, i) => ({
        time,
        temperature_2m_max: [4, 6, 7, 9][i],
        sunrise: `${time}T07:4${i}`,
        sunset: `${time}T17:0${i}`,
      }),
    );
    const hourlyRecords = hourlyTimes(48, '2024-01-31T00:00').map((time) => ({
      time,
      temperature_2m: time.startsWith('2024-01') ? 1.5 : 3.5,
    }));

    /** Members 01–05 beside the control run and a temperature member the pattern must skip. */
    const memberRows: [number | null, (number | null)[]][] = [
      [9, [0, 0.6, 0.7, 0.2, 1]], // control > 0.5 is not counted: 3 of 5
      [0, [0.5, 0.5, 0.5, 0.5, 0.5]], // strictly greater: 0 of 5
      [2, [0.6, null, 0.9, null, 0.1]], // partial reporting: 2 of 3
      [0.6, [1.2, 1.4, 1.1, 1.3, 1.6]], // all over: 5 of 5
      [null, [null, null, null, null, null]], // past the last forecast hour
      [null, [null, null, null, null, null]],
    ];
    const memberRecords = hourlyTimes(memberRows.length, '2026-07-30T00:00').map((time, i) => {
      const [control, members] = memberRows[i] as [number | null, (number | null)[]];
      const row: Record<string, unknown> = {
        time,
        precipitation: control,
        temperature_2m_member01: control === null ? null : 20,
      };
      members.forEach((value, m) => {
        row[`precipitation_member0${m + 1}`] = value;
      });
      return row;
    });

    beforeAll(async () => {
      const instance = await canvas.acquire(canvasId, createMockContext({ tenantId: TENANT }));
      const stage = async (records: readonly Record<string, unknown>[]) =>
        (await stageSpill(instance, records as Parameters<typeof stageSpill>[1])).tableName;
      tables.daily = await stage(dailyRecords);
      tables.hourly = await stage(hourlyRecords);
      tables.mixed = await stage([...hourlyRecords, ...dailyRecords]);
      tables.members = await stage(memberRecords);
    });

    const runExample = (sql: string, table: string, column?: string) =>
      run(sql.replaceAll('<table_name>', table).replaceAll('<column>', column ?? '<column>'));

    it('gives exactly two examples — the monthly cast and the ensemble member count', () => {
      expect(examples).toHaveLength(2);
      expect(dateExample).toBeDefined();
      expect(memberExample).toBeDefined();
      expect(dateExample).toContain("strftime(CAST(time AS TIMESTAMP), '%Y-%m')");
    });

    it.each([
      ['daily-only', 'daily', 'temperature_2m_max', [5, 8]],
      ['hourly-only', 'hourly', 'temperature_2m', [1.5, 3.5]],
      ['mixed, an hourly column', 'mixed', 'temperature_2m', [1.5, 3.5]],
      ['mixed, a daily column', 'mixed', 'temperature_2m_max', [5, 8]],
    ] as const)('runs the monthly example on a %s table', async (_label, table, column, means) => {
      const result = await runExample(dateExample as string, tables[table], column);

      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as Structured).rows).toEqual([
        { month: '2024-01', mean: means[0] },
        { month: '2024-02', mean: means[1] },
      ]);
    });

    it('runs the member example: counts members only, with a per-row denominator', async () => {
      const result = await runExample(memberExample as string, tables.members);

      expect(result.isError).toBeFalsy();
      const rows = (result.structuredContent as Structured).rows.map((row) => ({
        time: row.time,
        over: Number(row.members_over),
        reporting: Number(row.members_reporting),
      }));
      expect(rows).toEqual([
        { time: '2026-07-30T00:00', over: 3, reporting: 5 },
        { time: '2026-07-30T01:00', over: 0, reporting: 5 },
        { time: '2026-07-30T02:00', over: 2, reporting: 3 },
        { time: '2026-07-30T03:00', over: 5, reporting: 5 },
        { time: '2026-07-30T04:00', over: 0, reporting: 0 },
        { time: '2026-07-30T05:00', over: 0, reporting: 0 },
      ]);
    });

    it('runs the member example on the 51-member ensemble, matching all 50 members', async () => {
      const result = await run(
        `SELECT DISTINCT members_reporting FROM (${(memberExample as string).replaceAll('<table_name>', 'ens')})`,
      );

      expect(result.isError).toBeFalsy();
      expect(
        (result.structuredContent as Structured).rows.map((r) => Number(r.members_reporting)),
      ).toEqual([50]);
    });

    it('casts daily sunrise and sunset the way the description says', async () => {
      const result = await run(
        `SELECT strftime(CAST(sunrise AS TIMESTAMP), '%H:%M') AS rise, strftime(CAST(sunset AS TIMESTAMP), '%H:%M') AS set FROM ${tables.daily} ORDER BY time LIMIT 1`,
      );
      expect((result.structuredContent as Structured).rows).toEqual([
        { rise: '07:40', set: '17:00' },
      ]);
    });

    it('keeps time VARCHAR, so LIKE still separates hourly from daily rows', async () => {
      mockCanvasInstance = canvas;
      const described = await runToolContract(
        openmeteoDataframeDescribeTool,
        { canvas_id: canvasId },
        { context: { tenantId: TENANT } },
      );
      const staged = (
        described.structuredContent as {
          tables: { name: string; columns: { name: string; type: string }[] }[];
        }
      ).tables.find((t) => t.name === tables.mixed);
      expect(staged?.columns.find((c) => c.name === 'time')?.type).toBe('VARCHAR');

      const split = await run(
        `SELECT count(*) FILTER (WHERE time LIKE '%T%') AS hourly, count(*) FILTER (WHERE time NOT LIKE '%T%') AS daily FROM ${tables.mixed}`,
      );
      const [counts] = (split.structuredContent as Structured).rows;
      expect([Number(counts?.hourly), Number(counts?.daily)]).toEqual([48, 4]);
    });

    it('fails strftime on the uncast text column, which is why the examples cast', async () => {
      const error = await wireError(
        openmeteoDataframeQueryTool,
        {
          canvas_id: canvasId,
          sql: `SELECT strftime(time, '%Y-%m') AS month FROM ${tables.daily}`,
        },
        { context: { tenantId: TENANT } },
      );
      expect(error.message).toContain('strftime(VARCHAR, STRING_LITERAL)');
    });
  });

  describe('exact row_count (#72)', () => {
    it('counts a result past the canvas 10,000-row limit exactly', async () => {
      const s = surfaces(await run('SELECT * FROM hist CROSS JOIN u'));
      expect(s.structured.row_count).toBe(26352);
      expect(s.structured.count_error).toBeUndefined();
      expect(s.structured.rows).toHaveLength(25);
      expect(s.text).toContain('Showing first 25 of 26352 rows');
    });

    it('materializes no more rows than the page, then counts through the same gate', async () => {
      const query = vi.spyOn(provider, 'query');
      await run('SELECT * FROM hist CROSS JOIN u;\n ');
      expect(query).toHaveBeenCalledTimes(2);
      const [dataCall, countCall] = query.mock.calls;
      expect(dataCall?.[3]).toMatchObject({ rowLimit: 25, denySystemCatalogs: true });
      const dataResult = await query.mock.results[0]?.value;
      expect(dataResult.rows.length).toBeLessThanOrEqual(25);
      expect(countCall?.[1]).toBe(
        'SELECT COUNT(*) AS n FROM (\nSELECT * FROM hist CROSS JOIN u\n)',
      );
      expect(countCall?.[3]).toMatchObject({ denySystemCatalogs: true });
    });

    it('runs no count query when the result fits the page', async () => {
      const query = vi.spyOn(provider, 'query');
      const s = surfaces(await run('SELECT * FROM hist LIMIT 100', 100));
      expect(query).toHaveBeenCalledTimes(1);
      expect(s.structured.rows).toHaveLength(100);
      expect(s.structured.row_count).toBe(100);
      expect(s.text).not.toContain('Showing first');
    });

    it('keeps the rows and reports a lower bound when the count query fails', async () => {
      // The trailing comment after `;` passes on its own but leaves the wrapped
      // count unparseable — a real count-only failure.
      const s = surfaces(await run('SELECT * FROM hist; -- whole year'));
      expect(s.structured.rows).toHaveLength(25);
      expect(s.structured.row_count).toBe(26);
      expect(s.structured.count_error).toBe('invalid_sql');
      expect(s.text).toContain('at least 26 (the full result could not be counted: invalid_sql)');
      expect(s.text).toContain('Showing first 25 of at least 26 rows');
    });

    it('reports the count failure reason the canvas raised', async () => {
      const original = provider.query.bind(provider);
      let calls = 0;
      vi.spyOn(provider, 'query').mockImplementation((...args) =>
        calls++ === 0
          ? original(...args)
          : Promise.reject(
              validationError('Canvas query failed: Conversion Error', {
                reason: 'sql_execution_error',
              }),
            ),
      );
      const s = surfaces(await run('SELECT * FROM hist'));
      expect(s.structured).toMatchObject({ row_count: 26, count_error: 'sql_execution_error' });
      expect(s.structured.rows).toHaveLength(25);
    });

    /**
     * A three-way cross join of the staged tables: 231 million rows the page streams
     * its first 25 of at once, and that a full COUNT(*) takes far longer than the
     * shortened budget to walk. The canvas interrupts the real DuckDB statement.
     */
    const SLOW_COUNT_SQL =
      'SELECT a.time FROM hist a CROSS JOIN hist b CROSS JOIN u WHERE a.temperature_2m + u.k < b.temperature_2m';

    it('interrupts a count past its 5-second budget and reports the lower bound as count_timeout', async () => {
      const realTimeout = AbortSignal.timeout.bind(AbortSignal);
      const budget = vi
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation((ms) => realTimeout(ms === 5_000 ? 25 : ms));
      const s = surfaces(await run(SLOW_COUNT_SQL));
      expect(s.structured.rows).toHaveLength(25);
      expect(s.structured).toMatchObject({ row_count: 26, count_error: 'count_timeout' });
      expect(s.text).toContain('at least 26 (the full result could not be counted: count_timeout)');
      expect(s.text).toContain('Showing first 25 of at least 26 rows');
      expect(budget).toHaveBeenCalledWith(5_000);
    });

    it('propagates a caller cancellation during the count as cancelled, not count_timeout', async () => {
      const controller = new AbortController();
      const original = provider.query.bind(provider);
      let calls = 0;
      // Real DuckDB on both queries; the caller aborts shortly after the count begins.
      vi.spyOn(provider, 'query').mockImplementation((...args) => {
        if (calls++ === 1) setTimeout(() => controller.abort(), 25);
        return original(...args);
      });
      const ctx = createMockContext({
        tenantId: TENANT,
        signal: controller.signal,
        errors: openmeteoDataframeQueryTool.errors,
      });
      const input = openmeteoDataframeQueryTool.input.parse({
        canvas_id: canvasId,
        sql: SLOW_COUNT_SQL,
      });
      const outcome = await Promise.resolve(openmeteoDataframeQueryTool.handler(input, ctx)).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      expect(outcome).not.toHaveProperty('value');
      expect(calls).toBe(2);
      expect((outcome as { error: unknown }).error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'cancelled' },
      });
    });

    it.each([
      ["SELECT * FROM 'weather.csv'", JsonRpcErrorCode.ValidationError, 'sql_read_only'],
      ["SELECT current_setting('threads')", JsonRpcErrorCode.ValidationError, 'denied_function'],
      ['SELECT * FROM not_staged CROSS JOIN u', JsonRpcErrorCode.NotFound, 'missing_table'],
      [
        'SELECT * FROM information_schema.tables',
        JsonRpcErrorCode.ValidationError,
        'system_catalog_access',
      ],
    ])('surfaces the gate refusal of %s unchanged', async (sql, code, reason) => {
      const query = vi.spyOn(provider, 'query');
      const err = await wireError(
        openmeteoDataframeQueryTool,
        { canvas_id: canvasId, sql },
        { context: { tenantId: TENANT } },
      );
      expect(err.code).toBe(code);
      expect(err.data?.reason).toBe(reason);
      expect(query).toHaveBeenCalledTimes(1);
    });
  });

  describe('paging (#94)', () => {
    /** The canvas's own read of `sql`, under its 10,000-row limit — independent of the tool. */
    const directRows = async (sql: string) =>
      (await canvas.acquire(canvasId, createMockContext({ tenantId: TENANT }))).query(sql);

    /**
     * Walks `SELECT * FROM hist ORDER BY time LIMIT <limit> OFFSET <offset>` the way the
     * continuation notice directs: each page's OFFSET grows by the rows it showed and its
     * LIMIT shrinks by them, until a page carries no notice.
     */
    async function walk(sqlLimit: number, sqlOffset: number, limit?: number) {
      const pages: number[] = [];
      const rows: Record<string, unknown>[] = [];
      let remaining = sqlLimit;
      let offset = sqlOffset;
      for (;;) {
        const s = surfaces(
          await run(`SELECT * FROM hist ORDER BY time LIMIT ${remaining} OFFSET ${offset}`, limit),
        );
        rows.push(...s.structured.rows);
        pages.push(s.structured.rows.length);
        const next = /Continue at OFFSET (\d+)/.exec(s.text);
        if (!next) return { pages, rows };
        const shown = Number(next[1]);
        expect(shown).toBe(s.structured.rows.length);
        expect(s.structured.row_count).toBe(remaining);
        remaining -= shown;
        offset += shown;
      }
    }

    it.each([
      [150, 0],
      [150, 20],
    ])(
      'follows the continuation notice through LIMIT %i OFFSET %i, matching one direct read row for row',
      async (sqlLimit, sqlOffset) => {
        const { pages, rows } = await walk(sqlLimit, sqlOffset);
        expect(pages.length).toBeGreaterThan(1);
        const direct = await directRows(
          `SELECT * FROM hist ORDER BY time LIMIT ${sqlLimit} OFFSET ${sqlOffset}`,
        );
        expect(rows).toEqual(direct.rows);
      },
    );

    const memberExample = [
      ...(openmeteoDataframeQueryTool.input.shape.sql.description ?? '').matchAll(
        /`(SELECT [^`]+)`/g,
      ),
    ]
      .map((m) => m[1] as string)
      .find((sql) => sql.includes('COLUMNS(')) as string;

    beforeAll(async () => {
      const instance = await canvas.acquire(canvasId, createMockContext({ tenantId: TENANT }));
      // 240 hourly rows of ten precipitation members: the member example's row count.
      await instance.registerTable(
        'ens240',
        hourlyTimes(240).map((time, i) => {
          const row: Record<string, unknown> = { time, precipitation: round1((i % 9) / 10) };
          for (let m = 1; m <= 10; m++) {
            row[`precipitation_member${String(m).padStart(2, '0')}`] = round1(((i * m) % 9) / 10);
          }
          return row;
        }),
      );
      // 360 hourly rows of 64 temperature members: one list() per member runs past 80,000 characters.
      await instance.registerTable(
        'ens64',
        hourlyTimes(360).map((time, i) => {
          const row: Record<string, unknown> = { time, temperature_2m: round1(10 + (i % 13) / 3) };
          for (let m = 1; m <= 64; m++) {
            row[`temperature_2m_member${String(m).padStart(2, '0')}`] = round1(
              10 + ((i + m) % 13) / 3,
            );
          }
          return row;
        }),
      );
    });

    it('returns limit 240 member counts whole, with no notice', async () => {
      const s = surfaces(await run(memberExample.replaceAll('<table_name>', 'ens240'), 240));
      expect(s.structured.rows).toHaveLength(240);
      expect(s.structured.row_count).toBe(240);
      expect(s.structured.truncated).toBe(false);
      expect(s.text).toContain('**Rows:** 240 | **Truncated:** false');
      expect(s.structured.rows.map((row) => Number(row.members_reporting))).toEqual(
        Array(240).fill(10),
      );
      expect(s.structured).not.toHaveProperty('notice');
      expect(s.text).not.toContain('Showing first');
      expect(s.blocks).toBe(1);
    });

    it('returns one row and a continuation at OFFSET 1 under limit 1', async () => {
      const s = surfaces(await run('SELECT * FROM u ORDER BY k', 1));
      // `k` is staged as BIGINT, which DuckDB marshals as a string.
      expect(s.structured.rows).toEqual([{ k: '1' }]);
      expect(s.structured.row_count).toBe(3);
      expect(s.text).toContain('Showing first 1 of 3 rows (limit 1). Continue at OFFSET 1:');
    });

    it.each([
      [150, 0],
      [150, 20],
    ])(
      'pages LIMIT %i OFFSET %i at limit 100 in two calls, matching one direct read',
      async (sqlLimit, sqlOffset) => {
        const { pages, rows } = await walk(sqlLimit, sqlOffset, 100);
        expect(pages).toEqual([100, 50]);
        const direct = await directRows(
          `SELECT * FROM hist ORDER BY time LIMIT ${sqlLimit} OFFSET ${sqlOffset}`,
        );
        expect(rows).toEqual(direct.rows);
      },
    );

    it.each([150, 200])(
      'returns the SQL LIMIT 150 rows whole under limit %i, with no notice and no count',
      async (limit) => {
        const query = vi.spyOn(provider, 'query');
        const s = surfaces(await run('SELECT * FROM hist ORDER BY time LIMIT 150', limit));
        expect(s.structured.rows).toHaveLength(150);
        expect(s.structured.row_count).toBe(150);
        expect(s.text).not.toContain('Showing first');
        expect(query).toHaveBeenCalledTimes(1);
        expect(query.mock.calls[0]?.[3]).toMatchObject({ rowLimit: limit });
      },
    );

    it('lowers limit 20000 to the 10,000-row cap and says so on both surfaces', async () => {
      const query = vi.spyOn(provider, 'query');
      const result = await run('SELECT * FROM hist CROSS JOIN u', 20000);
      const s = surfaces(result);
      const notice =
        'limit 20000 is above the per-call cap of 10000 rows, so 10000 was applied. To read more than 10000 rows, page with LIMIT / OFFSET in the SQL.';
      expect(s.structured.rows).toHaveLength(10000);
      expect(s.structured.row_count).toBe(26352);
      expect(s.structured).toMatchObject({ notice });
      expect(result.content[1]).toEqual({ type: 'text', text: `\n\n> ${notice}` });
      expect(query.mock.calls[0]?.[3]).toMatchObject({ rowLimit: 10000 });
      expect(s.text).toContain(
        'Showing first 10000 of 26352 rows (limit 10000). Continue at OFFSET 10000:',
      );
    });

    it('logs one info line and adds one to the clamp counter per clamped call, and neither otherwise', async () => {
      const call = async (limit: number) => {
        const ctx = createMockContext({
          tenantId: TENANT,
          errors: openmeteoDataframeQueryTool.errors,
        });
        const input = openmeteoDataframeQueryTool.input.parse({
          canvas_id: canvasId,
          sql: 'SELECT * FROM u',
          limit,
        });
        await openmeteoDataframeQueryTool.handler(input, ctx);
        const lowered = (ctx.log as MockContextLogger).calls.filter(
          (c) => c.msg === 'Dataframe query limit lowered to the cap',
        );
        return { lowered, enrichment: getEnrichment(ctx) };
      };

      clampCounter.add.mockClear();
      const clamped = await call(20000);
      expect(clamped.lowered).toEqual([
        {
          level: 'info',
          msg: 'Dataframe query limit lowered to the cap',
          data: expect.objectContaining({ requested: 20000, applied: 10000 }),
        },
      ]);
      expect(clampCounter.add).toHaveBeenCalledTimes(1);
      expect(clampCounter.add).toHaveBeenCalledWith(1);
      expect(clamped.enrichment).toEqual({
        notice:
          'limit 20000 is above the per-call cap of 10000 rows, so 10000 was applied. To read more than 10000 rows, page with LIMIT / OFFSET in the SQL.',
      });

      clampCounter.add.mockClear();
      const atCap = await call(10000);
      expect(atCap.lowered).toEqual([]);
      expect(clampCounter.add).not.toHaveBeenCalled();
      expect(atCap.enrichment).toEqual({});
    });

    it('caps limit at a lowered CANVAS_DEFAULT_ROW_LIMIT, so the canvas never gets a rowLimit it refuses', async () => {
      resetConfig({ CANVAS_DEFAULT_ROW_LIMIT: '500' });
      const small = new DuckdbProvider({
        defaultRowLimit: 500,
        exportRootPath: exportRoot,
        memoryLimitMb: 256,
        schemaSniffRows: 100,
      });
      const smallCanvas = new DataCanvas(
        small,
        new CanvasRegistry(small, { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, sweeperIntervalMs: 0 }),
      );
      try {
        const instance = await smallCanvas.acquire(
          undefined,
          createMockContext({ tenantId: TENANT }),
        );
        await instance.registerTable(
          'n',
          Array.from({ length: 600 }, (_, i) => ({ i })),
        );
        mockCanvasInstance = smallCanvas;
        const query = vi.spyOn(small, 'query');
        const result = await runToolContract(
          openmeteoDataframeQueryTool,
          { canvas_id: instance.canvasId, sql: 'SELECT * FROM n ORDER BY i', limit: 1000 },
          { context: { tenantId: TENANT } },
        );
        expect(result.isError).toBeFalsy();
        const s = surfaces(result);
        expect(s.structured.rows).toHaveLength(500);
        expect(s.structured.row_count).toBe(600);
        expect(s.structured).toMatchObject({
          notice:
            'limit 1000 is above the per-call cap of 500 rows, so 500 was applied. To read more than 500 rows, page with LIMIT / OFFSET in the SQL.',
        });
        expect(query.mock.calls[0]?.[3]).toMatchObject({ rowLimit: 500 });
      } finally {
        await smallCanvas.shutdown(createMockContext({ tenantId: TENANT }));
        resetConfig();
      }
    });

    it('applies a cap below 25 as the default, with no notice for a call that sent no limit', async () => {
      resetConfig({ CANVAS_DEFAULT_ROW_LIMIT: '5' });
      const small = new DuckdbProvider({
        defaultRowLimit: 5,
        exportRootPath: exportRoot,
        memoryLimitMb: 256,
        schemaSniffRows: 100,
      });
      const smallCanvas = new DataCanvas(
        small,
        new CanvasRegistry(small, { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, sweeperIntervalMs: 0 }),
      );
      try {
        const instance = await smallCanvas.acquire(
          undefined,
          createMockContext({ tenantId: TENANT }),
        );
        await instance.registerTable(
          'n',
          Array.from({ length: 8 }, (_, i) => ({ i })),
        );
        mockCanvasInstance = smallCanvas;
        const query = vi.spyOn(small, 'query');
        const result = await runToolContract(
          openmeteoDataframeQueryTool,
          { canvas_id: instance.canvasId, sql: 'SELECT * FROM n ORDER BY i' },
          { context: { tenantId: TENANT } },
        );
        expect(result.isError).toBeFalsy();
        const s = surfaces(result);
        expect(s.structured.rows).toHaveLength(5);
        expect(s.structured.row_count).toBe(8);
        expect(s.structured).not.toHaveProperty('notice');
        expect(s.text).not.toContain('above the per-call cap');
        expect(query.mock.calls[0]?.[3]).toMatchObject({ rowLimit: 5 });
      } finally {
        await smallCanvas.shutdown(createMockContext({ tenantId: TENANT }));
        resetConfig();
      }
    });

    it('returns a row wider than 80,000 characters whole on both surfaces', async () => {
      const s = surfaces(
        await run("SELECT list(COLUMNS('^temperature_2m_member\\d+$') ORDER BY time) FROM ens64"),
      );
      expect(s.structured.rows).toHaveLength(1);
      const values = Object.values(s.structured.rows[0] ?? {});
      expect(values).toHaveLength(64);
      for (const value of values) expect(value).toHaveLength(360);
      expect(s.structuredChars).toBeGreaterThan(80_000);
      expect(gfmTable(s.text)[1]?.map((cell) => cell.text)).toEqual(
        values.map((value) => JSON.stringify(value)),
      );
    });

    it('returns no rows and no notice for an empty result or an OFFSET past the end under limit 5', async () => {
      for (const sql of ['SELECT * FROM hist WHERE false', 'SELECT * FROM hist OFFSET 100000']) {
        const s = surfaces(await run(sql, 5));
        expect(s.structured).toStrictEqual({
          rows: [],
          row_count: 0,
          truncated: false,
          canvas_id: canvasId,
        });
        expect(s.text).toContain('**Rows:** 0 | **Truncated:** false');
        expect(s.text).toContain('No rows returned');
      }
    });
  });

  describe('response ceiling and relayed error text', () => {
    it('refuses a page just over 8,000,000 characters of row data before counting the result', async () => {
      // Three rows of `u`, so the page of two is truncated and a count would follow it.
      const query = vi.spyOn(provider, 'query');
      const result = await run("SELECT repeat('x', 4500000) AS note FROM u", 2);
      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: WireError }).error;
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message:
          'This page of 2 rows holds more than 8,000,000 characters of row data, the most one response carries, and rows are never cut; its first row fits.',
        data: {
          reason: 'result_too_large',
          recovery: {
            hint: 'Set limit to 1 or less and page the rest with LIMIT / OFFSET, or select fewer columns.',
          },
        },
      });
      expect(query).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        'an execution error quoting a computed value',
        "SELECT error(repeat('x', 5000))",
        JsonRpcErrorCode.ValidationError,
        'sql_execution_error',
      ],
      [
        'a binder error quoting a column name',
        `SELECT "${'a'.repeat(5000)}" FROM u`,
        JsonRpcErrorCode.ValidationError,
        'invalid_sql',
      ],
      [
        'a missing table with a long name',
        `SELECT * FROM "${'a'.repeat(5000)}"`,
        JsonRpcErrorCode.NotFound,
        'missing_table',
      ],
      [
        'a system catalog with a long name',
        `SELECT duckdb_${'a'.repeat(5000)}()`,
        JsonRpcErrorCode.ValidationError,
        'system_catalog_access',
      ],
      [
        'a denied function with a long name',
        `SELECT * FROM pragma_${'a'.repeat(5000)}()`,
        JsonRpcErrorCode.ValidationError,
        'denied_function',
      ],
    ])(
      'relays %s cut to 2,000 characters, with its code and reason',
      async (_path, sql, code, reason) => {
        const result = await run(sql);
        expect(result.isError).toBe(true);
        const error = (result.structuredContent as { error: WireError }).error;
        expect(error.code).toBe(code);
        expect(error.data?.reason).toBe(reason);
        expect(error.message.length).toBeLessThanOrEqual(2_000);
        expect(error.message).toMatch(/ … \(cut to 2,000 of [\d,]+ characters\)$/);
        for (const value of Object.values(error.data ?? {})) {
          if (typeof value === 'string') expect(value.length).toBeLessThanOrEqual(2_000);
        }
        expect(firstText(result.content).length).toBeLessThan(3_000);
      },
    );
  });
});
