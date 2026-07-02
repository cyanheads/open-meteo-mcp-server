/**
 * @fileoverview Tests for openmeteo_dataframe_describe tool.
 * @module tests/tools/dataframe-describe.tool.test
 */

import { JsonRpcErrorCode, McpError, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoDataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';

// Canvas mock — returns undefined by default; individual tests override
let mockCanvasInstance: unknown;

vi.mock('@/services/canvas-accessor.js', () => ({
  getCanvas: () => mockCanvasInstance,
}));

const MOCK_TABLE_INFO = [
  {
    name: 'spilled_abc1234567',
    kind: 'table' as const,
    rowCount: 8760,
    columns: [
      { name: 'time', type: 'VARCHAR', nullable: false },
      { name: 'temperature_2m', type: 'DOUBLE', nullable: true },
      { name: 'precipitation', type: 'DOUBLE', nullable: true },
    ],
  },
];

describe('openmeteoDataframeDescribeTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasInstance = undefined;
  });

  it('throws canvas_not_enabled when canvas is not configured', async () => {
    mockCanvasInstance = undefined;
    const ctx = createMockContext({ errors: openmeteoDataframeDescribeTool.errors });
    const input = openmeteoDataframeDescribeTool.input.parse({ canvas_id: 'abc1234567' });
    await expect(openmeteoDataframeDescribeTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      data: { reason: 'canvas_not_enabled' },
    });
  });

  it('rethrows the framework acquire() NotFound as canvas_not_found with the tool recovery', async () => {
    // Framework message on unknown/expired id — its "omit canvas_id" guidance is
    // wrong for this tool (canvas_id is required) and must not leak through.
    mockCanvasInstance = {
      acquire: vi.fn().mockRejectedValue(
        notFound('Canvas not found or expired. Omit canvas_id to start a new canvas.', {
          canvasId: 'totallyfakecanvas999',
        }),
      ),
    };
    const ctx = createMockContext({ errors: openmeteoDataframeDescribeTool.errors });
    const input = openmeteoDataframeDescribeTool.input.parse({
      canvas_id: 'totallyfakecanvas999',
    });
    await expect(openmeteoDataframeDescribeTool.handler(input, ctx)).rejects.toMatchObject({
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

  it('passes non-NotFound acquire() errors through unchanged', async () => {
    const upstream = new McpError(JsonRpcErrorCode.InternalError, 'DuckDB init failed.');
    mockCanvasInstance = { acquire: vi.fn().mockRejectedValue(upstream) };
    const ctx = createMockContext({ errors: openmeteoDataframeDescribeTool.errors });
    const input = openmeteoDataframeDescribeTool.input.parse({ canvas_id: 'anycanvasid' });
    await expect(openmeteoDataframeDescribeTool.handler(input, ctx)).rejects.toBe(upstream);
  });

  it('returns tables with columns and expiry', async () => {
    const mockInstance = {
      canvasId: 'testcanvas01',
      expiresAt: '2026-06-01T00:00:00.000Z',
      describe: vi.fn().mockResolvedValue(MOCK_TABLE_INFO),
    };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext();
    const input = openmeteoDataframeDescribeTool.input.parse({ canvas_id: 'testcanvas01' });
    const result = await openmeteoDataframeDescribeTool.handler(input, ctx);

    expect(result.canvas_id).toBe('testcanvas01');
    expect(result.expires_at).toBe('2026-06-01T00:00:00.000Z');
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]?.name).toBe('spilled_abc1234567');
    expect(result.tables[0]?.kind).toBe('table');
    expect(result.tables[0]?.row_count).toBe(8760);
    expect(result.tables[0]?.columns).toHaveLength(3);
    expect(result.tables[0]?.columns[0]).toEqual({
      name: 'time',
      type: 'VARCHAR',
      nullable: false,
    });
  });

  it('passes canvas_id to canvas.acquire', async () => {
    const mockInstance = {
      canvasId: 'mycanvasid1',
      expiresAt: '2026-06-01T00:00:00.000Z',
      describe: vi.fn().mockResolvedValue([]),
    };
    const mockAcquire = vi.fn().mockResolvedValue(mockInstance);
    mockCanvasInstance = { acquire: mockAcquire };

    const ctx = createMockContext();
    const input = openmeteoDataframeDescribeTool.input.parse({ canvas_id: 'mycanvasid1' });
    await openmeteoDataframeDescribeTool.handler(input, ctx);

    expect(mockAcquire).toHaveBeenCalledWith('mycanvasid1', ctx);
  });

  it('formats tables as markdown with column schema', () => {
    const blocks = openmeteoDataframeDescribeTool.format!({
      canvas_id: 'testcanvas01',
      expires_at: '2026-06-01T00:00:00.000Z',
      tables: [
        {
          name: 'spilled_abc1234567',
          kind: 'table',
          row_count: 8760,
          columns: [
            { name: 'time', type: 'VARCHAR', nullable: false },
            { name: 'temperature_2m', type: 'DOUBLE', nullable: true },
          ],
        },
      ],
    });
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('testcanvas01');
    expect(text).toContain('spilled_abc1234567');
    expect(text).toContain('8760');
    expect(text).toContain('temperature_2m');
    expect(text).toContain('DOUBLE');
  });

  it('formats empty canvas gracefully', () => {
    const blocks = openmeteoDataframeDescribeTool.format!({
      canvas_id: 'emptycv0001',
      expires_at: '2026-06-01T00:00:00.000Z',
      tables: [],
    });
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('emptycv0001');
    expect(text).toContain('Tables:** 0');
  });
});
