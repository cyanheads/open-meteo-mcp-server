/**
 * @fileoverview Wire-level contract for an upstream HTTP 429 on every tool that calls
 * Open-Meteo. Runs each tool through `runToolContract` over the real service with only
 * `fetch` stubbed, so the service's 429 classification, its `data.reason`, and the
 * handler boundary's fill of the declared `recovery` are all under test together.
 * Base URLs carry a marker so a request URL leaking into the envelope shows up.
 * @module tests/tools/rate-limit-contract.test
 */

import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as definitions from '@/mcp-server/tools/definitions/index.js';
import { initOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';
import { firstText } from '../helpers/content.js';
import { URL_MARKERS } from '../helpers/marker-config.js';
import type { WireError } from '../helpers/wire-error.js';

vi.mock('@/config/server-config.js', () => import('../helpers/marker-config.js'));

const fetchMock = vi.fn();

const RATE_LIMIT_BODY =
  '{"error":true,"reason":"Minutely API request limit exceeded. Please try again in one minute."}';

const CONCURRENCY_BODY = '{"error":true,"reason":"Too many concurrent requests"}';

const point = { latitude: 47.6, longitude: -122.3 };

/** A minimal valid call per upstream-calling tool — each reaches the service unchanged. */
const CALLS = [
  { tool: definitions.openmeteoSearchLocationsTool, input: { name: 'Seattle' } },
  {
    tool: definitions.openmeteoGetForecastTool,
    input: { ...point, hourly_variables: ['temperature_2m'] },
  },
  {
    tool: definitions.openmeteoGetHistoricalTool,
    input: {
      ...point,
      start_date: '2024-07-01',
      end_date: '2024-07-02',
      daily_variables: ['temperature_2m_max'],
    },
  },
  {
    tool: definitions.openmeteoGetMarineTool,
    input: { latitude: 47.8, longitude: -122.5, hourly_variables: ['wave_height'] },
  },
  {
    tool: definitions.openmeteoGetAirQualityTool,
    input: { ...point, hourly_variables: ['pm2_5'] },
  },
  {
    tool: definitions.openmeteoGetElevationTool,
    input: { latitudes: [47.6], longitudes: [-122.3] },
  },
  {
    tool: definitions.openmeteoGetEnsembleTool,
    input: { ...point, hourly_variables: ['temperature_2m'] },
  },
  {
    tool: definitions.openmeteoGetFloodTool,
    input: { ...point, daily_variables: ['river_discharge'] },
  },
  {
    tool: definitions.openmeteoGetClimateTool,
    input: {
      ...point,
      start_date: '2049-01-01',
      end_date: '2049-01-05',
      daily_variables: ['temperature_2m_max'],
    },
  },
] as const;

type AnyDefinition = Parameters<typeof runToolContract>[0];

function rateLimitEntry(definition: AnyDefinition): ErrorContract | undefined {
  return ((definition.errors ?? []) as readonly ErrorContract[]).find(
    (entry) => entry.reason === 'rate_limited',
  );
}

/** Settles a tool call that must fail; returns the result, its error envelope, and content[0] text. */
async function failedCall(pending: ReturnType<typeof runToolContract>) {
  const result = await pending;
  expect(result.isError).toBe(true);
  return {
    result,
    error: (result.structuredContent as { error: WireError }).error,
    text: firstText(result.content),
  };
}

describe('rate_limited contract (#56)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(RATE_LIMIT_BODY, { status: 429 })),
    );
    initOpenMeteoService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is declared on exactly the nine upstream-calling tools', () => {
    const declaring = Object.values(definitions)
      .filter((definition) => rateLimitEntry(definition as AnyDefinition))
      .map((definition) => definition.name)
      .sort();
    expect(declaring).toEqual(CALLS.map(({ tool }) => tool.name).sort());
  });

  it.each(CALLS)(
    '$tool.name declares it as a service-thrown RateLimited with no retryable',
    ({ tool }) => {
      const entry = rateLimitEntry(tool as AnyDefinition);
      expect(entry).toMatchObject({ code: JsonRpcErrorCode.RateLimited, thrownBy: 'service' });
      expect(entry).not.toHaveProperty('retryable');
    },
  );

  it.each(CALLS)(
    '$tool.name answers a 429 with the declared reason and recovery, and no URL',
    async ({ tool, input }) => {
      const definition = tool as AnyDefinition;
      const args = input as Parameters<typeof runToolContract>[1];
      const recovery = rateLimitEntry(definition)?.recovery;

      const { result, error, text } = await failedCall(runToolContract(definition, args));
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.message).toContain('Minutely API request limit exceeded');
      // Exactly the declared reason plus the framework-filled hint — nothing URL-shaped.
      expect(error.data).toEqual({ reason: 'rate_limited', recovery: { hint: recovery } });
      expect(text).toContain(`Recovery: ${recovery}`);
      expect(text).toContain('reason rate_limited');
      for (const marker of URL_MARKERS) expect(JSON.stringify(result)).not.toContain(marker);
      // One upstream request: a windowed 429 is never retried.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  describe('when Open-Meteo reports "Too many concurrent requests" (#75)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(CONCURRENCY_BODY, { status: 429 })),
      );
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it.each(CALLS)(
      '$tool.name retries it, then answers with the declared reason, recovery, and attempt count',
      async ({ tool, input }) => {
        const definition = tool as AnyDefinition;
        const args = input as Parameters<typeof runToolContract>[1];
        const recovery = rateLimitEntry(definition)?.recovery;

        const pending = failedCall(runToolContract(definition, args));
        await vi.advanceTimersByTimeAsync(10_000);
        const { error, text } = await pending;
        expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
        expect(error.message).toBe(
          'Open-Meteo rate limit reached: Too many concurrent requests. Retry in a few seconds, once the requests already in flight finish. (failed after 3 attempts)',
        );
        expect(error.data).toEqual({
          reason: 'rate_limited',
          retryAttempts: 3,
          recovery: { hint: recovery },
        });
        // The declared recovery names the concurrency case on its own terms.
        expect(recovery).toContain('"Too many concurrent requests" clears within seconds');
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(text).toContain('Retry in a few seconds');
        expect(text).toContain(`Recovery: ${recovery}`);
        expect(text).toContain('reason rate_limited');
      },
    );
  });
});
