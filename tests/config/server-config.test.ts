/**
 * @fileoverview Tests for the server-specific env config: base-URL defaults and
 * overrides, the opt-in flag for openmeteo_dataframe_drop, the OPENMETEO_CLAMP_LIMITS
 * switch, and reading ./.env on the first parse.
 * @module tests/config/server-config.test
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every env var the config reads, cleared before each test so the host env can't leak in. */
const ENV_VARS = [
  'OPEN_METEO_API_BASE_URL',
  'OPEN_METEO_ARCHIVE_BASE_URL',
  'OPEN_METEO_MARINE_BASE_URL',
  'OPEN_METEO_AIR_QUALITY_BASE_URL',
  'OPEN_METEO_GEOCODING_BASE_URL',
  'OPEN_METEO_ENSEMBLE_BASE_URL',
  'OPEN_METEO_FLOOD_BASE_URL',
  'OPEN_METEO_CLIMATE_BASE_URL',
  'OPENMETEO_DATAFRAME_DROP_ENABLED',
  'OPENMETEO_CLAMP_LIMITS',
] as const;

/** The config caches its first parse, so each read goes through a fresh module instance. */
async function loadConfig() {
  vi.resetModules();
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig();
}

describe('getServerConfig', () => {
  beforeEach(() => {
    for (const name of ENV_VARS) vi.stubEnv(name, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults every base URL to the public Open-Meteo hosts', async () => {
    await expect(loadConfig()).resolves.toMatchObject({
      apiBaseUrl: 'https://api.open-meteo.com',
      archiveBaseUrl: 'https://archive-api.open-meteo.com',
      marineBaseUrl: 'https://marine-api.open-meteo.com',
      airQualityBaseUrl: 'https://air-quality-api.open-meteo.com',
      geocodingBaseUrl: 'https://geocoding-api.open-meteo.com',
      ensembleBaseUrl: 'https://ensemble-api.open-meteo.com',
      floodBaseUrl: 'https://flood-api.open-meteo.com',
      climateBaseUrl: 'https://climate-api.open-meteo.com',
    });
    // The first test pays the cold framework import after vi.resetModules().
  }, 20_000);

  it('reads a base URL override from its env var', async () => {
    vi.stubEnv('OPEN_METEO_ARCHIVE_BASE_URL', 'http://127.0.0.1:9999');
    const config = await loadConfig();
    expect(config.archiveBaseUrl).toBe('http://127.0.0.1:9999');
    expect(config.apiBaseUrl).toBe('https://api.open-meteo.com');
  });

  it('treats a blank base URL as unset', async () => {
    vi.stubEnv('OPEN_METEO_FLOOD_BASE_URL', '');
    await expect(loadConfig()).resolves.toMatchObject({
      floodBaseUrl: 'https://flood-api.open-meteo.com',
    });
  });

  describe('OPENMETEO_DATAFRAME_DROP_ENABLED', () => {
    it('defaults to off when unset', async () => {
      await expect(loadConfig()).resolves.toMatchObject({ dataframeDropEnabled: false });
    });

    it('treats a blank value as unset', async () => {
      vi.stubEnv('OPENMETEO_DATAFRAME_DROP_ENABLED', '');
      await expect(loadConfig()).resolves.toMatchObject({ dataframeDropEnabled: false });
    });

    it('turns on for "true"', async () => {
      vi.stubEnv('OPENMETEO_DATAFRAME_DROP_ENABLED', 'true');
      await expect(loadConfig()).resolves.toMatchObject({ dataframeDropEnabled: true });
    });

    it('stays off for "false" — a string flag, not a truthy coercion', async () => {
      vi.stubEnv('OPENMETEO_DATAFRAME_DROP_ENABLED', 'false');
      await expect(loadConfig()).resolves.toMatchObject({ dataframeDropEnabled: false });
    });

    it('rejects a value that is not a boolean word, naming the env var', async () => {
      vi.stubEnv('OPENMETEO_DATAFRAME_DROP_ENABLED', 'maybe');
      await expect(loadConfig()).rejects.toMatchObject({
        code: JsonRpcErrorCode.ConfigurationError,
        message: expect.stringContaining('OPENMETEO_DATAFRAME_DROP_ENABLED'),
      });
    });
  });

  describe('OPENMETEO_CLAMP_LIMITS', () => {
    it('defaults to on when unset', async () => {
      await expect(loadConfig()).resolves.toMatchObject({ clampLimits: true });
    });

    it('treats a blank value as unset', async () => {
      vi.stubEnv('OPENMETEO_CLAMP_LIMITS', '');
      await expect(loadConfig()).resolves.toMatchObject({ clampLimits: true });
    });

    it('turns off for "false" — a string flag, not a truthy coercion', async () => {
      vi.stubEnv('OPENMETEO_CLAMP_LIMITS', 'false');
      await expect(loadConfig()).resolves.toMatchObject({ clampLimits: false });
    });

    it('rejects a value that is not a boolean word, naming the env var', async () => {
      vi.stubEnv('OPENMETEO_CLAMP_LIMITS', 'sometimes');
      await expect(loadConfig()).rejects.toMatchObject({
        code: JsonRpcErrorCode.ConfigurationError,
        message: expect.stringContaining('OPENMETEO_CLAMP_LIMITS'),
      });
    });
  });

  /**
   * A tool definition reads this config when its module is imported. Under Node that is
   * before `createApp()` loads `./.env`, so the first parse loads it itself.
   */
  describe('./.env in the working directory', () => {
    let previousCwd: string;
    let dir: string;

    beforeEach(() => {
      previousCwd = process.cwd();
      dir = mkdtempSync(join(tmpdir(), 'om-server-config-'));
      process.chdir(dir);
    });

    afterEach(() => {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    });

    it('reads values set only in ./.env', async () => {
      writeFileSync(
        join(dir, '.env'),
        'OPENMETEO_CLAMP_LIMITS=false\nOPENMETEO_DATAFRAME_DROP_ENABLED=true\n',
      );
      await expect(loadConfig()).resolves.toMatchObject({
        clampLimits: false,
        dataframeDropEnabled: true,
      });
    });

    it('never overrides a value already in the environment', async () => {
      writeFileSync(join(dir, '.env'), 'OPENMETEO_CLAMP_LIMITS=false\n');
      vi.stubEnv('OPENMETEO_CLAMP_LIMITS', 'true');
      await expect(loadConfig()).resolves.toMatchObject({ clampLimits: true });
    });

    it('parses the environment as it stands when ./.env cannot be read', async () => {
      mkdirSync(join(dir, '.env'));
      await expect(loadConfig()).resolves.toMatchObject({
        clampLimits: true,
        dataframeDropEnabled: false,
      });
    });
  });

  it('caches the first parse for the life of the module', async () => {
    vi.resetModules();
    const { getServerConfig } = await import('@/config/server-config.js');
    const first = getServerConfig();
    vi.stubEnv('OPEN_METEO_API_BASE_URL', 'http://127.0.0.1:1');
    expect(getServerConfig()).toBe(first);
    expect(getServerConfig().apiBaseUrl).toBe('https://api.open-meteo.com');
  });
});
