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
import { JsonRpcErrorCode, notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoDataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { INLINE_CHARS } from '@/mcp-server/tools/spill-utils.js';
import { firstText } from '../helpers/content.js';
import { wireError } from '../helpers/wire-error.js';

// Canvas mock — returns undefined by default; individual tests override
let mockCanvasInstance: unknown;

vi.mock('@/services/canvas-accessor.js', () => ({
  getCanvas: () => mockCanvasInstance,
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

  it('caps returned rows to the 100-row preview while row_count reflects the full result', async () => {
    // Handler-side symmetric cap (#16): the canvas may hold up to its 10k row limit,
    // but the tool returns at most a 100-row preview on both surfaces. row_count stays
    // the true total so the agent knows to page the rest with SQL LIMIT / OFFSET.
    const fullRows = Array.from({ length: 250 }, (_, i) => ({ i, v: i * 2 }));
    const mockInstance = {
      canvasId: 'testCanv01',
      query: vi.fn().mockResolvedValue({ rows: fullRows, rowCount: 250 }),
    };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext({ errors: openmeteoDataframeQueryTool.errors });
    const input = openmeteoDataframeQueryTool.input.parse({
      canvas_id: 'testCanv01',
      sql: 'SELECT i, v FROM spilled_testCanv01',
    });
    const result = await openmeteoDataframeQueryTool.handler(input, ctx);

    expect(result.rows).toHaveLength(100); // preview cap, not the 250 materialized rows
    expect(result.row_count).toBe(250); // true total preserved for paging guidance
    expect(result.rows[0]).toEqual({ i: 0, v: 0 });
    expect(result.rows[99]).toEqual({ i: 99, v: 198 });
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
      }),
    );
    expect(text).toContain('| {"temp":3.6,"rain":0} | [3.6,0] |');
    expect(text).toContain('| {"temp":3.2,"rain":0} | [3.2,0] |');
    expect(text).not.toContain('[object Object]');
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
    });
    const text = firstText(blocks) ?? '';
    expect(text).toContain('Showing first 100 of 150 rows');
    expect(text).toContain('LIMIT / OFFSET');
  });

  it('names the size ceiling and the next OFFSET when fewer than 100 rows fit (#65)', () => {
    const text = firstText(
      openmeteoDataframeQueryTool.format!({
        canvas_id: 'testCanv01',
        rows: [{ v: 1 }, { v: 2 }, { v: 3 }],
        row_count: 8784,
      }),
    );
    expect(text).toContain('Showing first 3 of 8784 rows');
    expect(text).toContain('80,000-character inline ceiling');
    expect(text).toContain('Continue at OFFSET 3');
    expect(text).not.toContain('OFFSET 100');
  });

  it('tells the caller to shrink any LIMIT by the rows shown and to page under an ORDER BY (#65)', () => {
    const text = firstText(
      openmeteoDataframeQueryTool.format!({
        canvas_id: 'testCanv01',
        rows: Array.from({ length: 100 }, (_, i) => ({ v: i })),
        row_count: 250,
      }),
    );
    expect(text.split('\n').at(-1)).toBe(
      '_Showing first 100 of 250 rows (the 100-row inline cap). Continue at OFFSET 100: re-issue the SQL with LIMIT / OFFSET, adding 100 to any OFFSET it already applies and subtracting it from any LIMIT. Page under an ORDER BY: without one, DuckDB guarantees no row order between calls._',
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
      }),
    );

  it('keeps a newline-bearing value on one table row, escaped', () => {
    const text = render([{ note: '<b>**A**\nB</b>' }]);
    expect(tableLines(text)).toEqual(['| note |', '| --- |', '| <b>**A**\\nB</b> |']);
  });

  it('escapes pipes and newlines in column names so the header parses as a table', () => {
    const text = render([{ 'a|b': 1, 'line\nbreak': 'x' }]);
    const lines = tableLines(text);
    expect(lines[0]).toBe('| a\\|b | line\\nbreak |');
    expect(lines.map((line) => gfmCells(line).length)).toEqual([2, 2, 2]);
  });

  it('renders the empty string as "" and null as an empty cell', () => {
    const text = render([{ n: null, e: '' }]);
    expect(tableLines(text)[2]).toBe('|  | "" |');
  });

  it('escapes backslashes, carriage returns, and quotes with JSON string escaping', () => {
    const text = render([{ bs: 'x\\|y', crlf: '\r\n', q: 'say "hi"', tab: 'a\tb' }]);
    const row = tableLines(text)[2] ?? '';
    expect(row).toBe('| x\\\\\\|y | \\r\\n | say \\"hi\\" | a\\tb |');
    // The escaped backslash is consumed as its own pair, so the pipe stays escaped:
    // one cell per column, and the cell reads back as the original value.
    expect(gfmCells(row)).toHaveLength(4);
  });

  describe('characters JSON escaping leaves bare', () => {
    /** The `\uXXXX` escape text a cell carries in place of the character `code`. */
    const escapeOf = (code: number) => `\\u${code.toString(16).padStart(4, '0')}`;
    const LINE_SEPARATOR = String.fromCharCode(0x2028);
    const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
    const NBSP = String.fromCharCode(0xa0);
    const SPACE = escapeOf(0x20);

    it.each([
      ['a line separator', `a${LINE_SEPARATOR}b`, `a${escapeOf(0x2028)}b`],
      ['a paragraph separator', `a${PARAGRAPH_SEPARATOR}b`, `a${escapeOf(0x2029)}b`],
      ['a lone no-break space', NBSP, escapeOf(0xa0)],
      ['a no-break space between words', `a${NBSP}b`, `a${escapeOf(0xa0)}b`],
      ['a single space', ' ', SPACE],
      ['leading and trailing spaces', '  pad  ', `${SPACE}${SPACE}pad${SPACE}${SPACE}`],
      ['a space inside a value', 'a b', 'a b'],
    ])('renders %s as its escape, on one row the parser cannot trim', (_label, value, cell) => {
      const lines = tableLines(render([{ v: value, n: null }]));
      expect(lines[2]).toBe(`| ${cell} |  |`);
      expect(lines).toHaveLength(3);
    });

    it('keeps a single space distinct from null and from the empty string', () => {
      const lines = tableLines(render([{ space: ' ', empty: '', missing: null }]));
      expect(lines[2]).toBe(`| ${SPACE} | "" |  |`);
      expect(gfmCells(lines[2] ?? '')).toEqual([SPACE, '""', '']);
    });

    it('escapes the same characters in a column name', () => {
      const lines = tableLines(render([{ ' padded ': 1, [`x${LINE_SEPARATOR}y`]: 2 }]));
      expect(lines[0]).toBe(`| ${SPACE}padded${SPACE} | x${escapeOf(0x2028)}y |`);
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
    expect(tableLines(firstText(result.content))[2]).toBe('| a\\|b\\nc | "" |  |');
  });
});

/** Hourly timestamps for a leap year, as Open-Meteo stages them: `YYYY-MM-DDTHH:MM`. */
function hourlyTimes(count: number): string[] {
  const start = Date.UTC(2024, 0, 1);
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

  const run = (sql: string) =>
    runToolContract(
      openmeteoDataframeQueryTool,
      { canvas_id: canvasId, sql },
      { context: { tenantId: TENANT } },
    );

  type Structured = { rows: Record<string, unknown>[]; row_count: number; count_error?: string };

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

  describe('inline size ceiling (#65)', () => {
    it('fails a first row wider than the ceiling as row_too_large, with no partial value', async () => {
      const err = await wireError(
        openmeteoDataframeQueryTool,
        { canvas_id: canvasId, sql: "SELECT repeat('x', 150000) AS note" },
        { context: { tenantId: TENANT } },
      );
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data?.reason).toBe('row_too_large');
      expect(err.message).toMatch(/needs 150,0\d\d characters inline/);
      expect(err.data?.recovery?.hint).toContain('left()');
      expect(err.data?.recovery?.hint).toContain('list_slice()');
      expect(JSON.stringify(err)).not.toContain('x'.repeat(100));
    });

    it('takes whole wide rows up to the ceiling on both surfaces, never cutting a value', async () => {
      const result = await run("SELECT repeat('x', 10000) AS note FROM hist");
      const s = surfaces(result);
      expect(s.structuredChars).toBeLessThanOrEqual(INLINE_CHARS);
      expect(s.textChars).toBeLessThanOrEqual(INLINE_CHARS);
      expect(s.blocks).toBe(1);
      expect(s.contentTotal).toBeLessThanOrEqual(INLINE_CHARS);
      const shown = s.structured.rows.length;
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThan(100);
      // Tight packing: one more 10,000-character row would have crossed the ceiling.
      expect(s.textChars + 10_000).toBeGreaterThan(INLINE_CHARS);
      for (const row of s.structured.rows) expect(row.note).toHaveLength(10_000);
      expect(s.structured.row_count).toBe(8784);
      expect(tableLines(s.text)).toHaveLength(shown + 2);
      expect(s.text).toContain(`Showing first ${shown} of 8784 rows`);
      expect(s.text).toContain('80,000-character inline ceiling');
      expect(s.text).toContain(`Continue at OFFSET ${shown}`);
    });

    it('bounds SELECT * on a 154-column ensemble table with identical rows on both surfaces', async () => {
      const s = surfaces(await run('SELECT * FROM ens'));
      expect(s.structuredChars).toBeLessThanOrEqual(INLINE_CHARS);
      expect(s.textChars).toBeLessThanOrEqual(INLINE_CHARS);
      const shown = s.structured.rows.length;
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThan(100);
      expect(s.structured.row_count).toBe(168);
      const lines = tableLines(s.text);
      expect(lines).toHaveLength(shown + 2);
      expect(lines.map((line) => gfmCells(line).length)).toEqual(Array(shown + 2).fill(154));
      s.structured.rows.forEach((row, i) => {
        expect(gfmCells(lines[i + 2] ?? '')).toEqual(Object.values(row).map(String));
      });
    });

    it('reserves room for the size notice when a result under 100 rows does not fit whole', async () => {
      // Eight rows fill the ceiling with less slack than the notice takes, and the exact
      // row_count (50) is under the row cap, so only the size-ceiling notice can appear.
      const width = Math.floor((INLINE_CHARS - 200) / 8) - 12;
      const s = surfaces(await run(`SELECT repeat('x', ${width}) AS note FROM hist LIMIT 50`));
      expect(s.structured.row_count).toBe(50);
      expect(s.structured.rows.length).toBeLessThan(50);
      expect(s.text).toContain(`Showing first ${s.structured.rows.length} of 50 rows`);
      expect(s.textChars).toBeLessThanOrEqual(INLINE_CHARS);
      expect(s.contentTotal).toBeLessThanOrEqual(INLINE_CHARS);
    });

    it('charges a row its rendered line when escaping makes it wider than its JSON', async () => {
      // 30,000 pipes: ~30,000 characters of JSON but ~60,000 rendered (`\|` each), so a
      // JSON-only charge would admit both rows and render ~120,000 characters.
      const s = surfaces(await run("SELECT repeat('|', 30000) AS p FROM u ORDER BY k LIMIT 2"));
      expect(s.structured.rows).toHaveLength(1);
      expect(s.structured.row_count).toBe(2);
      expect(s.textChars).toBeLessThanOrEqual(INLINE_CHARS);
      expect(s.text).toContain('Continue at OFFSET 1');
    });

    it('charges a row its JSON when long column names make it wider than its rendered line', async () => {
      // The alias repeats in every JSON row but renders once, in the header.
      const alias = 'a'.repeat(1_000);
      const s = surfaces(await run(`SELECT temperature_2m AS "${alias}" FROM hist`));
      expect(s.structuredChars).toBeLessThanOrEqual(INLINE_CHARS);
      expect(s.structured.rows.length).toBeGreaterThan(0);
      expect(s.structured.rows.length).toBeLessThan(100);
      expect(s.structured.row_count).toBe(8784);
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

    it('returns the first 100 of 8784 rows for SELECT * over a one-variable hourly table', async () => {
      const s = surfaces(await run('SELECT * FROM hist'));
      expect(s.structured.rows).toHaveLength(100);
      expect(s.structured.row_count).toBe(8784);
      expect(s.text).toContain('Showing first 100 of 8784 rows');
    });

    it('returns a whole-year list() as one row', async () => {
      const s = surfaces(await run('SELECT list(temperature_2m) AS temps FROM hist'));
      expect(s.structured.rows).toHaveLength(1);
      expect(s.structured.rows[0]?.temps).toHaveLength(8784);
      expect(s.structuredChars).toBeLessThanOrEqual(INLINE_CHARS);
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

  describe('exact row_count (#72)', () => {
    it('counts a result past the canvas 10,000-row limit exactly', async () => {
      const s = surfaces(await run('SELECT * FROM hist CROSS JOIN u'));
      expect(s.structured.row_count).toBe(26352);
      expect(s.structured.count_error).toBeUndefined();
      expect(s.structured.rows).toHaveLength(100);
      expect(s.text).toContain('Showing first 100 of 26352 rows');
    });

    it('materializes no more rows than the preview, then counts through the same gate', async () => {
      const query = vi.spyOn(provider, 'query');
      await run('SELECT * FROM hist CROSS JOIN u;\n ');
      expect(query).toHaveBeenCalledTimes(2);
      const [dataCall, countCall] = query.mock.calls;
      expect(dataCall?.[3]).toMatchObject({ rowLimit: 100, denySystemCatalogs: true });
      const dataResult = await query.mock.results[0]?.value;
      expect(dataResult.rows.length).toBeLessThanOrEqual(100);
      expect(countCall?.[1]).toBe(
        'SELECT COUNT(*) AS n FROM (\nSELECT * FROM hist CROSS JOIN u\n)',
      );
      expect(countCall?.[3]).toMatchObject({ denySystemCatalogs: true });
    });

    it('runs no count query when the result fits the preview', async () => {
      const query = vi.spyOn(provider, 'query');
      const s = surfaces(await run('SELECT * FROM hist LIMIT 100'));
      expect(query).toHaveBeenCalledTimes(1);
      expect(s.structured.rows).toHaveLength(100);
      expect(s.structured.row_count).toBe(100);
      expect(s.text).not.toContain('Showing first');
    });

    it('keeps the rows and reports a lower bound when the count query fails', async () => {
      // The trailing comment after `;` passes on its own but leaves the wrapped
      // count unparseable — a real count-only failure.
      const s = surfaces(await run('SELECT * FROM hist; -- whole year'));
      expect(s.structured.rows).toHaveLength(100);
      expect(s.structured.row_count).toBe(101);
      expect(s.structured.count_error).toBe('invalid_sql');
      expect(s.text).toContain('at least 101 (the full result could not be counted: invalid_sql)');
      expect(s.text).toContain('Showing first 100 of at least 101 rows');
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
      expect(s.structured).toMatchObject({ row_count: 101, count_error: 'sql_execution_error' });
      expect(s.structured.rows).toHaveLength(100);
    });

    /**
     * A three-way cross join of the staged tables: 231 million rows the preview streams
     * its first 100 of at once, and that a full COUNT(*) takes far longer than the
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
      expect(s.structured.rows).toHaveLength(100);
      expect(s.structured).toMatchObject({ row_count: 101, count_error: 'count_timeout' });
      expect(s.text).toContain(
        'at least 101 (the full result could not be counted: count_timeout)',
      );
      expect(s.text).toContain('Showing first 100 of at least 101 rows');
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
});
