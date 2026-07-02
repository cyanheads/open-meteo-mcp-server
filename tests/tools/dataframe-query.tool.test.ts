/**
 * @fileoverview Tests for openmeteo_dataframe_query tool.
 * @module tests/tools/dataframe-query.tool.test
 */

import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
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
          hint: expect.stringContaining('openmeteo_get_historical or openmeteo_get_ensemble'),
        },
      },
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
    expect(text).toContain('Showing 100 of 150 rows');
  });
});
