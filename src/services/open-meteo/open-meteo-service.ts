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
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
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

/** What a caller does about either shape — one wording, so both read alike. */
const COVERAGE_GAP_RECOVERY =
  'Switch to a model whose domain includes this coordinate (any global model does), or omit ' +
  'the model to use the default blend. Retrying returns the same response.';

function isRetryable(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof McpError) {
    return [
      JsonRpcErrorCode.ServiceUnavailable,
      JsonRpcErrorCode.Timeout,
      JsonRpcErrorCode.RateLimited,
    ].includes(error.code);
  }
  return false;
}

async function openMeteoFetch<T>(url: string, ctx: Context): Promise<T> {
  const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ctx.signal]);
  let response: Response;

  try {
    response = await fetch(url, { signal });
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    const name = err instanceof Error ? err.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw timeout(
        `Open-Meteo request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`,
        { url },
        { cause: err },
      );
    }
    throw serviceUnavailable('Open-Meteo API unreachable.', { url }, { cause: err });
  }

  const text = await response.text();

  // CDN error page — treat as transient
  if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
    throw serviceUnavailable('Open-Meteo API returned HTML instead of JSON. Retry shortly.', {
      url,
    });
  }

  // Out-of-domain regional model — an input error wearing an unparseable body.
  // See NAN_COORDINATE_BODY. Non-retryable: the same request returns the same body.
  if (NAN_COORDINATE_BODY.test(text)) {
    throw validationError(
      'Open-Meteo returned no data for this location — the response carried nan coordinates and no ' +
        'data blocks, which is how a regional model reports a coordinate outside the area it covers. ' +
        COVERAGE_GAP_RECOVERY,
      { url },
    );
  }

  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch (err) {
    throw serviceUnavailable(
      'Open-Meteo API returned unparseable response.',
      { url },
      { cause: err },
    );
  }

  // Open-Meteo error envelope: { "error": true, "reason": "..." }
  // 5xx envelopes are transient — throw immediately so the retry loop fires.
  // 4xx envelopes carry input-error context that tool handlers need to classify;
  // return the body so handlers can call ctx.fail() with the correct contract reason.
  const asRecord = body as Record<string, unknown>;
  if (asRecord.error === true && response.status >= 500) {
    const reason = typeof asRecord.reason === 'string' ? asRecord.reason : 'Unknown error';
    throw serviceUnavailable(`Open-Meteo API error: ${reason}`, { url, status: response.status });
  }

  // See NO_DATA_REASON — the envelope half of the out-of-domain regional-model shape.
  if (asRecord.error === true && NO_DATA_REASON.test(String(asRecord.reason ?? ''))) {
    throw validationError(
      `Open-Meteo returned no data for this location. ${COVERAGE_GAP_RECOVERY}`,
      { url },
    );
  }

  if (!response.ok) {
    if (response.status === 429) {
      throw new McpError(
        JsonRpcErrorCode.RateLimited,
        'Open-Meteo rate limit reached. Retry in a minute.',
        { url },
      );
    }
    if (response.status >= 500) {
      throw serviceUnavailable(`Open-Meteo API returned ${response.status}.`, { url });
    }
    // 4xx without an error envelope — throw as validation error.
    // 4xx WITH an error envelope: body is returned above so handlers can attach the contract reason.
    if (!(asRecord.error === true)) {
      throw validationError(`Open-Meteo API returned ${response.status}.`, { url });
    }
  }

  return body;
}

function withOpenMeteoRetry<T>(url: string, ctx: Context, operation: string): Promise<T> {
  let attempts = 0;
  return withRetry(
    async () => {
      attempts += 1;
      if (attempts > 1) ctx.log.info('Retrying Open-Meteo request', { url, attempt: attempts - 1 });
      return await openMeteoFetch<T>(url, ctx);
    },
    {
      maxRetries: MAX_RETRIES,
      baseDelayMs: RETRY_DELAY_MS,
      maxDelayMs: RETRY_DELAY_MS * Math.max(MAX_RETRIES, 1),
      jitter: 0,
      operation,
      signal: ctx.signal,
      isTransient: isRetryable,
    },
  ).catch((err) => {
    if (!isRetryable(err) || ctx.signal.aborted) throw err;
    throw serviceUnavailable(
      `Open-Meteo API unavailable after ${attempts} attempt${attempts === 1 ? '' : 's'}.`,
      { url, retryAttempts: attempts },
      { cause: err },
    );
  });
}

// ---------------------------------------------------------------------------
// Forecast query params
// ---------------------------------------------------------------------------

export interface ForecastParams {
  daily?: string[] | undefined;
  forecast_days?: number | undefined;
  hourly?: string[] | undefined;
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
  daily?: string[] | undefined;
  end_date?: string | undefined;
  forecast_days?: number | undefined;
  hourly?: string[] | undefined;
  past_days?: number | undefined;
  start_date?: string | undefined;
  timezone?: string | undefined;
}

export interface AirQualityParams {
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
    return withOpenMeteoRetry<GeocodingResponse>(url, ctx, 'geocode');
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
    ctx.log.info('Fetching forecast', { lat, lon, forecast_days: params.forecast_days });
    return withOpenMeteoRetry<WeatherEnvelope>(url, ctx, 'forecast');
  }

  /** ERA5 historical archive endpoint — date range required. */
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
    });
    return withOpenMeteoRetry<WeatherEnvelope>(url, ctx, 'historical');
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
    return withOpenMeteoRetry<WeatherEnvelope>(url, ctx, 'marine');
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
    return withOpenMeteoRetry<WeatherEnvelope>(url, ctx, 'air-quality');
  }

  /** Ensemble forecast endpoint — per-member hourly/daily time series up to 16 days. */
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
    return withOpenMeteoRetry<EnsembleEnvelope>(url, ctx, 'ensemble');
  }

  /** GloFAS Flood endpoint — river discharge forecasts and reanalysis history. */
  getFlood(lat: number, lon: number, params: FloodParams, ctx: Context): Promise<FloodEnvelope> {
    const { floodBaseUrl } = getServerConfig();
    const url = openMeteoUrl(`${floodBaseUrl}/v1/flood`, {
      latitude: lat,
      longitude: lon,
      daily: params.daily,
      forecast_days: params.forecast_days,
      start_date: params.start_date,
      end_date: params.end_date,
      timezone: params.timezone ?? 'auto',
    });

    ctx.log.info('Fetching flood forecast', {
      lat,
      lon,
      forecast_days: params.forecast_days,
      start_date: params.start_date,
      end_date: params.end_date,
    });
    return withOpenMeteoRetry<FloodEnvelope>(url, ctx, 'flood');
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
    return withOpenMeteoRetry<WeatherEnvelope>(url, ctx, 'climate');
  }

  /** Elevation endpoint — up to 100 coordinate pairs. */
  getElevation(
    latitudes: number[],
    longitudes: number[],
    ctx: Context,
  ): Promise<ElevationResponse> {
    const { apiBaseUrl } = getServerConfig();
    const url = openMeteoUrl(`${apiBaseUrl}/v1/elevation`, {
      latitude: latitudes.map(String),
      longitude: longitudes.map(String),
    });
    ctx.log.info('Fetching elevation', { count: latitudes.length });
    return withOpenMeteoRetry<ElevationResponse>(url, ctx, 'elevation');
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
 * what is an empty field, where omitting `models` selects the default blend. A schema
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
  daily?: string[] | undefined;
  end_date?: string | undefined;
  forecast_days?: number | undefined;
  hourly?: string[] | undefined;
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
    hourly: params.hourly,
    daily: params.daily,
    start_date: params.start_date,
    end_date: params.end_date,
    forecast_days: params.forecast_days,
    past_days: params.past_days,
    temperature_unit: params.temperature_unit,
    wind_speed_unit: params.wind_speed_unit,
    precipitation_unit: params.precipitation_unit,
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
