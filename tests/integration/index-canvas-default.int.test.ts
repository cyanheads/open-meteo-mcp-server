/**
 * @fileoverview Boot-level coverage for the DataCanvas default in `src/index.ts`. The
 * default is applied at module load, before `createApp()`, so it is exercised by booting
 * the real entry point over stdio and asking `openmeteo_dataframe_describe` about an
 * unknown canvas: `canvas_not_found` means a canvas provider is running,
 * `canvas_not_enabled` means DataCanvas is off. No upstream request is made.
 * @module tests/integration/index-canvas-default.int.test
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const BUN = process.versions.bun ? process.execPath : 'bun';
const RESPONSE_DEADLINE_MS = 20_000;

interface JsonRpcResponse {
  id?: number;
  result?: { isError?: boolean; structuredContent?: { error?: { data?: { reason?: string } } } };
}

/**
 * Boots the server over stdio with `CANVAS_PROVIDER_TYPE` set to `canvasProviderType`
 * (deleted when `undefined`) from an empty working directory, so neither Bun's nor the
 * framework's `.env` loading reaches a developer's `.env`. Returns the `data.reason` of
 * a describe call against a canvas that does not exist.
 */
async function describeReasonAtBoot(canvasProviderType: string | undefined): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'om-canvas-boot-'));
  const env: NodeJS.ProcessEnv = { ...process.env, MCP_TRANSPORT_TYPE: 'stdio' };
  delete env.CANVAS_PROVIDER_TYPE;
  if (canvasProviderType !== undefined) env.CANVAS_PROVIDER_TYPE = canvasProviderType;

  const child: ChildProcessWithoutNullStreams = spawn(BUN, ['--no-env-file', ENTRY], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));

  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.startsWith('{')) return;
    const message = JSON.parse(line) as JsonRpcResponse;
    if (message.id !== undefined) pending.get(message.id)?.(message);
  });
  const exited = new Promise<never>((_, reject) =>
    child.once('exit', (code) =>
      reject(new Error(`server exited (${code}) before answering:\n${stderr.join('')}`)),
    ),
  );

  const request = (id: number, method: string, params: unknown): Promise<JsonRpcResponse> => {
    const answered = new Promise<JsonRpcResponse>((resolve) => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const deadline = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`no answer to ${method} within ${RESPONSE_DEADLINE_MS} ms`)),
        RESPONSE_DEADLINE_MS,
      ).unref(),
    );
    return Promise.race([answered, exited, deadline]);
  };

  try {
    await request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'canvas-default-boot-test', version: '0.0.0' },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const response = await request(2, 'tools/call', {
      name: 'openmeteo_dataframe_describe',
      arguments: { canvas_id: 'abcdefghij' },
    });
    expect(response.result?.isError).toBe(true);
    return response.result?.structuredContent?.error?.data?.reason ?? '';
  } finally {
    if (child.pid !== undefined && child.exitCode === null) process.kill(child.pid, 'SIGKILL');
    await rm(cwd, { recursive: true, force: true });
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
