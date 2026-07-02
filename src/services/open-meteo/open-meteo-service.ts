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

export interface MarineParams {
  daily?: string[] | undefined;
  forecast_days?: number | undefined;
  hourly?: string[] | undefined;
  timezone?: string | undefined;
}

export interface AirQualityParams {
  forecast_days?: number | undefined;
  hourly?: string[] | undefined;
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
  /** Geocode a place name; returns the raw API response (results key absent on no-match). */
  getGeocode(
    name: string,
    count: number,
    language: string,
    ctx: Context,
  ): Promise<GeocodingResponse> {
    const { geocodingBaseUrl } = getServerConfig();
    const url = new URL(`${geocodingBaseUrl}/v1/search`);
    url.searchParams.set('name', name);
    url.searchParams.set('count', String(count));
    url.searchParams.set('language', language);
    url.searchParams.set('format', 'json');
    ctx.log.info('Geocoding place', { name, count, language });
    return withOpenMeteoRetry<GeocodingResponse>(url.toString(), ctx, 'geocode');
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

  /** Marine forecast endpoint — wave, swell, ocean variables. */
  getMarine(
    lat: number,
    lon: number,
    params: MarineParams,
    ctx: Context,
  ): Promise<WeatherEnvelope> {
    const { marineBaseUrl } = getServerConfig();
    const url = buildWeatherUrl(`${marineBaseUrl}/v1/marine`, lat, lon, params);
    ctx.log.info('Fetching marine forecast', { lat, lon, forecast_days: params.forecast_days });
    return withOpenMeteoRetry<WeatherEnvelope>(url, ctx, 'marine');
  }

  /** CAMS Air Quality forecast endpoint. */
  getAirQuality(
    lat: number,
    lon: number,
    params: AirQualityParams,
    ctx: Context,
  ): Promise<WeatherEnvelope> {
    const { airQualityBaseUrl } = getServerConfig();
    const url = buildWeatherUrl(`${airQualityBaseUrl}/v1/air-quality`, lat, lon, params);
    ctx.log.info('Fetching air quality', { lat, lon, forecast_days: params.forecast_days });
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
    const url = new URL(`${ensembleBaseUrl}/v1/ensemble`);
    url.searchParams.set('latitude', String(lat));
    url.searchParams.set('longitude', String(lon));

    if (params.hourly && params.hourly.length > 0) {
      url.searchParams.set('hourly', params.hourly.join(','));
    }
    if (params.daily && params.daily.length > 0) {
      url.searchParams.set('daily', params.daily.join(','));
    }
    if (params.models) url.searchParams.set('models', params.models);
    if (params.forecast_days != null)
      url.searchParams.set('forecast_days', String(params.forecast_days));
    if (params.past_days != null) url.searchParams.set('past_days', String(params.past_days));
    if (params.temperature_unit) url.searchParams.set('temperature_unit', params.temperature_unit);
    if (params.wind_speed_unit) url.searchParams.set('wind_speed_unit', params.wind_speed_unit);
    if (params.precipitation_unit)
      url.searchParams.set('precipitation_unit', params.precipitation_unit);
    url.searchParams.set('timezone', params.timezone ?? 'auto');

    ctx.log.info('Fetching ensemble forecast', {
      lat,
      lon,
      models: params.models,
      forecast_days: params.forecast_days,
    });
    return withOpenMeteoRetry<EnsembleEnvelope>(url.toString(), ctx, 'ensemble');
  }

  /** GloFAS Flood endpoint — river discharge forecasts and reanalysis history. */
  getFlood(lat: number, lon: number, params: FloodParams, ctx: Context): Promise<FloodEnvelope> {
    const { floodBaseUrl } = getServerConfig();
    const url = new URL(`${floodBaseUrl}/v1/flood`);
    url.searchParams.set('latitude', String(lat));
    url.searchParams.set('longitude', String(lon));
    url.searchParams.set('daily', params.daily.join(','));
    if (params.forecast_days != null)
      url.searchParams.set('forecast_days', String(params.forecast_days));
    if (params.start_date) url.searchParams.set('start_date', params.start_date);
    if (params.end_date) url.searchParams.set('end_date', params.end_date);
    url.searchParams.set('timezone', params.timezone ?? 'auto');

    ctx.log.info('Fetching flood forecast', {
      lat,
      lon,
      forecast_days: params.forecast_days,
      start_date: params.start_date,
      end_date: params.end_date,
    });
    return withOpenMeteoRetry<FloodEnvelope>(url.toString(), ctx, 'flood');
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
    const url = new URL(`${climateBaseUrl}/v1/climate`);
    url.searchParams.set('latitude', String(lat));
    url.searchParams.set('longitude', String(lon));
    url.searchParams.set('start_date', params.start_date);
    url.searchParams.set('end_date', params.end_date);
    url.searchParams.set('daily', params.daily.join(','));
    if (params.models && params.models.length > 0) {
      url.searchParams.set('models', params.models.join(','));
    }
    if (params.temperature_unit) url.searchParams.set('temperature_unit', params.temperature_unit);
    if (params.wind_speed_unit) url.searchParams.set('wind_speed_unit', params.wind_speed_unit);
    if (params.precipitation_unit)
      url.searchParams.set('precipitation_unit', params.precipitation_unit);
    url.searchParams.set('timezone', params.timezone ?? 'auto');

    ctx.log.info('Fetching climate projections', {
      lat,
      lon,
      start: params.start_date,
      end: params.end_date,
      models: params.models,
    });
    return withOpenMeteoRetry<WeatherEnvelope>(url.toString(), ctx, 'climate');
  }

  /** Elevation endpoint — up to 100 coordinate pairs. */
  getElevation(
    latitudes: number[],
    longitudes: number[],
    ctx: Context,
  ): Promise<ElevationResponse> {
    const { apiBaseUrl } = getServerConfig();
    const url = new URL(`${apiBaseUrl}/v1/elevation`);
    url.searchParams.set('latitude', latitudes.join(','));
    url.searchParams.set('longitude', longitudes.join(','));
    ctx.log.info('Fetching elevation', { count: latitudes.length });
    return withOpenMeteoRetry<ElevationResponse>(url.toString(), ctx, 'elevation');
  }
}

// ---------------------------------------------------------------------------
// URL builder helper
// ---------------------------------------------------------------------------

function buildWeatherUrl(
  base: string,
  lat: number,
  lon: number,
  params: ForecastParams | HistoricalParams | MarineParams | AirQualityParams,
): string {
  const url = new URL(base);
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));

  const p = params as Record<string, unknown>;

  if (Array.isArray(p.hourly) && (p.hourly as string[]).length > 0) {
    url.searchParams.set('hourly', (p.hourly as string[]).join(','));
  }
  if (Array.isArray(p.daily) && (p.daily as string[]).length > 0) {
    url.searchParams.set('daily', (p.daily as string[]).join(','));
  }
  if (p.start_date) url.searchParams.set('start_date', String(p.start_date));
  if (p.end_date) url.searchParams.set('end_date', String(p.end_date));
  if (p.forecast_days != null) url.searchParams.set('forecast_days', String(p.forecast_days));
  if (p.past_days != null) url.searchParams.set('past_days', String(p.past_days));
  if (p.temperature_unit) url.searchParams.set('temperature_unit', String(p.temperature_unit));
  if (p.wind_speed_unit) url.searchParams.set('wind_speed_unit', String(p.wind_speed_unit));
  if (p.precipitation_unit)
    url.searchParams.set('precipitation_unit', String(p.precipitation_unit));

  const tz = (p.timezone as string | undefined) ?? 'auto';
  url.searchParams.set('timezone', tz);

  return url.toString();
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
