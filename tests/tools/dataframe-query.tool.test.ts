/**
 * @fileoverview Tests for openmeteo_dataframe_query tool.
 * @module tests/tools/dataframe-query.tool.test
 */

import { JsonRpcErrorCode, notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoDataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';

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
          canvasId: 'totallyfakecanvas999',
        }),
      ),
    };
    const ctx = createMockContext({ errors: openmeteoDataframeQueryTool.errors });
    const input = openmeteoDataframeQueryTool.input.parse({
      canvas_id: 'totallyfakecanvas999',
      sql: 'SELECT 1',
    });
    await expect(openmeteoDataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.not.stringContaining('Omit canvas_id'),
      data: {
        reason: 'canvas_not_found',
        recovery: {
          hint: expect.stringContaining(
            'openmeteo_get_historical, openmeteo_get_ensemble, or openmeteo_get_climate',
          ),
        },
      },
    });
  });

  it('rewraps the framework system_catalog_access error with the declared recovery hint', async () => {
    // Real framework throw shape (sqlGate.assertNoSystemCatalogs): a ValidationError
    // with data.reason but NO recovery of its own — the tool's declared recovery is
    // the only possible source of a hint on this path.
    const mockInstance = {
      canvasId: 'testcanvas01',
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

    const ctx = createMockContext({ errors: openmeteoDataframeQueryTool.errors });
    const input = openmeteoDataframeQueryTool.input.parse({
      canvas_id: 'testcanvas01',
      sql: 'SELECT * FROM information_schema.tables',
    });
    await expect(openmeteoDataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
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
      canvasId: 'testcanvas01',
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

    const ctx = createMockContext({ errors: openmeteoDataframeQueryTool.errors });
    const input = openmeteoDataframeQueryTool.input.parse({
      canvas_id: 'testcanvas01',
      sql: 'SELECT COUNT(*) FROM spillover_0',
    });

    const err = (await openmeteoDataframeQueryTool
      .handler(input, ctx)
      .catch((e: unknown) => e)) as {
      code: number;
      message: string;
      data: { reason: string; recovery: { hint: string } };
    };
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data.reason).toBe('missing_table');
    expect(err.message).toContain('spillover_0');
    expect(err.data.recovery.hint).toContain('openmeteo_dataframe_describe');
    // The framework leak is gone from both the message and the recovery hint.
    expect(err.data.recovery.hint).not.toContain('registerTable');
    expect(err.data.recovery.hint).not.toContain('describe()');
    expect(err.message).not.toContain('describe()');
  });

  it('passes non-target query errors (invalid_sql) through unchanged', async () => {
    // A ValidationError with a different reason must not be reclassified — consumers
    // key on code + data.reason, and the binder detail must survive.
    const mockInstance = {
      canvasId: 'testcanvas01',
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
      canvas_id: 'testcanvas01',
      sql: 'SELECT tempxyz FROM spilled_testcanvas01',
    });
    await expect(openmeteoDataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_sql', binderMessage: expect.stringContaining('tempxyz') },
    });
  });

  it('returns rows and row_count from a valid query', async () => {
    const mockInstance = {
      canvasId: 'testcanvas01',
      query: vi.fn().mockResolvedValue({ rows: MOCK_ROWS, rowCount: 2 }),
    };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext();
    const input = openmeteoDataframeQueryTool.input.parse({
      canvas_id: 'testcanvas01',
      sql: 'SELECT time, temperature_2m FROM spilled_testcanvas01 LIMIT 2',
    });
    const result = await openmeteoDataframeQueryTool.handler(input, ctx);

    expect(result.canvas_id).toBe('testcanvas01');
    expect(result.rows).toHaveLength(2);
    expect(result.row_count).toBe(2);
    expect(result.rows[0]).toEqual({ time: '2020-01-01T00:00', temperature_2m: -2.3 });
    expect(mockInstance.query).toHaveBeenCalledWith(
      'SELECT time, temperature_2m FROM spilled_testcanvas01 LIMIT 2',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('caps returned rows to the 100-row preview while row_count reflects the full result', async () => {
    // Handler-side symmetric cap (#16): the canvas may hold up to its 10k row limit,
    // but the tool returns at most a 100-row preview on both surfaces. row_count stays
    // the true total so the agent knows to page the rest with SQL LIMIT / OFFSET.
    const fullRows = Array.from({ length: 250 }, (_, i) => ({ i, v: i * 2 }));
    const mockInstance = {
      canvasId: 'testcanvas01',
      query: vi.fn().mockResolvedValue({ rows: fullRows, rowCount: 250 }),
    };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext();
    const input = openmeteoDataframeQueryTool.input.parse({
      canvas_id: 'testcanvas01',
      sql: 'SELECT i, v FROM spilled_testcanvas01',
    });
    const result = await openmeteoDataframeQueryTool.handler(input, ctx);

    expect(result.rows).toHaveLength(100); // preview cap, not the 250 materialized rows
    expect(result.row_count).toBe(250); // true total preserved for paging guidance
    expect(result.rows[0]).toEqual({ i: 0, v: 0 });
    expect(result.rows[99]).toEqual({ i: 99, v: 198 });
  });

  it('passes canvas_id to canvas.acquire', async () => {
    const mockInstance = {
      canvasId: 'mycanvasid1',
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    };
    const mockAcquire = vi.fn().mockResolvedValue(mockInstance);
    mockCanvasInstance = { acquire: mockAcquire };

    const ctx = createMockContext();
    const input = openmeteoDataframeQueryTool.input.parse({
      canvas_id: 'mycanvasid1',
      sql: 'SELECT COUNT(*) AS n FROM spilled_mycanvasid1',
    });
    await openmeteoDataframeQueryTool.handler(input, ctx);

    expect(mockAcquire).toHaveBeenCalledWith('mycanvasid1', ctx);
  });

  it('formats empty result correctly', () => {
    const blocks = openmeteoDataframeQueryTool.format!({
      canvas_id: 'testcanvas01',
      rows: [],
      row_count: 0,
    });
    expect(blocks[0]?.text).toContain('testcanvas01');
    expect(blocks[0]?.text).toContain('No rows returned');
  });

  it('formats result rows as a markdown table', () => {
    const blocks = openmeteoDataframeQueryTool.format!({
      canvas_id: 'testcanvas01',
      rows: [
        { time: '2020-01', avg_temp: -1.5 },
        { time: '2020-02', avg_temp: 2.1 },
      ],
      row_count: 2,
    });
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('testcanvas01');
    expect(text).toContain('time');
    expect(text).toContain('avg_temp');
    expect(text).toContain('-1.5');
    expect(text).toContain('2.1');
  });

  it('shows truncation notice when row_count exceeds 100', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      time: `2020-01-${String(i + 1).padStart(2, '0')}`,
      v: i,
    }));
    const blocks = openmeteoDataframeQueryTool.format!({
      canvas_id: 'testcanvas01',
      rows,
      row_count: 150,
    });
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('Showing first 100 of 150 rows');
    expect(text).toContain('LIMIT / OFFSET');
  });
});
