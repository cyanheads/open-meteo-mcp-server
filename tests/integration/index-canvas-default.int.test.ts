/**
 * @fileoverview Boot-level coverage for the DataCanvas default in `src/index.ts`. The
 * default is applied at module load, before `createApp()`, so it is exercised by booting
 * the real entry point over stdio and asking `openmeteo_dataframe_describe` about an
 * unknown canvas: `canvas_not_found` means a canvas provider is running,
 * `canvas_not_enabled` means DataCanvas is off. No upstream request is made.
 * @module tests/integration/index-canvas-default.int.test
 */

import { describe, expect, it } from 'vitest';
import { bootStdioServer } from '../helpers/stdio-server.js';

/**
 * Boots the server over stdio with `CANVAS_PROVIDER_TYPE` set to `canvasProviderType`
 * (deleted when `undefined`) from an empty working directory, so neither Bun's nor the
 * framework's `.env` loading reaches a developer's `.env`. Returns the `data.reason` of
 * a describe call against a canvas that does not exist.
 */
async function describeReasonAtBoot(canvasProviderType: string | undefined): Promise<string> {
  const server = await bootStdioServer({ env: { CANVAS_PROVIDER_TYPE: canvasProviderType } });
  try {
    const response = await server.request('tools/call', {
      name: 'openmeteo_dataframe_describe',
      arguments: { canvas_id: 'abcdefghij' },
    });
    expect(response.result?.isError).toBe(true);
    return response.result?.structuredContent?.error?.data?.reason ?? '';
  } finally {
    await server.close();
  }
}

describe('DataCanvas default at boot', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace-only', '  '],
    // The literal text an install host forwards when it substitutes nothing.
    ['an unsubstituted placeholder', `\${user_config.CANVAS_PROVIDER_TYPE}`],
  ])('turns the canvas on when CANVAS_PROVIDER_TYPE is %s', async (_label, value) => {
    expect(await describeReasonAtBoot(value)).toBe('canvas_not_found');
  });

  it('leaves the canvas off when CANVAS_PROVIDER_TYPE is none', async () => {
    expect(await describeReasonAtBoot('none')).toBe('canvas_not_enabled');
  });
});
