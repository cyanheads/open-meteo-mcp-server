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

/** Geocoding result item from Open-Meteo Geocoding API. */
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
  timezone: string;
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
 * Ensemble API response envelope — extends WeatherEnvelope with model metadata.
 * The `models` field names the ensemble system used; `members` is the count of
 * ensemble members, each appearing as separate columns in the hourly/daily blocks
 * (e.g. temperature_2m_member01, temperature_2m_member02, …).
 */
export interface EnsembleEnvelope extends WeatherEnvelope {
  /** Number of ensemble members in the response. */
  members?: number;
  /** Ensemble model identifier (e.g. "ecmwf_ifs025", "gfs025"). */
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
