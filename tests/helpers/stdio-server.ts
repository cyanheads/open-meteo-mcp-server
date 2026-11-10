/**
 * @fileoverview Boots the real entry point (`src/index.ts`) over stdio from an empty
 * working directory and exchanges JSON-RPC with it. Bun runs it with `--no-env-file`,
 * so the only `.env` reader is the framework's own lazy loader — the path a Node
 * process takes — and a developer's `.env` never leaks in.
 * @module tests/helpers/stdio-server
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const BUN = process.versions.bun ? process.execPath : 'bun';
const RESPONSE_DEADLINE_MS = 20_000;

/** The parts of a `tools/list` or `tools/call` response these tests read. */
export interface JsonRpcResponse {
  id?: number;
  result?: {
    isError?: boolean;
    structuredContent?: {
      error?: { code?: number; message?: string; data?: { reason?: string } };
    };
    tools?: { name: string; inputSchema: { properties?: Record<string, unknown> } }[];
  };
}

/** A booted, initialized server. */
export interface StdioServer {
  /** Kills the server by its PID and removes its working directory. */
  close(): Promise<void>;
  request(method: string, params: unknown): Promise<JsonRpcResponse>;
}

/**
 * Boots the server with `env` laid over the test process's environment — a key set to
 * `undefined` is removed — and, when `envFile` is given, that text as `./.env` in its
 * working directory. Resolves once `initialize` is answered.
 */
export async function bootStdioServer(
  options: { env?: Record<string, string | undefined>; envFile?: string } = {},
): Promise<StdioServer> {
  const cwd = await mkdtemp(join(tmpdir(), 'om-stdio-boot-'));
  if (options.envFile !== undefined) await writeFile(join(cwd, '.env'), options.envFile);
  const env: NodeJS.ProcessEnv = { ...process.env, MCP_TRANSPORT_TYPE: 'stdio' };
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }

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

  let nextId = 1;
  const request = (method: string, params: unknown): Promise<JsonRpcResponse> => {
    const id = nextId++;
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
  const close = async () => {
    if (child.pid !== undefined && child.exitCode === null) process.kill(child.pid, 'SIGKILL');
    await rm(cwd, { recursive: true, force: true });
  };

  try {
    await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'stdio-boot-test', version: '0.0.0' },
    });
  } catch (error) {
    await close();
    throw error;
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return { close, request };
}
