/**
 * @fileoverview Open-Meteo API client. Wraps all nine endpoints (forecast, archive,
 * marine, air quality, geocoding, elevation, ensemble, flood, climate) with retry logic,
 * timeout, and error envelope detection. Returns raw API responses — reshaping to
 * per-timestamp records is the tool handler's responsibility.
 * @module services/open-meteo/open-meteo-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  rateLimited,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { coverageGapRecovery, isModelCapable, type OpenMeteoOperation } from './coverage-gap.js';
import type {
  ElevationResponse,
  EnsembleEnvelope,
  FloodEnvelope,
  GeocodingResponse,
  WeatherEnvelope,
} from './types.js';

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * A body carrying a bare `nan` where a coordinate belongs:
 * `{"latitude":nan,"longitude":nan,…}` with no data blocks. Most regional ensemble
 * models answer a coordinate outside the area they cover with this and HTTP 200,
 * rather than the `No data is available for this location` envelope the
 * `meteoswiss_*` pair returns.
 *
 * `nan` is not valid JSON, so left alone this reaches `JSON.parse`, throws, and is
 * classified as an unparseable — and therefore retryable — response. The retry loop
 * then burns three attempts on a request that can never succeed and reports a
 * transient outage for what is an input error. Matching the body shape here turns it
 * into the non-retryable rejection the caller can act on. A bare `nan` token cannot
 * appear in valid JSON, so there is nothing for this to false-positive on.
 *
 * Anchored at the head, where every observed instance of the shape puts it — which
 * also keeps a multi-megabyte success response off a full-body scan. A body that put
 * the token elsewhere would fall through to the parse failure below and retry, which
 * is the behavior this replaces rather than a new failure mode.
 */
const NAN_COORDINATE_BODY = /^\s*\{\s*"latitude"\s*:\s*nan\b/;

/**
 * The error-envelope half of the same coverage gap: the `meteoswiss_*` ensemble pair
 * reports an out-of-domain coordinate as a 4xx `{"error":true,"reason":"No data is
 * available for this location"}` where the other regional models answer HTTP 200 with
 * {@link NAN_COORDINATE_BODY}. Returning this envelope to a handler instead frames it
 * through the unknown-variable path, which leads with the spelling of a name rather
 * than the coordinate. Both shapes leave the client as the same rejection.
 */
const NO_DATA_REASON = /^no data is available for this location/i;

/**
 * A bare `nan` standing as an array element. The elevation endpoint writes one, with
 * HTTP 200, for a point the Copernicus DEM has no value for (latitude 90, longitude
 * 180) — `{"elevation":[325.0, nan]}`. Left alone it fails `JSON.parse`, is classified
 * as a transient unparseable response, and the retry loop discards every usable
 * reading in the batch to report an outage. Read as `null` on the elevation response
 * only; on the gridded endpoints a stray `nan` keeps its unparseable classification.
 */
const NAN_ARRAY_ELEMENT = /(?<=[[,]\s*)nan(?=\s*[\],])/g;

/**
 * Identifies the call for a coverage-gap rejection. Both shape checks fire inside
 * {@link openMeteoFetch}, which sees only the built URL, so the two facts the message
 * needs travel with the call: which endpoint asked, and the coordinate it asked about.
 */
interface RequestOrigin {
  /**
   * The coordinate as the caller supplied it, before upstream snaps it to a grid point.
   * Absent on `geocode` and `elevation`, neither of which carries a single pair —
   * neither can produce either coverage-gap shape (their responses have no top-level
   * `latitude`, and neither serves a gridded dataset), so they fall through to the
   * coordinate-free wording only in principle.
   */
  coordinate?: { latitude: number; longitude: number } | undefined;
  /** Per-endpoint label — the retry `operation`, and the dataset the wording names. */
  operation: OpenMeteoOperation;
}

/**
 * The coverage-gap rejection for either shape. The recovery half splits on whether the
 * calling endpoint exposes `models` (see {@link coverageGapRecovery}). Non-retryable in
 * both branches — the same request returns the same body.
 *
 * `data.reason` names the `coverage_gap` entry the tools that reach a gap declare with
 * this same recovery sentence, so the handler boundary fills it onto the wire and
 * `content[]` still states it once.
 */
function coverageGapError(origin: RequestOrigin, fromNanBody: boolean): McpError {
  const modelCapable = isModelCapable(origin.operation);
  const at = origin.coordinate
    ? ` (${origin.coordinate.latitude}, ${origin.coordinate.longitude})`
    : '';
  const shape = fromNanBody
    ? ' — the response carried nan coordinates and no data blocks, which is how ' +
      (modelCapable
        ? 'a regional model reports a coordinate outside the area it covers'
        : 'the endpoint reports a coordinate outside the grid it covers')
    : '';
  return validationError(
    `Open-Meteo returned no data for this location${at}${shape}. ${coverageGapRecovery(origin.operation)}`,
    { reason: 'coverage_gap' },
  );
}

/**
 * Named separately from the reason-bearing wording below because it is the half a
 * caller needs when upstream sends no envelope: the free tier enforces per-minute,
 * per-hour, and per-day limits, and which one was hit decides the wait.
 */
const RATE_LIMIT_WINDOWS =
  'Open-Meteo enforces separate per-minute, per-hour, and per-day free-tier limits, so how ' +
  'long the wait is depends on which one was reached.';

/** True of every windowed rate-limit rejection: the window reopens on a clock, not on a retry. */
const RATE_LIMIT_RETRY = 'Retrying immediately returns the same response.';

/**
 * Open-Meteo's per-address concurrency cap also answers 429, with the reason `Too many
 * concurrent requests`, to a request that arrives while five from the same address are
 * already running or queued. It names no window and clears as soon as those finish.
 */
const CONCURRENCY_REASON = /^too many concurrent requests/i;
const CONCURRENCY_RETRY = 'Retry in a few seconds, once the requests already in flight finish.';

/**
 * The rejection for HTTP 429, built from the body when it carries an envelope.
 *
 * A 429 names its own window — `Daily API request limit exceeded. Please try again
 * tomorrow.` is a maintainer-quoted example — so relaying that sentence is both more
 * accurate and more actionable than any fixed wording this module could assert. The
 * generic branch names all three windows rather than promising one, which is what the
 * hardcoded "Retry in a minute" it replaces got wrong on a daily quota.
 *
 * `data.reason` names the `rate_limited` entry every upstream-calling tool declares, so
 * the handler boundary fills that entry's `recovery` onto the wire.
 */
function rateLimitError(text: string): McpError {
  let reason: string | undefined;
  try {
    const reported = (JSON.parse(text) as Record<string, unknown> | null)?.reason;
    if (typeof reported === 'string' && reported.trim() !== '') reason = reported.trim();
  } catch {
    /* An edge 429 answers with plain text or an HTML page — the status still classifies it. */
  }

  let message = `Open-Meteo rate limit reached (HTTP 429). ${RATE_LIMIT_WINDOWS} ${RATE_LIMIT_RETRY}`;
  if (reason) {
    const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;
    const next = CONCURRENCY_REASON.test(reason) ? CONCURRENCY_RETRY : RATE_LIMIT_RETRY;
    message = `Open-Meteo rate limit reached: ${sentence} ${next}`;
  }
  return rateLimited(message, { reason: 'rate_limited' });
}

/**
 * A 429 from the per-address concurrency cap — the one rate limit a short backoff can
 * clear. Matched on the message this module wrote, which `withRetry` keeps as the
 * prefix of the error it rethrows once the attempts run out.
 */
function isConcurrencyLimit(error: unknown): error is McpError {
  return (
    error instanceof McpError &&
    error.code === JsonRpcErrorCode.RateLimited &&
    error.message.includes(CONCURRENCY_RETRY)
  );
}

/**
 * Which failures the retry loop is allowed to spend attempts on.
 *
 * A windowed `RateLimited` is deliberately absent. Its window reopens on a fixed
 * schedule — a minute, an hour, or a day — and the whole retry budget is 1.5s of
 * backoff across three attempts, so retrying one can only ever fail three times: this
 * predicate replaces the framework's default entirely, so an error it admits is one
 * `withRetry` will retry. The concurrency 429 is the exception, since it clears as soon
 * as the address's in-flight requests finish.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof McpError) {
    return (
      [JsonRpcErrorCode.ServiceUnavailable, JsonRpcErrorCode.Timeout].includes(error.code) ||
      isConcurrencyLimit(error)
    );
  }
  return false;
}

/**
 * Classifies a transport failure from either phase of an attempt: waiting for headers
 * (refused, reset, DNS) or reading the body after they arrived (a reset mid-body). The
 * per-attempt timeout spans both phases, and on Node and Bun alike it rejects the body
 * read with the timer's own `TimeoutError` `DOMException` — which the retry predicate
 * does not admit — so both phases map to the same `Timeout`. The caller's own abort is
 * returned untouched in either phase, so it surfaces as cancellation.
 */
function transportError(err: unknown, ctx: Context, phase: 'request' | 'body'): unknown {
  if (ctx.signal.aborted) return err;
  const name = err instanceof Error ? err.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return timeout(`Open-Meteo request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`, undefined, {
      cause: err,
    });
  }
  const message =
    phase === 'request'
      ? 'Open-Meteo API unreachable.'
      : 'Open-Meteo response was cut off before the body finished.';
  return serviceUnavailable(message, undefined, { cause: err });
}

/**
 * One request and the classification of its response. Request URLs never appear in
 * error data or logs: the URL is built on an operator-configured base and reaches only
 * `fetch`, while every error carries the message alone or a field the caller can act
 * on (`status`, `reason`, `retryAttempts`).
 */
async function openMeteoFetch<T>(url: string, ctx: Context, origin: RequestOrigin): Promise<T> {
  const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ctx.signal]);
  let response: Response;
  let text: string;

  try {
    response = await fetch(url, { signal });
  } catch (err) {
    throw transportError(err, ctx, 'request');
  }
  try {
    text = await response.text();
  } catch (err) {
    throw transportError(err, ctx, 'body');
  }

  // Rate limit — classified by status ahead of every body-shape check, since an edge
  // 429 can answer with an HTML page the transient guard below would otherwise retry.
  if (response.status === 429) {
    throw rateLimitError(text);
  }

  // CDN error page — treat as transient
  if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
    throw serviceUnavailable('Open-Meteo API returned HTML instead of JSON. Retry shortly.');
  }

  // Out-of-domain regional model — an input error wearing an unparseable body.
  // See NAN_COORDINATE_BODY. Non-retryable: the same request returns the same body.
  if (NAN_COORDINATE_BODY.test(text)) {
    throw coverageGapError(origin, true);
  }

  const json = origin.operation === 'elevation' ? text.replace(NAN_ARRAY_ELEMENT, 'null') : text;
  let body: T;
  try {
    body = JSON.parse(json) as T;
  } catch (err) {
    throw serviceUnavailable('Open-Meteo API returned unparseable response.', undefined, {
      cause: err,
    });
  }

  // Open-Meteo error envelope: { "error": true, "reason": "..." }
  // 5xx envelopes are transient — throw immediately so the retry loop fires.
  // 4xx envelopes carry input-error context that tool handlers need to classify;
  // return the body so handlers can call ctx.fail() with the correct contract reason.
  const asRecord = body as Record<string, unknown>;
  if (asRecord.error === true && response.status >= 500) {
    const reason = typeof asRecord.reason === 'string' ? asRecord.reason : 'Unknown error';
    throw serviceUnavailable(`Open-Meteo API error: ${reason}`, { status: response.status });
  }

  // See NO_DATA_REASON — the envelope half of the out-of-domain regional-model shape.
  if (asRecord.error === true && NO_DATA_REASON.test(String(asRecord.reason ?? ''))) {
    throw coverageGapError(origin, false);
  }

  if (!response.ok) {
    if (response.status >= 500) {
      throw serviceUnavailable(`Open-Meteo API returned ${response.status}.`);
    }
    // 4xx without an error envelope — throw as validation error.
    // 4xx WITH an error envelope: body is returned above so handlers can attach the contract reason.
    if (!(asRecord.error === true)) {
      throw validationError(`Open-Meteo API returned ${response.status}.`);
    }
  }

  return body;
}

function withOpenMeteoRetry<T>(url: string, ctx: Context, origin: RequestOrigin): Promise<T> {
  let attempts = 0;
  return withRetry(
    async () => {
      attempts += 1;
      if (attempts > 1) {
        ctx.log.info('Retrying Open-Meteo request', {
          operation: origin.operation,
          attempt: attempts - 1,
        });
      }
      return await openMeteoFetch<T>(url, ctx, origin);
    },
    {
      maxRetries: MAX_RETRIES,
      baseDelayMs: RETRY_DELAY_MS,
      maxDelayMs: RETRY_DELAY_MS * Math.max(MAX_RETRIES, 1),
      jitter: 0,
      operation: origin.operation,
      context: ctx,
      signal: ctx.signal,
      isTransient: isRetryable,
    },
  ).catch((err) => {
    // A concurrency 429 that outlasts the retries stays a rate limit, so the caller gets
    // its own recovery rather than an outage; `data` keeps the attempt count only.
    if (isConcurrencyLimit(err) && !ctx.signal.aborted) {
      throw rateLimited(
        err.message,
        { reason: 'rate_limited', retryAttempts: attempts },
        { cause: err },
      );
    }
    if (!isRetryable(err) || ctx.signal.aborted) throw err;
    /**
     * One outage message whatever the ladder hit, but the reason follows the last
     * attempt: a run that ended on the per-attempt timeout is one a smaller request may
     * clear, so it names its own entry — whether it fired before the headers or during
     * the body read. `withRetry` keeps the last attempt's code on the error it rethrows;
     * anything else it admitted is an outage.
     */
    const reason =
      err instanceof McpError && err.code === JsonRpcErrorCode.Timeout
        ? 'upstream_timeout'
        : 'upstream_unavailable';
    throw serviceUnavailable(
      `Open-Meteo API unavailable after ${attempts} attempt${attempts === 1 ? '' : 's'}.`,
      { reason, retryAttempts: attempts },
      { cause: err },
    );
  });
}

// ---------------------------------------------------------------------------
// Forecast query params
// ---------------------------------------------------------------------------

export interface ForecastParams {
  /** Variables to return at the current instant, forwarded as the upstream `current`. */
  current?: string[] | undefined;
  daily?: string[] | undefined;
  forecast_days?: number | undefined;
  hourly?: string[] | undefined;
  /**
   * Deterministic models to read from. Omitted selects Open-Meteo's `best_match`; with 2+
   * names every hourly and daily column comes back suffixed with the model, while
   * `current` stays one unsuffixed block from the first listed model covering the point.
   */
  models?: string[] | undefined;
  past_days?: number | undefined;
  precipitation_unit?: string | undefined;
  temperature_unit?: string | undefined;
  timezone?: string | undefined;
  wind_speed_unit?: string | undefined;
}

export interface HistoricalParams {
  daily?: string[] | undefined;
  end_date: string;
  hourly?: string[] | undefined;
  /**
   * Archive models to read from. Omitted selects Open-Meteo's Best Match blend
   * (IFS HRES + ERA5 + ERA5-Land); with 2+ names the variable columns come back
   * suffixed with the model, as the climate endpoint does.
   */
  models?: string[] | undefined;
  precipitation_unit?: string | undefined;
  start_date: string;
  temperature_unit?: string | undefined;
  timezone?: string | undefined;
  wind_speed_unit?: string | undefined;
}

/**
 * Marine and air quality both serve a forecast window (`forecast_days` + `past_days`)
 * or an archive range (`start_date` + `end_date`), never both — upstream rejects the
 * combination outright. Tool handlers pick one set before calling.
 */
export interface MarineParams {
  /** Variables to return at the current instant, forwarded as the upstream `current`. */
  current?: string[] | undefined;
  daily?: string[] | undefined;
  end_date?: string | undefined;
  forecast_days?: number | undefined;
  hourly?: string[] | undefined;
  /** `imperial` returns wave, swell, and sea-level heights in ft; omitted means m. */
  length_unit?: string | undefined;
  past_days?: number | undefined;
  start_date?: string | undefined;
  /** Unit of `sea_surface_temperature`; omitted means °C. */
  temperature_unit?: string | undefined;
  timezone?: string | undefined;
  /** Unit of `ocean_current_velocity`; omitted means km/h. */
  wind_speed_unit?: string | undefined;
}

export interface AirQualityParams {
  /** Variables to return at the current instant, forwarded as the upstream `current`. */
  current?: string[] | undefined;
  end_date?: string | undefined;
  forecast_days?: number | undefined;
  hourly?: string[] | undefined;
  past_days?: number | undefined;
  start_date?: string | undefined;
  timezone?: string | undefined;
}

export interface EnsembleParams {
  daily?: string[] | undefined;
  forecast_days?: number | undefined;
  hourly?: string[] | undefined;
  models?: string | undefined;
  past_days?: number | undefined;
  precipitation_unit?: string | undefined;
  temperature_unit?: string | undefined;
  timezone?: string | undefined;
  wind_speed_unit?: string | undefined;
}

export interface FloodParams {
  daily: string[];
  end_date?: string | undefined;
  forecast_days?: number | undefined;
  models?: string[] | undefined;
  start_date?: string | undefined;
  timezone?: string | undefined;
}

export interface ClimateParams {
  daily: string[];
  end_date: string;
  models?: string[] | undefined;
  precipitation_unit?: string | undefined;
  start_date: string;
  temperature_unit?: string | undefined;
  timezone?: string | undefined;
  wind_speed_unit?: string | undefined;
}

// ---------------------------------------------------------------------------
// Public service class
// ---------------------------------------------------------------------------

export class OpenMeteoService {
  /**
   * Geocode a place name; returns the raw API response (results key absent on no-match).
   * `country` is an optional ISO 3166-1 alpha-2 code (uppercase) mapped to the upstream
   * `countryCode` filter — narrows matches to that country; omit for a global search.
   */
  getGeocode(
    name: string,
    count: number,
    language: string,
    country: string | undefined,
    ctx: Context,
  ): Promise<GeocodingResponse> {
    const { geocodingBaseUrl } = getServerConfig();
    const url = openMeteoUrl(`${geocodingBaseUrl}/v1/search`, {
      name,
      count,
      language,
      countryCode: country,
      format: 'json',
    });
    ctx.log.info('Geocoding place', { name, count, language, country });
    return withOpenMeteoRetry<GeocodingResponse>(url, ctx, { operation: 'geocode' });
  }

  /** Forecast endpoint — hourly/daily for up to 16 days forward, 92 days back. */
  getForecast(
    lat: number,
    lon: number,
    params: ForecastParams,
    ctx: Context,
  ): Promise<WeatherEnvelope> {
    const { apiBaseUrl } = getServerConfig();
    const url = buildWeatherUrl(`${apiBaseUrl}/v1/forecast`, lat, lon, params);
    ctx.log.info('Fetching forecast', {
      lat,
      lon,
      forecast_days: params.forecast_days,
      models: params.models,
    });
    return withOpenMeteoRetry<WeatherEnvelope>(url, ctx, {
      operation: 'forecast',
      coordinate: { latitude: lat, longitude: lon },
    });
  }

  /**
   * Historical archive endpoint — date range required. Omitting `models` selects
   * Open-Meteo's Best Match blend (IFS HRES + ERA5 + ERA5-Land), not pure ERA5.
   */
  getHistorical(
    lat: number,
    lon: number,
    params: HistoricalParams,
    ctx: Context,
  ): Promise<WeatherEnvelope> {
    const { archiveBaseUrl } = getServerConfig();
    const url = buildWeatherUrl(`${archiveBaseUrl}/v1/archive`, lat, lon, params);
    ctx.log.info('Fetching historical', {
      lat,
      lon,
      start: params.start_date,
      end: params.end_date,
      models: params.models,
    });
    return withOpenMeteoRetry<WeatherEnvelope>(url, ctx, {
      operation: 'historical',
      coordinate: { latitude: lat, longitude: lon },
    });
  }

  /** Marine endpoint — wave, swell, ocean variables; forecast window or archive range. */
  getMarine(
    lat: number,
    lon: number,
    params: MarineParams,
    ctx: Context,
  ): Promise<WeatherEnvelope> {
    const { marineBaseUrl } = getServerConfig();
    const url = buildWeatherUrl(`${marineBaseUrl}/v1/marine`, lat, lon, params);
    ctx.log.info('Fetching marine data', {
      lat,
      lon,
      forecast_days: params.forecast_days,
      past_days: params.past_days,
      start_date: params.start_date,
      end_date: params.end_date,
    });
    return withOpenMeteoRetry<WeatherEnvelope>(url, ctx, {
      operation: 'marine',
      coordinate: { latitude: lat, longitude: lon },
    });
  }

  /** CAMS Air Quality endpoint — forecast window or archive range. */
  getAirQuality(
    lat: number,
    lon: number,
    params: AirQualityParams,
    ctx: Context,
  ): Promise<WeatherEnvelope> {
    const { airQualityBaseUrl } = getServerConfig();
    const url = buildWeatherUrl(`${airQualityBaseUrl}/v1/air-quality`, lat, lon, params);
    ctx.log.info('Fetching air quality', {
      lat,
      lon,
      forecast_days: params.forecast_days,
      past_days: params.past_days,
      start_date: params.start_date,
      end_date: params.end_date,
    });
    return withOpenMeteoRetry<WeatherEnvelope>(url, ctx, {
      operation: 'air-quality',
      coordinate: { latitude: lat, longitude: lon },
    });
  }

  /** Ensemble forecast endpoint — per-member hourly/daily time series up to 35 days. */
  getEnsemble(
    lat: number,
    lon: number,
    params: EnsembleParams,
    ctx: Context,
  ): Promise<EnsembleEnvelope> {
    const { ensembleBaseUrl } = getServerConfig();
    const url = openMeteoUrl(`${ensembleBaseUrl}/v1/ensemble`, {
      latitude: lat,
      longitude: lon,
      hourly: params.hourly,
      daily: params.daily,
      models: params.models,
      forecast_days: params.forecast_days,
      past_days: params.past_days,
      temperature_unit: params.temperature_unit,
      wind_speed_unit: params.wind_speed_unit,
      precipitation_unit: params.precipitation_unit,
      timezone: params.timezone ?? 'auto',
    });

    ctx.log.info('Fetching ensemble forecast', {
      lat,
      lon,
      models: params.models,
      forecast_days: params.forecast_days,
    });
    return withOpenMeteoRetry<EnsembleEnvelope>(url, ctx, {
      operation: 'ensemble',
      coordinate: { latitude: lat, longitude: lon },
    });
  }

  /**
   * GloFAS Flood endpoint — daily river discharge. An omitted `models` reads upstream's
   * `seamless_v4`; with 2+ models every daily column comes back suffixed with the model name.
   */
  getFlood(lat: number, lon: number, params: FloodParams, ctx: Context): Promise<FloodEnvelope> {
    const { floodBaseUrl } = getServerConfig();
    const url = openMeteoUrl(`${floodBaseUrl}/v1/flood`, {
      latitude: lat,
      longitude: lon,
      daily: params.daily,
      models: params.models,
      forecast_days: params.forecast_days,
      start_date: params.start_date,
      end_date: params.end_date,
      timezone: params.timezone ?? 'auto',
    });

    ctx.log.info('Fetching flood forecast', {
      lat,
      lon,
      models: params.models,
      forecast_days: params.forecast_days,
      start_date: params.start_date,
      end_date: params.end_date,
    });
    return withOpenMeteoRetry<FloodEnvelope>(url, ctx, {
      operation: 'flood',
      coordinate: { latitude: lat, longitude: lon },
    });
  }

  /**
   * Climate projection endpoint — bias-corrected daily CMIP6 model data, 1950–2050.
   * With 2+ models, variable columns come back suffixed with the model name
   * (e.g. temperature_2m_max_CMCC_CM2_VHR4); a single or omitted model returns
   * unsuffixed columns. Daily-only — the API has no hourly resolution.
   */
  getClimate(
    lat: number,
    lon: number,
    params: ClimateParams,
    ctx: Context,
  ): Promise<WeatherEnvelope> {
    const { climateBaseUrl } = getServerConfig();
    const url = openMeteoUrl(`${climateBaseUrl}/v1/climate`, {
      latitude: lat,
      longitude: lon,
      start_date: params.start_date,
      end_date: params.end_date,
      daily: params.daily,
      models: params.models,
      temperature_unit: params.temperature_unit,
      wind_speed_unit: params.wind_speed_unit,
      precipitation_unit: params.precipitation_unit,
      timezone: params.timezone ?? 'auto',
    });

    ctx.log.info('Fetching climate projections', {
      lat,
      lon,
      start: params.start_date,
      end: params.end_date,
      models: params.models,
    });
    return withOpenMeteoRetry<WeatherEnvelope>(url, ctx, {
      operation: 'climate',
      coordinate: { latitude: lat, longitude: lon },
    });
  }

  /**
   * Elevation endpoint — up to 100 coordinate pairs, answered in input order. A point the
   * DEM has no value for comes back `null`. Longitude 180 is sent as -180: the same
   * meridian, which the DEM answers where it has no value at 180.
   */
  getElevation(
    latitudes: number[],
    longitudes: number[],
    ctx: Context,
  ): Promise<ElevationResponse> {
    const { apiBaseUrl } = getServerConfig();
    const url = openMeteoUrl(`${apiBaseUrl}/v1/elevation`, {
      latitude: latitudes.map(String),
      longitude: longitudes.map((lon) => String(lon === 180 ? -180 : lon)),
    });
    ctx.log.info('Fetching elevation', { count: latitudes.length });
    return withOpenMeteoRetry<ElevationResponse>(url, ctx, { operation: 'elevation' });
  }
}

// ---------------------------------------------------------------------------
// URL builder helpers
// ---------------------------------------------------------------------------

/**
 * One query parameter: a scalar, or a list that goes on the wire as a single
 * comma-joined value. `undefined`, an empty string, and an empty list are omitted
 * from the query.
 */
type QueryValue = string | number | string[] | undefined;

/**
 * Build a request URL, joining a list parameter with a LITERAL comma.
 *
 * `URLSearchParams` percent-encodes the comma, and Open-Meteo then reads the whole
 * list as one opaque value: it rejects `MRI_AGCM3_2_S%2CBOGUS_MODEL` as
 * `invalid String value MRI_AGCM3_2_S,BOGUS_MODEL`, naming a valid model alongside
 * the bad one and leaving the caller nothing to converge on. The same request with a
 * literal comma is rejected as `invalid String value BOGUS_MODEL` — upstream, the
 * authority on which names exist, isolates the offender itself, so no local catalog
 * has to re-derive it. This holds for every comma-joined parameter the service sends:
 * `models`, `hourly`, `daily`, and the coordinate lists on the elevation endpoint.
 *
 * A valid list still fans out identically — verified per endpoint against the keyless
 * API: per-model suffixed climate columns, per-variable blocks everywhere else,
 * elevations in input order. RFC 3986 lists the comma as a sub-delimiter permitted
 * unencoded in a query value, so this is a legal request rather than a trick.
 *
 * Every character that could alter the query's structure is escaped: `encodeURIComponent`
 * runs per list element and per scalar, so `&`, `=`, `#`, `?`, `%`, whitespace, and any
 * non-ASCII byte are percent-encoded, and a comma inside an element encodes to `%2C` and
 * cannot forge a separator. What it leaves literal beyond the separator — `!`, `'`, `(`,
 * `)`, `~`, `*`, and a space as `%20` rather than `+` — are all characters RFC 3986
 * permits unencoded in a query value; none is a delimiter, so none can split a parameter.
 * Keys are literals in this module and need no escaping.
 *
 * An empty value is omitted rather than sent as a bare `key=`. No Open-Meteo parameter
 * reads an empty value as a default: `models=` on the ensemble endpoint is rejected with
 * `No data is available for this location`, pointing the caller at the coordinate for
 * what is an empty field. A schema
 * that admits an empty string (a form-based client sending a blank field) therefore has
 * to reach the wire as an absent parameter, not an empty one.
 */
function openMeteoUrl(base: string, params: Record<string, QueryValue>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      parts.push(`${key}=${value.map(encodeURIComponent).join(',')}`);
    } else {
      parts.push(`${key}=${encodeURIComponent(value)}`);
    }
  }
  return `${base}?${parts.join('&')}`;
}

/**
 * The union of query fields the four columnar weather endpoints accept. Each of
 * {@link ForecastParams}, {@link HistoricalParams}, {@link MarineParams}, and
 * {@link AirQualityParams} is assignable to it, so {@link buildWeatherUrl} reads them
 * without casting through `Record<string, unknown>`; a field an endpoint does not
 * declare is simply never present, and an absent field is omitted from the query.
 */
interface WeatherQueryParams {
  current?: string[] | undefined;
  daily?: string[] | undefined;
  end_date?: string | undefined;
  forecast_days?: number | undefined;
  hourly?: string[] | undefined;
  length_unit?: string | undefined;
  models?: string[] | undefined;
  past_days?: number | undefined;
  precipitation_unit?: string | undefined;
  start_date?: string | undefined;
  temperature_unit?: string | undefined;
  timezone?: string | undefined;
  wind_speed_unit?: string | undefined;
}

function buildWeatherUrl(
  base: string,
  lat: number,
  lon: number,
  params: WeatherQueryParams,
): string {
  return openMeteoUrl(base, {
    latitude: lat,
    longitude: lon,
    current: params.current,
    hourly: params.hourly,
    daily: params.daily,
    models: params.models,
    start_date: params.start_date,
    end_date: params.end_date,
    forecast_days: params.forecast_days,
    past_days: params.past_days,
    temperature_unit: params.temperature_unit,
    wind_speed_unit: params.wind_speed_unit,
    precipitation_unit: params.precipitation_unit,
    length_unit: params.length_unit,
    timezone: params.timezone ?? 'auto',
  });
}

// ---------------------------------------------------------------------------
// Init/accessor pattern
// ---------------------------------------------------------------------------

let _service: OpenMeteoService | undefined;

export function initOpenMeteoService(): void {
  _service = new OpenMeteoService();
}

export function getOpenMeteoService(): OpenMeteoService {
  if (!_service)
    throw new Error('OpenMeteoService not initialized — call initOpenMeteoService() in setup()');
  return _service;
}
