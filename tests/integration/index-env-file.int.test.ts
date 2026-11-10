/**
 * @fileoverview Boot-level coverage for settings that exist only in `./.env`. Tool
 * definitions read the server config when their modules are imported, which under Node
 * is before `createApp()` loads `.env`. Booting the real entry point with Bun's own
 * `.env` loading off reproduces that order, and the server must still apply
 * `OPENMETEO_CLAMP_LIMITS`, `OPENMETEO_DATAFRAME_DROP_ENABLED`, and
 * `CANVAS_DEFAULT_ROW_LIMIT` from the file. No upstream request is made.
 * @module tests/integration/index-env-file.int.test
 */

import { describe, expect, it } from 'vitest';
import { bootStdioServer } from '../helpers/stdio-server.js';

describe('settings read from ./.env at boot', () => {
  it('advertises and enforces the strict limit, and registers the drop tool, from ./.env alone', async () => {
    const server = await bootStdioServer({
      env: {
        OPENMETEO_CLAMP_LIMITS: undefined,
        OPENMETEO_DATAFRAME_DROP_ENABLED: undefined,
        CANVAS_DEFAULT_ROW_LIMIT: undefined,
      },
      envFile:
        'OPENMETEO_CLAMP_LIMITS=false\nOPENMETEO_DATAFRAME_DROP_ENABLED=true\nCANVAS_DEFAULT_ROW_LIMIT=500\n',
    });
    try {
      const tools = (await server.request('tools/list', {})).result?.tools ?? [];
      const query = tools.find((t) => t.name === 'openmeteo_dataframe_query');
      expect(query?.inputSchema.properties?.limit).toMatchObject({ maximum: 500 });
      expect(tools.map((t) => t.name)).toContain('openmeteo_dataframe_drop');

      const call = await server.request('tools/call', {
        name: 'openmeteo_dataframe_query',
        arguments: { canvas_id: 'abcdefghij', sql: 'SELECT 1', limit: 501 },
      });
      expect(call.result?.isError).toBe(true);
      expect(call.result?.structuredContent?.error).toMatchObject({
        code: -32602,
        message: expect.stringContaining('500'),
      });
    } finally {
      await server.close();
    }
  });
});
