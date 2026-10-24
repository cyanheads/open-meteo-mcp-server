/**
 * @fileoverview Pins the bound that request URLs never leave the Open-Meteo client: no
 * error it throws — nor any error on that error's cause chain — carries the request URL
 * in `data`, and no `ctx.log` record it writes names it. Every base URL is configured
 * with a marker so a leak of the host, a path segment, or embedded credentials shows up
 * in the serialized output.
 * @module tests/services/open-meteo-service-redaction.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getOpenMeteoService,
  initOpenMeteoService,
} from '@/services/open-meteo/open-meteo-service.js';
import { MARKER_BASE, URL_MARKERS } from '../helpers/marker-config.js';

vi.mock('@/config/server-config.js', () => import('../helpers/marker-config.js'));

const fetchMock = vi.fn();

const respondWith = (body: string, status = 200): void => {
  fetchMock.mockImplementation(() => Promise.resolve(new Response(body, { status })));
};

/** Every error on the chain, outermost first. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let current = error; current !== undefined; ) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

/** The `ctx.log` records a mock context collected. */
const logCalls = (ctx: Context) => (ctx.log as MockContextLogger).calls;

/** `{ code, message, data }` of each McpError on the chain, for exact comparison. */
function mcpChain(error: unknown): { code: number; message: string; data: unknown }[] {
  return causeChain(error)
    .filter((e): e is McpError => e instanceof McpError)
    .map((e) => ({ code: e.code, message: e.message, data: e.data ?? {} }));
}

const forecast = (ctx: Context) =>
  getOpenMeteoService().getForecast(47.6, -122.3, { hourly: ['temperature_2m'] }, ctx);

type ChainLink = ReturnType<typeof mcpChain>[number];

/**
 * The chain a retried failure ends as: the service's exhaustion error (its reason named
 * by the last attempt's code), wrapping the framework `withRetry` exhaustion error (which
 * spreads the last attempt's `data`), wrapping the last attempt's own error.
 */
function exhausted(last: ChainLink): ChainLink[] {
  return [
    {
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'Open-Meteo API unavailable after 3 attempts.',
      data: {
        reason:
          last.code === JsonRpcErrorCode.Timeout ? 'upstream_timeout' : 'upstream_unavailable',
        retryAttempts: 3,
      },
    },
    {
      code: last.code,
      message: `${last.message} (failed after 3 attempts)`,
      data: { ...(last.data as object), operation: 'forecast', retryAttempts: 3 },
    },
    last,
  ];
}

describe('OpenMeteoService keeps request URLs out of error data and logs (#59)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    initOpenMeteoService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A retried case (`calls: 3`) lists only its last attempt's error; exhausted() adds the wrappers.
  it.each([
    {
      name: '429 with an envelope',
      arrange: () =>
        respondWith(
          '{"error":true,"reason":"Minutely API request limit exceeded. Please try again in one minute."}',
          429,
        ),
      call: (ctx: Context) => getOpenMeteoService().getGeocode('Seattle', 5, 'en', undefined, ctx),
      calls: 1,
      chain: [
        {
          code: JsonRpcErrorCode.RateLimited,
          message:
            'Open-Meteo rate limit reached: Minutely API request limit exceeded. Please try again in one minute. Retrying immediately returns the same response.',
          data: { reason: 'rate_limited' },
        },
      ],
    },
    {
      name: '429 without an envelope',
      arrange: () => respondWith('Too Many Requests', 429),
      call: forecast,
      calls: 1,
      chain: [
        {
          code: JsonRpcErrorCode.RateLimited,
          message:
            'Open-Meteo rate limit reached (HTTP 429). Open-Meteo enforces separate per-minute, per-hour, and per-day free-tier limits, so how long the wait is depends on which one was reached. Retrying immediately returns the same response.',
          data: { reason: 'rate_limited' },
        },
      ],
    },
    {
      name: 'coverage gap through the nan body',
      arrange: () =>
        respondWith(
          '{"latitude":nan,"longitude":nan,"generationtime_ms":0.0035,"utc_offset_seconds":0,"timezone":"GMT","timezone_abbreviation":"GMT"}',
        ),
      call: (ctx: Context) =>
        getOpenMeteoService().getEnsemble(
          47.6,
          -122.3,
          { hourly: ['temperature_2m'], models: 'icon_eu_eps' },
          ctx,
        ),
      calls: 1,
      chain: [
        {
          code: JsonRpcErrorCode.ValidationError,
          message:
            "Open-Meteo returned no data for this location (47.6, -122.3) — the response carried nan coordinates and no data blocks, which is how a regional model reports a coordinate outside the area it covers. Switch to a model whose domain includes this coordinate (any global model does), or omit models to use the tool's global default. Retrying returns the same response.",
          data: { reason: 'coverage_gap' },
        },
      ],
    },
    {
      name: 'coverage gap through the no-data envelope',
      arrange: () =>
        respondWith('{"error":true,"reason":"No data is available for this location"}', 400),
      call: (ctx: Context) =>
        getOpenMeteoService().getMarine(-90, 0, { hourly: ['wave_height'] }, ctx),
      calls: 1,
      chain: [
        {
          code: JsonRpcErrorCode.ValidationError,
          message:
            "Open-Meteo returned no data for this location (-90, 0). The marine dataset's grid does not cover this coordinate — request a point inside its coverage. Retrying returns the same response.",
          data: { reason: 'coverage_gap' },
        },
      ],
    },
    {
      name: '4xx without an envelope',
      arrange: () => respondWith('{}', 404),
      call: forecast,
      calls: 1,
      chain: [
        {
          code: JsonRpcErrorCode.ValidationError,
          message: 'Open-Meteo API returned 404.',
          data: {},
        },
      ],
    },
    {
      name: 'CDN HTML page, retried to exhaustion',
      arrange: () => respondWith('<!DOCTYPE html><html><body>502</body></html>', 502),
      call: forecast,
      calls: 3,
      chain: [
        {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: 'Open-Meteo API returned HTML instead of JSON. Retry shortly.',
          data: {},
        },
      ],
    },
    {
      name: 'unparseable JSON, retried to exhaustion',
      arrange: () => respondWith('{"latitude":47.6,"hourly":{"time":['),
      call: forecast,
      calls: 3,
      chain: [
        {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: 'Open-Meteo API returned unparseable response.',
          data: {},
        },
      ],
    },
    {
      name: '5xx envelope, retried to exhaustion',
      arrange: () => respondWith('{"error":true,"reason":"upstream down"}', 503),
      call: forecast,
      calls: 3,
      chain: [
        {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: 'Open-Meteo API error: upstream down',
          data: { status: 503 },
        },
      ],
    },
    {
      name: 'generic 5xx without an envelope, retried to exhaustion',
      arrange: () => respondWith('{}', 503),
      call: forecast,
      calls: 3,
      chain: [
        {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: 'Open-Meteo API returned 503.',
          data: {},
        },
      ],
    },
    {
      name: 'timeout, retried to exhaustion',
      arrange: () =>
        fetchMock.mockImplementation(() =>
          Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
        ),
      call: forecast,
      calls: 3,
      chain: [
        {
          code: JsonRpcErrorCode.Timeout,
          message: 'Open-Meteo request timed out after 15s.',
          data: {},
        },
      ],
    },
    {
      name: 'network failure, retried to exhaustion',
      arrange: () =>
        fetchMock.mockImplementation(() => Promise.reject(new TypeError('fetch failed'))),
      call: forecast,
      calls: 3,
      chain: [
        {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: 'Open-Meteo API unreachable.',
          data: {},
        },
      ],
    },
  ])(
    '$name: unchanged message and code, no URL in data',
    async ({ arrange, call, calls, chain }) => {
      arrange();
      const ctx = createMockContext();

      const error = await call(ctx).catch((e: unknown) => e);

      const [last] = chain;
      expect(mcpChain(error)).toEqual(calls === 1 || !last ? chain : exhausted(last));
      for (const link of mcpChain(error)) {
        expect(link.data).not.toHaveProperty('url');
        for (const marker of URL_MARKERS) expect(JSON.stringify(link.data)).not.toContain(marker);
      }
      expect(fetchMock).toHaveBeenCalledTimes(calls);
      // The service's own log records never name the request URL or its base.
      for (const marker of URL_MARKERS) {
        expect(JSON.stringify(logCalls(ctx))).not.toContain(marker);
      }
    },
  );

  it('logs each retry as { operation, attempt } and nothing URL-shaped', async () => {
    respondWith('{"error":true,"reason":"upstream down"}', 503);
    const ctx = createMockContext();

    await getOpenMeteoService()
      .getHistorical(
        47.6,
        -122.3,
        { start_date: '2024-07-01', end_date: '2024-07-02', hourly: ['temperature_2m'] },
        ctx,
      )
      .catch(() => undefined);

    const retries = logCalls(ctx).filter((call) => call.msg === 'Retrying Open-Meteo request');
    expect(retries).toEqual([
      {
        level: 'info',
        msg: 'Retrying Open-Meteo request',
        data: { operation: 'historical', attempt: 1 },
      },
      {
        level: 'info',
        msg: 'Retrying Open-Meteo request',
        data: { operation: 'historical', attempt: 2 },
      },
    ]);
    expect(JSON.stringify(logCalls(ctx))).not.toMatch(/https?:\/\//);
  });

  it('sends the configured base URL to fetch — the URL is used, only never reported', async () => {
    respondWith('{"latitude":47.6,"longitude":-122.3,"hourly":{"time":[]}}');

    await forecast(createMockContext());

    const prefix = `${MARKER_BASE}/v1/forecast?`;
    expect(String(fetchMock.mock.calls[0]?.[0]).slice(0, prefix.length)).toBe(prefix);
  });

  it('tags a forecast coverage gap coverage_gap and nothing else, whichever tool declares it (#77, #80)', async () => {
    // The tag is the service's, independent of the endpoint: a tool that declares
    // coverage_gap gets its recovery filled; one that does not still sees the reason.
    // The forecast endpoint takes models, so its message carries the switch-models recovery.
    respondWith('{"error":true,"reason":"No data is available for this location"}', 400);

    const error = await forecast(createMockContext()).catch((e: unknown) => e);

    expect(mcpChain(error)).toEqual([
      {
        code: JsonRpcErrorCode.ValidationError,
        message:
          "Open-Meteo returned no data for this location (47.6, -122.3). Switch to a model whose domain includes this coordinate (any global model does), or omit models to use the tool's global default. Retrying returns the same response.",
        data: { reason: 'coverage_gap' },
      },
    ]);
  });
});
