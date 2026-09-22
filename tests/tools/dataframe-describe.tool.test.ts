/**
 * @fileoverview Tests for openmeteo_dataframe_describe tool.
 * @module tests/tools/dataframe-describe.tool.test
 */

import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  type IDataCanvasProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoDataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { firstText } from '../helpers/content.js';

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
          canvasId: 'fakeCanvas',
        }),
      ),
    };
    const ctx = createMockContext({ errors: openmeteoDataframeDescribeTool.errors });
    const input = openmeteoDataframeDescribeTool.input.parse({
      canvas_id: 'fakeCanvas',
    });
    await expect(openmeteoDataframeDescribeTool.handler(input, ctx)).rejects.toMatchObject({
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

  it('passes non-NotFound acquire() errors through unchanged', async () => {
    const upstream = new McpError(JsonRpcErrorCode.InternalError, 'DuckDB init failed.');
    mockCanvasInstance = { acquire: vi.fn().mockRejectedValue(upstream) };
    const ctx = createMockContext({ errors: openmeteoDataframeDescribeTool.errors });
    const input = openmeteoDataframeDescribeTool.input.parse({ canvas_id: 'anyCanvas1' });
    await expect(openmeteoDataframeDescribeTool.handler(input, ctx)).rejects.toBe(upstream);
  });

  it('returns tables with columns and expiry', async () => {
    const mockInstance = {
      canvasId: 'testCanv01',
      expiresAt: '2026-06-01T00:00:00.000Z',
      describe: vi.fn().mockResolvedValue(MOCK_TABLE_INFO),
    };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext({ errors: openmeteoDataframeDescribeTool.errors });
    const input = openmeteoDataframeDescribeTool.input.parse({ canvas_id: 'testCanv01' });
    const result = await openmeteoDataframeDescribeTool.handler(input, ctx);

    expect(result.canvas_id).toBe('testCanv01');
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
      canvasId: 'myCanvas01',
      expiresAt: '2026-06-01T00:00:00.000Z',
      describe: vi.fn().mockResolvedValue([]),
    };
    const mockAcquire = vi.fn().mockResolvedValue(mockInstance);
    mockCanvasInstance = { acquire: mockAcquire };

    const ctx = createMockContext({ errors: openmeteoDataframeDescribeTool.errors });
    const input = openmeteoDataframeDescribeTool.input.parse({ canvas_id: 'myCanvas01' });
    await openmeteoDataframeDescribeTool.handler(input, ctx);

    expect(mockAcquire).toHaveBeenCalledWith('myCanvas01', ctx);
  });

  it('formats tables as markdown with column schema', () => {
    const blocks = openmeteoDataframeDescribeTool.format!({
      canvas_id: 'testCanv01',
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
    const text = firstText(blocks) ?? '';
    expect(text).toContain('testCanv01');
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
    const text = firstText(blocks) ?? '';
    expect(text).toContain('emptycv0001');
    expect(text).toContain('Tables:** 0');
  });
});

/**
 * The same acquire() mapping against the framework's real registry rather than a
 * hand-built NotFound, so the throw shape under test is the one the framework emits.
 * A well-formed id that was never minted and one whose sliding TTL lapsed both fail
 * inside the registry lookup — before the provider is reached — so a stub provider
 * carries everything past that point.
 */
describe('openmeteoDataframeDescribeTool against the real canvas registry', () => {
  const TENANT = 'tenant-describe';
  let now: number;

  function realCanvas(): DataCanvas {
    const provider = {
      name: 'stub',
      initCanvas: vi.fn().mockResolvedValue(undefined),
      destroyCanvas: vi.fn().mockResolvedValue(undefined),
      describe: vi.fn().mockResolvedValue([]),
      shutdown: vi.fn().mockResolvedValue(undefined),
    } as unknown as IDataCanvasProvider;
    const registry = new CanvasRegistry(
      provider,
      { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, sweeperIntervalMs: 0 },
      () => now,
    );
    return new DataCanvas(provider, registry);
  }

  const toolRecovery = expect.stringContaining(
    'Re-run openmeteo_get_forecast, openmeteo_get_historical, openmeteo_get_marine',
  );

  beforeEach(() => {
    now = Date.parse('2026-09-21T00:00:00.000Z');
    mockCanvasInstance = realCanvas();
  });

  it('maps a well-formed id that was never minted to canvas_not_found', async () => {
    const ctx = createMockContext({
      tenantId: TENANT,
      errors: openmeteoDataframeDescribeTool.errors,
    });
    const input = openmeteoDataframeDescribeTool.input.parse({ canvas_id: 'neverMint1' });
    await expect(openmeteoDataframeDescribeTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'Canvas "neverMint1" not found or expired (24 h sliding TTL).',
      data: { reason: 'canvas_not_found', recovery: { hint: toolRecovery } },
    });
  });

  it('resolves a minted id, then maps it to canvas_not_found once its TTL lapses', async () => {
    const canvas = mockCanvasInstance as DataCanvas;
    const ctx = createMockContext({
      tenantId: TENANT,
      errors: openmeteoDataframeDescribeTool.errors,
    });
    const { canvasId } = await canvas.acquire(undefined, ctx);
    const input = openmeteoDataframeDescribeTool.input.parse({ canvas_id: canvasId });

    // Live: the same id resolves and describes.
    await expect(openmeteoDataframeDescribeTool.handler(input, ctx)).resolves.toMatchObject({
      canvas_id: canvasId,
      tables: [],
    });

    now += DEFAULT_CANVAS_REGISTRY_OPTIONS.ttlMs + 1;
    await expect(openmeteoDataframeDescribeTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found', recovery: { hint: toolRecovery } },
    });
  });

  it('carries canvas_not_found and the tool recovery on both client surfaces', async () => {
    const result = await runToolContract(
      openmeteoDataframeDescribeTool,
      { canvas_id: 'neverMint1' },
      { context: { tenantId: TENANT } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'canvas_not_found', recovery: { hint: toolRecovery } },
      },
    });
    const text = firstText(result.content);
    expect(text).toContain('Canvas "neverMint1" not found or expired');
    expect(text).toContain('Recovery: Re-run openmeteo_get_forecast');
    expect(text).toContain('reason canvas_not_found');
  });

  it('describes a live canvas on both client surfaces', async () => {
    const canvas = mockCanvasInstance as DataCanvas;
    const ctx = createMockContext({ tenantId: TENANT });
    const { canvasId } = await canvas.acquire(undefined, ctx);

    const result = await runToolContract(
      openmeteoDataframeDescribeTool,
      { canvas_id: canvasId },
      { context: { tenantId: TENANT } },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ canvas_id: canvasId, tables: [] });
    expect(firstText(result.content)).toContain(`**Canvas:** \`${canvasId}\``);
  });
});
