/**
 * @fileoverview Type definitions for Open-Meteo API responses.
 * @module services/open-meteo/types
 */

/** Columnar weather data block — parallel arrays indexed by position. */
export interface ColumnarBlock {
  time: string[];
  [variable: string]: (number | null | string)[];
}

/** Units map for a columnar block (variable name → unit string). */
export type UnitsMap = Record<string, string>;

/** Cast a potentially unknown-typed record from API response to a UnitsMap. */
export function toUnitsMap(u: Record<string, unknown> | undefined): UnitsMap | undefined {
  if (!u) return;
  // Values from the API are always strings; cast is safe.
  return u as UnitsMap;
}

/** Shared envelope for forecast, historical, marine, and air-quality responses. */
export interface WeatherEnvelope {
  daily?: ColumnarBlock;
  daily_units?: UnitsMap;
  elevation: number;
  /** Present when the API returned an error. */
  error?: boolean;
  generationtime_ms: number;
  hourly?: ColumnarBlock;
  hourly_units?: UnitsMap;
  latitude: number;
  longitude: number;
  reason?: string;
  timezone: string;
  timezone_abbreviation: string;
  utc_offset_seconds: number;
}

/**
 * Geocoding result item from Open-Meteo Geocoding API.
 * The API omits `country`/`country_code` for non-country features (continents,
 * oceans — e.g. feature_code "CONT") and can omit `timezone` on some feature types.
 */
export interface GeocodingResult {
  admin1?: string | null;
  admin2?: string | null;
  country?: string | null;
  country_code?: string | null;
  elevation: number | null;
  feature_code: string;
  id: number;
  latitude: number;
  longitude: number;
  name: string;
  population?: number | null;
  timezone?: string | null;
}

/** Top-level geocoding response — results key is ABSENT on no-match. */
export interface GeocodingResponse {
  error?: boolean;
  generationtime_ms: number;
  reason?: string;
  results?: GeocodingResult[];
}

/** Elevation API response. */
export interface ElevationResponse {
  elevation: number[];
  error?: boolean;
  reason?: string;
}

/** Per-timestamp record — one entry per time step in the reshaped output. */
export type TimeRecord = Record<string, number | string | null>;

/**
 * Ensemble API response envelope — extends WeatherEnvelope. The live API does NOT
 * return top-level `models`/`members` fields; member identity lives only in the
 * per-member column names of the hourly/daily blocks (e.g. temperature_2m_member01,
 * temperature_2m_member02, …). The optional fields below are kept for forward-compat
 * only — handlers must not depend on them being present.
 */
export interface EnsembleEnvelope extends WeatherEnvelope {
  /** Number of ensemble members — not returned by the live API. */
  members?: number;
  /** Ensemble model identifier — not returned by the live API. */
  models?: string;
}

/** GloFAS Flood API response envelope. Daily-only; no elevation field. */
export interface FloodEnvelope {
  daily?: ColumnarBlock;
  daily_units?: UnitsMap;
  /** Present when the API returned an error. */
  error?: boolean;
  generationtime_ms: number;
  latitude: number;
  longitude: number;
  reason?: string;
  timezone: string;
  timezone_abbreviation: string;
  utc_offset_seconds: number;
}
