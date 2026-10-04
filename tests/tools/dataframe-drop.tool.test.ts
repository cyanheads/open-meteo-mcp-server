/**
 * @fileoverview Tests for openmeteo_dataframe_drop: the drop path against a real DuckDB
 * canvas on both client surfaces, every declared error reason, and the
 * OPENMETEO_DATAFRAME_DROP_ENABLED gate.
 * @module tests/tools/dataframe-drop.tool.test
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoDataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { openmeteoDataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { firstText } from '../helpers/content.js';
import { wireError } from '../helpers/wire-error.js';

let mockCanvasInstance: unknown;

vi.mock('@/services/canvas-accessor.js', () => ({
  getCanvas: () => mockCanvasInstance,
}));

const TENANT = 'tenant-drop';
const OTHER_TENANT = 'tenant-other';

const ROWS = [
  { time: '2024-01-01T00:00', temperature_2m: 3.6 },
  { time: '2024-01-01T01:00', temperature_2m: 3.2 },
  { time: '2024-01-01T02:00', temperature_2m: 2.9 },
];

describe('openmeteoDataframeDropTool without a canvas provider', () => {
  beforeEach(() => {
    mockCanvasInstance = undefined;
  });

  it('fails as canvas_not_enabled with the enable hint on both surfaces', async () => {
    const result = await runToolContract(openmeteoDataframeDropTool, {
      canvas_id: 'abc1234567',
      table_name: 'spilled_ab12cd34',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.InternalError,
        data: {
          reason: 'canvas_not_enabled',
          recovery: { hint: expect.stringContaining('CANVAS_PROVIDER_TYPE=duckdb') },
        },
      },
    });
    expect(firstText(result.content)).toContain('reason canvas_not_enabled');
  });
});

describe('openmeteoDataframeDropTool against a real DuckDB canvas', () => {
  let canvas: DataCanvas;
  let exportRoot: string;
  let canvasId: string;

  const ctxFor = (tenantId: string) =>
    createMockContext({ tenantId, errors: openmeteoDataframeDropTool.errors });
  const asTenant = (tenantId: string) => ({ context: { tenantId } });

  /** Stage one table and one view on a fresh canvas owned by TENANT. */
  beforeEach(async () => {
    exportRoot = mkdtempSync(join(tmpdir(), 'openmeteo-drop-test-'));
    const provider = new DuckdbProvider({
      defaultRowLimit: 10_000,
      exportRootPath: exportRoot,
      memoryLimitMb: 256,
      schemaSniffRows: 100,
    });
    canvas = new DataCanvas(
      provider,
      new CanvasRegistry(provider, { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, sweeperIntervalMs: 0 }),
    );
    mockCanvasInstance = canvas;

    const instance = await canvas.acquire(undefined, ctxFor(TENANT));
    canvasId = instance.canvasId;
    await instance.registerTable('spilled_aaa111', ROWS);
    await instance.registerTable('spilled_bbb222', ROWS);
    await instance.registerView(
      'warm_hours',
      'SELECT * FROM spilled_bbb222 WHERE temperature_2m > 3',
    );
  });

  afterEach(async () => {
    await canvas.shutdown(ctxFor(TENANT));
    rmSync(exportRoot, { recursive: true, force: true });
  });

  async function stagedNames(tenantId = TENANT): Promise<string[]> {
    const instance = await canvas.acquire(canvasId, ctxFor(tenantId));
    return (await instance.describe()).map((t) => t.name).sort();
  }

  it('drops a staged table and reports the remaining ones on both surfaces', async () => {
    const result = await runToolContract(
      openmeteoDataframeDropTool,
      { canvas_id: canvasId, table_name: 'spilled_aaa111' },
      asTenant(TENANT),
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      canvas_id: canvasId,
      table_name: 'spilled_aaa111',
      dropped: true,
      remaining_tables: expect.arrayContaining(['spilled_bbb222', 'warm_hours']),
    });
    expect(
      (result.structuredContent as { remaining_tables: string[] }).remaining_tables,
    ).toHaveLength(2);

    const text = firstText(result.content);
    expect(text).toContain(`**Canvas:** \`${canvasId}\``);
    expect(text).toContain('**Table:** `spilled_aaa111`');
    expect(text).toContain('**Dropped:** true');
    expect(text).toContain('Removed `spilled_aaa111` from the canvas.');
    expect(text).toContain('`spilled_bbb222`');
    expect(text).toContain('`warm_hours`');

    expect(await stagedNames()).toEqual(['spilled_bbb222', 'warm_hours']);
  });

  it('drops a view and leaves its base table staged', async () => {
    const result = await openmeteoDataframeDropTool.handler(
      openmeteoDataframeDropTool.input.parse({ canvas_id: canvasId, table_name: 'warm_hours' }),
      ctxFor(TENANT),
    );
    expect(result).toMatchObject({ dropped: true });
    expect(result.remaining_tables.sort()).toEqual(['spilled_aaa111', 'spilled_bbb222']);
  });

  it('returns dropped: false for a well-formed name that is not staged, changing nothing', async () => {
    const result = await runToolContract(
      openmeteoDataframeDropTool,
      { canvas_id: canvasId, table_name: 'spilled_never_staged' },
      asTenant(TENANT),
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      table_name: 'spilled_never_staged',
      dropped: false,
    });
    const text = firstText(result.content);
    expect(text).toContain('**Dropped:** false');
    expect(text).toContain('No table or view named `spilled_never_staged` was staged');
    expect(await stagedNames()).toEqual(['spilled_aaa111', 'spilled_bbb222', 'warm_hours']);
  });

  it('is idempotent: a repeated drop returns dropped: false and leaves the rest alone', async () => {
    const input = openmeteoDataframeDropTool.input.parse({
      canvas_id: canvasId,
      table_name: 'spilled_aaa111',
    });
    await expect(openmeteoDataframeDropTool.handler(input, ctxFor(TENANT))).resolves.toMatchObject({
      dropped: true,
    });
    await expect(openmeteoDataframeDropTool.handler(input, ctxFor(TENANT))).resolves.toMatchObject({
      dropped: false,
    });
    expect(await stagedNames()).toEqual(['spilled_bbb222', 'warm_hours']);
  });

  it('makes a later query against the dropped table fail as missing_table', async () => {
    const before = await runToolContract(
      openmeteoDataframeQueryTool,
      { canvas_id: canvasId, sql: 'SELECT COUNT(*) AS n FROM spilled_aaa111' },
      asTenant(TENANT),
    );
    // COUNT(*) is BIGINT, which DuckDB marshals as a string.
    expect(before.structuredContent).toMatchObject({ rows: [{ n: '3' }] });

    await openmeteoDataframeDropTool.handler(
      openmeteoDataframeDropTool.input.parse({ canvas_id: canvasId, table_name: 'spilled_aaa111' }),
      ctxFor(TENANT),
    );

    await expect(
      wireError(
        openmeteoDataframeQueryTool,
        { canvas_id: canvasId, sql: 'SELECT COUNT(*) AS n FROM spilled_aaa111' },
        asTenant(TENANT),
      ),
    ).resolves.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining('spilled_aaa111'),
      data: { reason: 'missing_table' },
    });
  });

  it('fails as canvas_not_found for a well-formed id that was never minted', async () => {
    const result = await runToolContract(
      openmeteoDataframeDropTool,
      { canvas_id: 'neverMint1', table_name: 'spilled_aaa111' },
      asTenant(TENANT),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message: 'Canvas "neverMint1" not found or expired (24 h sliding TTL).',
        data: {
          reason: 'canvas_not_found',
          recovery: { hint: expect.stringContaining('Check the canvas_id') },
        },
      },
    });
    const text = firstText(result.content);
    expect(text).toContain('Recovery: Check the canvas_id');
    expect(text).toContain('reason canvas_not_found');
  });

  it("fails as canvas_not_found for another tenant's canvas and leaves its tables intact", async () => {
    await expect(
      wireError(
        openmeteoDataframeDropTool,
        { canvas_id: canvasId, table_name: 'spilled_aaa111' },
        asTenant(OTHER_TENANT),
      ),
    ).resolves.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });
    expect(await stagedNames()).toEqual(['spilled_aaa111', 'spilled_bbb222', 'warm_hours']);
  });

  it('rejects a malformed canvas_id at argument validation, before the canvas is reached', async () => {
    const acquire = vi.spyOn(canvas, 'acquire');
    await expect(
      wireError(
        openmeteoDataframeDropTool,
        { canvas_id: 'spilled_aaa111', table_name: 'spilled_aaa111' },
        asTenant(TENANT),
      ),
    ).resolves.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_arguments' },
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it.each([
    ['a shape that is not an identifier', 'spilled-aaa111'],
    ['an empty name', ''],
    ['a reserved SQL keyword', 'select'],
  ])(
    'fails as invalid_table_name for %s, pointing at openmeteo_dataframe_describe',
    async (_label, tableName) => {
      const result = await runToolContract(
        openmeteoDataframeDropTool,
        { canvas_id: canvasId, table_name: tableName },
        asTenant(TENANT),
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'invalid_table_name',
            recovery: { hint: expect.stringContaining('openmeteo_dataframe_describe') },
          },
        },
      });
      const error = (
        result.structuredContent as { error: { data: { recovery: { hint: string } } } }
      ).error;
      expect(error.data.recovery.hint).not.toContain('()');
      expect(firstText(result.content)).toContain('reason invalid_table_name');
      expect(await stagedNames()).toEqual(['spilled_aaa111', 'spilled_bbb222', 'warm_hours']);
    },
  );
});

describe('openmeteoDataframeDropTool error passthrough', () => {
  it('passes a drop() failure outside the identifier gate through unchanged', async () => {
    const engine = new McpError(JsonRpcErrorCode.DatabaseError, 'IO Error: disk full.');
    mockCanvasInstance = {
      acquire: vi.fn().mockResolvedValue({
        canvasId: 'testCanv01',
        drop: vi.fn().mockRejectedValue(engine),
      }),
    };
    const input = openmeteoDataframeDropTool.input.parse({
      canvas_id: 'testCanv01',
      table_name: 'spilled_aaa111',
    });
    await expect(
      openmeteoDataframeDropTool.handler(
        input,
        createMockContext({ errors: openmeteoDataframeDropTool.errors }),
      ),
    ).rejects.toBe(engine);
  });
});

describe('openmeteoDataframeDropTool format()', () => {
  it('says nothing changed when the name was not staged', () => {
    const text = firstText(
      openmeteoDataframeDropTool.format!({
        canvas_id: 'testCanv01',
        table_name: 'spilled_zzz',
        dropped: false,
        remaining_tables: ['spilled_aaa111'],
      }),
    );
    expect(text).toContain('**Dropped:** false');
    expect(text).toContain('nothing changed');
    expect(text).toContain('**Remaining tables:** `spilled_aaa111`');
  });

  it('renders an emptied canvas as no remaining tables', () => {
    const text = firstText(
      openmeteoDataframeDropTool.format!({
        canvas_id: 'testCanv01',
        table_name: 'spilled_aaa111',
        dropped: true,
        remaining_tables: [],
      }),
    );
    expect(text).toContain('**Remaining tables:** none');
  });
});

/**
 * The gate is evaluated when the definition module loads, so each case reloads it under
 * its own env. disabledTool() keeps the metadata off the public definition shape; the
 * test finds it as the one `{ reason, hint }` value the wrapper attaches.
 */
describe('OPENMETEO_DATAFRAME_DROP_ENABLED gate', () => {
  async function loadTool(flag: string | undefined) {
    vi.stubEnv('OPENMETEO_DATAFRAME_DROP_ENABLED', flag);
    vi.resetModules();
    const module = await import('@/mcp-server/tools/definitions/dataframe-drop.tool.js');
    return module.openmeteoDataframeDropTool;
  }

  function disabledMetadata(definition: object) {
    return Object.values(definition).find(
      (value): value is { reason: string; hint?: string } =>
        typeof value === 'object' && value !== null && 'reason' in value && 'hint' in value,
    );
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('registers the tool as disabled, with the enable hint, when the flag is unset', async () => {
    const definition = await loadTool(undefined);
    expect(definition.name).toBe('openmeteo_dataframe_drop');
    expect(disabledMetadata(definition)).toEqual({
      reason: 'Dropping staged DataCanvas tables is turned off in this deployment.',
      hint: 'OPENMETEO_DATAFRAME_DROP_ENABLED=true',
    });
  });

  it('keeps the tool disabled when the flag is "false"', async () => {
    expect(disabledMetadata(await loadTool('false'))).toMatchObject({
      hint: 'OPENMETEO_DATAFRAME_DROP_ENABLED=true',
    });
  });

  it('registers the tool as callable when the flag is "true"', async () => {
    const definition = await loadTool('true');
    expect(definition.name).toBe('openmeteo_dataframe_drop');
    expect(disabledMetadata(definition)).toBeUndefined();
    expect(definition.handler).toEqual(expect.any(Function));
  });
});
