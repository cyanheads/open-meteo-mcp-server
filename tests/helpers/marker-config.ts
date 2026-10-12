/**
 * @fileoverview Stand-in for the server-config module with every Open-Meteo base URL set
 * to a marker URL, so a request URL leaking into an error, a log record, or a tool
 * response shows up as a marker substring. Install it with
 * `vi.mock('@/config/server-config.js', () => import('../helpers/marker-config.js'))`.
 * @module tests/helpers/marker-config
 */

/** A base URL carrying embedded credentials and a path token. */
export const MARKER_BASE = 'http://opuser:oppass@127.0.0.1:9/tok-MARKER';

/** Substrings only a leaked {@link MARKER_BASE} would carry. */
export const URL_MARKERS = ['oppass', 'tok-MARKER', '127.0.0.1'] as const;

export const getServerConfig = () => ({
  apiBaseUrl: MARKER_BASE,
  archiveBaseUrl: MARKER_BASE,
  marineBaseUrl: MARKER_BASE,
  airQualityBaseUrl: MARKER_BASE,
  geocodingBaseUrl: MARKER_BASE,
  ensembleBaseUrl: MARKER_BASE,
  floodBaseUrl: MARKER_BASE,
  climateBaseUrl: MARKER_BASE,
  dataframeDropEnabled: false,
});
