/**
 * @fileoverview Wire-level contract for the Open-Meteo failures other than HTTP 429: a
 * coordinate the requested dataset does not cover (`coverage_gap`), a 4xx that is not an
 * input rejection (`upstream_rejected`), and a retry ladder that runs out on an outage
 * (`upstream_unavailable`) or on the per-attempt timeout (`upstream_timeout`). Runs each
 * tool through `runToolContract` over the real service
 * with only `fetch` stubbed, so the service's classification, its `data.reason`, and
 * the handler boundary's fill of the declared `recovery` are all under test together.
 * @module tests/tools/upstream-failure-contract.test
 */

import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as definitions from '@/mcp-server/tools/definitions/index.js';
import { initOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';
import { firstText } from '../helpers/content.js';
import { URL_MARKERS } from '../helpers/marker-config.js';
import { UPSTREAM_CALLS } from '../helpers/upstream-calls.js';
import type { WireError } from '../helpers/wire-error.js';

vi.mock('@/config/server-config.js', () => import('../helpers/marker-config.js'));

const fetchMock = vi.fn();

type AnyDefinition = Parameters<typeof runToolContract>[0];
type AnyInput = Parameters<typeof runToolContract>[1];

function entryFor(definition: AnyDefinition, reason: string): ErrorContract | undefined {
  return ((definition.errors ?? []) as readonly ErrorContract[]).find(
    (entry) => entry.reason === reason,
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

/** Occurrences of `needle` in `haystack`. */
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const NAN_BODY =
  '{"latitude":nan,"longitude":nan,"generationtime_ms":0.0035,"utc_offset_seconds":0,"timezone":"GMT","timezone_abbreviation":"GMT"}';
const NO_DATA_ENVELOPE = '{"error":true,"reason":"No data is available for this location"}';

const SWITCH_MODELS =
  "Switch to a model whose domain includes this coordinate (any global model does), or omit models to use the tool's global default. Retrying returns the same response.";
const gridRecovery = (dataset: string) =>
  `The ${dataset} dataset's grid does not cover this coordinate — request a point inside its coverage. Retrying returns the same response.`;
/** Marine's per-call coverage-gap remedies, each closed by where no wave model has data. */
const marineRecovery = (remedy: string) =>
  `${remedy} A point on land or under sea ice has no wave data from any model, so there the remedy is a coordinate in open water. Retrying returns the same response.`;
/** With no models sent the likelier cause, land or sea ice, leads; the blend's gaps follow. */
const MARINE_NO_MODELS =
  'A point on land or under sea ice has no wave data from any model, so there the remedy is a coordinate in open water. For a point in open water, name a model in models: the default blend has gaps a single wave model can fill. Retrying returns the same response.';
const MARINE_OTHER_MODEL = marineRecovery(
  'Name another model, or omit models to read the default blend.',
);
const MARINE_BLEND_SENT = marineRecovery(
  'Name other models: best_match, the default blend, missed this coordinate too, so omitting models will not reach it.',
);
const NAN_REGIONAL =
  ' — the response carried nan coordinates and no data blocks, which is how a regional model reports a coordinate outside the area it covers';
const NAN_GRID =
  ' — the response carried nan coordinates and no data blocks, which is how the endpoint reports a coordinate outside the grid it covers';

/**
 * The five tools that reach a coverage gap, each in the shape and at a coordinate the
 * live API answers that way, with the message the service already writes for it.
 */
const COVERAGE_GAP_CASES = [
  {
    tool: definitions.openmeteoGetForecastTool,
    input: {
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m'],
      models: ['icon_d2'],
    },
    response: () => new Response(NO_DATA_ENVELOPE, { status: 400 }),
    message: `Open-Meteo returned no data for this location (47.6, -122.3). ${SWITCH_MODELS}`,
    recovery: SWITCH_MODELS,
  },
  {
    tool: definitions.openmeteoGetEnsembleTool,
    input: {
      latitude: 47.6,
      longitude: -122.3,
      hourly_variables: ['temperature_2m'],
      models: 'icon_d2_eps',
    },
    response: () => new Response(NAN_BODY, { status: 200 }),
    message: `Open-Meteo returned no data for this location (47.6, -122.3)${NAN_REGIONAL}. ${SWITCH_MODELS}`,
    recovery: SWITCH_MODELS,
  },
  {
    tool: definitions.openmeteoGetHistoricalTool,
    input: {
      latitude: 47.6,
      longitude: -122.3,
      start_date: '2024-07-01',
      end_date: '2024-07-02',
      daily_variables: ['temperature_2m_max'],
      models: ['cerra'],
    },
    response: () => new Response(NO_DATA_ENVELOPE, { status: 400 }),
    message: `Open-Meteo returned no data for this location (47.6, -122.3). ${SWITCH_MODELS}`,
    recovery: SWITCH_MODELS,
  },
  {
    tool: definitions.openmeteoGetMarineTool,
    input: { latitude: -90, longitude: 0, hourly_variables: ['wave_height'] },
    response: () => new Response(NO_DATA_ENVELOPE, { status: 400 }),
    message: `Open-Meteo returned no data for this location (-90, 0). ${MARINE_NO_MODELS}`,
    recovery: MARINE_NO_MODELS,
  },
  {
    tool: definitions.openmeteoGetFloodTool,
    input: { latitude: -90, longitude: 0, daily_variables: ['river_discharge'] },
    response: () => new Response(NAN_BODY, { status: 200 }),
    message: `Open-Meteo returned no data for this location (-90, 0)${NAN_GRID}. ${gridRecovery('flood')}`,
    recovery: gridRecovery('flood'),
  },
] as const;

const EXHAUSTED_MESSAGE = 'Open-Meteo API unavailable after 3 attempts.';

const timeoutRejection = () =>
  Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));

/** The outage shapes the retry loop spends its attempts on, other than the timeout. */
const OUTAGES = [
  [
    'a 503 envelope',
    () => Promise.resolve(new Response('{"error":true,"reason":"upstream down"}', { status: 503 })),
  ],
  [
    'a CDN HTML page',
    () =>
      Promise.resolve(
        new Response('<!DOCTYPE html><html><body>502</body></html>', { status: 502 }),
      ),
  ],
  ['an unreachable host', () => Promise.reject(new TypeError('fetch failed'))],
] as const;

const OUTAGE_CASES = UPSTREAM_CALLS.flatMap((call) =>
  OUTAGES.map(([shape, respond]) => ({ ...call, shape, respond })),
);

/**
 * Headers, the first bytes of a body, then nothing until the request's signal aborts —
 * when the stream errors with the signal's reason, as a real `fetch` body read does
 * (verified on Node and Bun against a loopback server; see the service suite).
 */
const stalledBody = (_url: string, init?: RequestInit) => {
  const signal = init?.signal as AbortSignal;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"latitude":47.6,'));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
  return Promise.resolve(new Response(body, { status: 200 }));
};

/**
 * `AbortSignal.timeout` on the faked clock, aborting with the reason the real timer uses,
 * so the per-attempt timeout fires while a {@link stalledBody} is being read.
 */
const fakeClockTimeout = (ms: number): AbortSignal => {
  const controller = new AbortController();
  setTimeout(
    () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    ms,
  );
  return controller.signal;
};

describe('upstream failure contracts (#77)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    initOpenMeteoService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('coverage_gap', () => {
    it('is declared on exactly the five tools that reach it', () => {
      const declaring = Object.values(definitions)
        .filter((definition) => entryFor(definition as AnyDefinition, 'coverage_gap'))
        .map((definition) => definition.name)
        .sort();
      expect(declaring).toEqual(COVERAGE_GAP_CASES.map(({ tool }) => tool.name).sort());
    });

    it.each([
      definitions.openmeteoGetAirQualityTool,
      definitions.openmeteoGetClimateTool,
      definitions.openmeteoGetElevationTool,
      definitions.openmeteoSearchLocationsTool,
    ])('$name declares no coverage_gap', (tool) => {
      expect(entryFor(tool as AnyDefinition, 'coverage_gap')).toBeUndefined();
    });

    it.each(COVERAGE_GAP_CASES)(
      '$tool.name declares it as a service-thrown ValidationError with no retryable',
      ({ tool, recovery }) => {
        const entry = entryFor(tool as AnyDefinition, 'coverage_gap');
        expect(entry).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          thrownBy: 'service',
          recovery,
        });
        expect(entry).not.toHaveProperty('retryable');
      },
    );

    it.each(COVERAGE_GAP_CASES)(
      '$tool.name answers a coverage gap with the declared reason and recovery, after one request',
      async ({ tool, input, response, message, recovery }) => {
        fetchMock.mockImplementation(() => Promise.resolve(response()));

        const { result, error, text } = await failedCall(
          runToolContract(tool as AnyDefinition, input as AnyInput),
        );

        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.message).toBe(message);
        expect(error.data).toEqual({ reason: 'coverage_gap', recovery: { hint: recovery } });
        // The message already carries the recovery sentence, so content[] states it once.
        expect(occurrences(text, recovery)).toBe(1);
        expect(text).not.toContain('Recovery:');
        expect(text).toContain('reason coverage_gap');
        for (const marker of URL_MARKERS) expect(JSON.stringify(result)).not.toContain(marker);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      },
    );

    it('answers a marine call whose models all miss the point with its own remedy alone (#104)', async () => {
      // Live: models=ewam at 45, −30 — ewam covers Europe only. The declared recovery is
      // the sentence of a call without models; this call carries its own hint.
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(NO_DATA_ENVELOPE, { status: 400 })),
      );

      const { error, text } = await failedCall(
        runToolContract(
          definitions.openmeteoGetMarineTool as AnyDefinition,
          {
            latitude: 45,
            longitude: -30,
            hourly_variables: ['wave_height'],
            models: ['ewam'],
          } as AnyInput,
        ),
      );

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toBe(
        `Open-Meteo returned no data for this location (45, -30). ${MARINE_OTHER_MODEL}`,
      );
      expect(error.data).toEqual({
        reason: 'coverage_gap',
        recovery: { hint: MARINE_OTHER_MODEL },
      });
      expect(occurrences(text, MARINE_OTHER_MODEL)).toBe(1);
      expect(text).not.toContain('Recovery:');
      expect(text).not.toMatch(/global|grid does not cover/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([[['best_match']], [['best_match', 'ecmwf_wam']]])(
      'answers a marine call with models %j, the default blend among them, with other models and open water',
      async (models) => {
        // Live: models=best_match at −90, 0 answers HTTP 400 "No data is available for this
        // location", the default blend's own gap; every global wave model returns all-null
        // columns there, so omitting models cannot reach the point and no model may either.
        fetchMock.mockImplementation(() =>
          Promise.resolve(new Response(NO_DATA_ENVELOPE, { status: 400 })),
        );

        const { error, text } = await failedCall(
          runToolContract(
            definitions.openmeteoGetMarineTool as AnyDefinition,
            { latitude: -90, longitude: 0, hourly_variables: ['wave_height'], models } as AnyInput,
          ),
        );

        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.message).toBe(
          `Open-Meteo returned no data for this location (-90, 0). ${MARINE_BLEND_SENT}`,
        );
        expect(error.data).toEqual({
          reason: 'coverage_gap',
          recovery: { hint: MARINE_BLEND_SENT },
        });
        expect(occurrences(text, MARINE_BLEND_SENT)).toBe(1);
        expect(text).not.toMatch(/switch|global|grid does not cover/i);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe('upstream_rejected (#99)', () => {
    /** Open-Meteo's own answer to a path its host does not serve — a misrouted base URL. */
    const NOT_FOUND_ENVELOPE = '{"error":true,"reason":"Not Found"}';
    const REJECTED_404 =
      "Open-Meteo answered HTTP 404 without an input rejection, so the request's arguments did not cause this.";

    it('is declared on exactly the nine upstream-calling tools', () => {
      const declaring = Object.values(definitions)
        .filter((definition) => entryFor(definition as AnyDefinition, 'upstream_rejected'))
        .map((definition) => definition.name)
        .sort();
      expect(declaring).toEqual(UPSTREAM_CALLS.map(({ tool }) => tool.name).sort());
    });

    it.each(UPSTREAM_CALLS)(
      '$tool.name declares it as a service-thrown, non-retryable ServiceUnavailable naming the operator',
      ({ tool }) => {
        const entry = entryFor(tool as AnyDefinition, 'upstream_rejected');
        expect(entry).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          thrownBy: 'service',
          retryable: false,
        });
        expect(entry?.recovery).toContain('retrying will not clear it');
        expect(entry?.recovery).toContain('whoever operates this server');
      },
    );

    it.each(UPSTREAM_CALLS)(
      "$tool.name answers Open-Meteo's routing 404 with upstream_rejected and its recovery, after one request",
      async ({ tool, input }) => {
        fetchMock.mockImplementation(() =>
          Promise.resolve(new Response(NOT_FOUND_ENVELOPE, { status: 404 })),
        );
        const recovery = entryFor(tool as AnyDefinition, 'upstream_rejected')?.recovery;

        const { result, error, text } = await failedCall(
          runToolContract(tool as AnyDefinition, input as AnyInput),
        );

        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.message).toBe(REJECTED_404);
        expect(error.data).toEqual({
          reason: 'upstream_rejected',
          status: 404,
          retryable: false,
          recovery: { hint: recovery },
        });
        expect(text).toContain(`Recovery: ${recovery}`);
        expect(text).toContain('reason upstream_rejected · not retryable');
        // No handler framed the upstream reason as an input error.
        expect(text).not.toContain('Upstream:');
        for (const marker of URL_MARKERS) expect(JSON.stringify(result)).not.toContain(marker);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe('upstream_unavailable and upstream_timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    /** Run a call to settlement, with the clock moved well past the whole backoff. */
    const settle = async (tool: AnyDefinition, input: AnyInput) => {
      const pending = failedCall(runToolContract(tool, input));
      await vi.advanceTimersByTimeAsync(10_000);
      return pending;
    };

    it.each(['upstream_unavailable', 'upstream_timeout'])(
      '%s is declared on exactly the nine upstream-calling tools',
      (reason) => {
        const declaring = Object.values(definitions)
          .filter((definition) => entryFor(definition as AnyDefinition, reason))
          .map((definition) => definition.name)
          .sort();
        expect(declaring).toEqual(UPSTREAM_CALLS.map(({ tool }) => tool.name).sort());
      },
    );

    it.each(UPSTREAM_CALLS)(
      '$tool.name declares both as service-thrown ServiceUnavailable with no retryable',
      ({ tool }) => {
        const unavailable = entryFor(tool as AnyDefinition, 'upstream_unavailable');
        const timedOut = entryFor(tool as AnyDefinition, 'upstream_timeout');
        for (const entry of [unavailable, timedOut]) {
          expect(entry).toMatchObject({
            code: JsonRpcErrorCode.ServiceUnavailable,
            thrownBy: 'service',
          });
          expect(entry).not.toHaveProperty('retryable');
        }
        // A timeout can be the request's own size, so its recovery offers narrowing too.
        expect(timedOut?.recovery).not.toBe(unavailable?.recovery);
        expect(timedOut?.recovery).toMatch(/\b(narrow|less|fewer)\b/i);
      },
    );

    it.each(UPSTREAM_CALLS)(
      '$tool.name answers three timeouts with upstream_timeout and its recovery',
      async ({ tool, input }) => {
        fetchMock.mockImplementation(timeoutRejection);
        const recovery = entryFor(tool as AnyDefinition, 'upstream_timeout')?.recovery;

        const { result, error, text } = await settle(tool as AnyDefinition, input as AnyInput);

        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.message).toBe(EXHAUSTED_MESSAGE);
        expect(error.data).toEqual({
          reason: 'upstream_timeout',
          retryAttempts: 3,
          recovery: { hint: recovery },
        });
        expect(text).toContain(`Recovery: ${recovery}`);
        expect(text).toContain('reason upstream_timeout');
        for (const marker of URL_MARKERS) expect(JSON.stringify(result)).not.toContain(marker);
        expect(fetchMock).toHaveBeenCalledTimes(3);
      },
    );

    it.each(UPSTREAM_CALLS)(
      '$tool.name answers three timeouts that fire mid-body with upstream_timeout and its recovery',
      async ({ tool, input }) => {
        vi.spyOn(AbortSignal, 'timeout').mockImplementation(fakeClockTimeout);
        fetchMock.mockImplementation(stalledBody);
        const recovery = entryFor(tool as AnyDefinition, 'upstream_timeout')?.recovery;

        // Three 15 s attempt timeouts plus the 0.5 s and 1 s backoffs.
        const pending = failedCall(runToolContract(tool as AnyDefinition, input as AnyInput));
        await vi.advanceTimersByTimeAsync(60_000);
        const { result, error, text } = await pending;

        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.message).toBe(EXHAUSTED_MESSAGE);
        expect(error.data).toEqual({
          reason: 'upstream_timeout',
          retryAttempts: 3,
          recovery: { hint: recovery },
        });
        expect(text).toContain(`Recovery: ${recovery}`);
        expect(text).toContain('reason upstream_timeout');
        for (const marker of URL_MARKERS) expect(JSON.stringify(result)).not.toContain(marker);
        expect(fetchMock).toHaveBeenCalledTimes(3);
      },
    );

    it('answers a caller cancel mid-body as cancellation, not an outage', async () => {
      const controller = new AbortController();
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const response = stalledBody(url, init);
        setTimeout(() => controller.abort(), 100);
        return response;
      });

      const pending = failedCall(
        runToolContract(
          definitions.openmeteoGetForecastTool as AnyDefinition,
          { latitude: 47.6, longitude: -122.3, hourly_variables: ['temperature_2m'] } as AnyInput,
          { context: { signal: controller.signal } },
        ),
      );
      await vi.advanceTimersByTimeAsync(60_000);
      const { error, text } = await pending;

      expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
      // The abort's own wording, not an outage message rewrapped as a cancellation.
      expect(error.message).toBe((controller.signal.reason as Error).message);
      expect(error.data?.reason).toBeUndefined();
      expect(text).not.toContain('Open-Meteo');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(OUTAGE_CASES)(
      '$tool.name answers three attempts of $shape with upstream_unavailable and its recovery',
      async ({ tool, input, respond }) => {
        fetchMock.mockImplementation(respond);
        const recovery = entryFor(tool as AnyDefinition, 'upstream_unavailable')?.recovery;

        const { result, error, text } = await settle(tool as AnyDefinition, input as AnyInput);

        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.message).toBe(EXHAUSTED_MESSAGE);
        expect(error.data).toEqual({
          reason: 'upstream_unavailable',
          retryAttempts: 3,
          recovery: { hint: recovery },
        });
        expect(text).toContain(`Recovery: ${recovery}`);
        expect(text).toContain('reason upstream_unavailable');
        for (const marker of URL_MARKERS) expect(JSON.stringify(result)).not.toContain(marker);
        expect(fetchMock).toHaveBeenCalledTimes(3);
      },
    );

    it.each([
      [
        'a timeout then two 503s',
        [timeoutRejection, OUTAGES[0][1], OUTAGES[0][1]],
        'upstream_unavailable',
      ],
      [
        'two 503s then a timeout',
        [OUTAGES[0][1], OUTAGES[0][1], timeoutRejection],
        'upstream_timeout',
      ],
      [
        'an unreachable host, a timeout, then HTML',
        [OUTAGES[2][1], timeoutRejection, OUTAGES[1][1]],
        'upstream_unavailable',
      ],
    ] as const)('tags a mixed ladder of %s by its last attempt', async (_label, ladder, reason) => {
      let call = 0;
      fetchMock.mockImplementation(() => (ladder[call++] ?? timeoutRejection)());
      const tool = definitions.openmeteoGetForecastTool as AnyDefinition;

      const { error } = await settle(tool, {
        latitude: 47.6,
        longitude: -122.3,
        hourly_variables: ['temperature_2m'],
      } as AnyInput);

      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toBe(EXHAUSTED_MESSAGE);
      expect(error.data).toEqual({
        reason,
        retryAttempts: 3,
        recovery: { hint: entryFor(tool, reason)?.recovery },
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});
