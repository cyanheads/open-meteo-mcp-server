/**
 * @fileoverview Server-specific environment variable configuration for open-meteo-mcp-server.
 * All fields are optional — the server works zero-config for non-commercial use.
 * OPENMETEO_DATAFRAME_DROP_ENABLED opts in to openmeteo_dataframe_drop; OPENMETEO_CLAMP_LIMITS
 * (on by default) lowers an over-cap count input to its cap instead of rejecting it.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiBaseUrl: z
    .string()
    .default('https://api.open-meteo.com')
    .describe('Base URL for the main Open-Meteo API (forecast + elevation)'),
  archiveBaseUrl: z
    .string()
    .default('https://archive-api.open-meteo.com')
    .describe('Base URL for the Open-Meteo historical archive API'),
  marineBaseUrl: z
    .string()
    .default('https://marine-api.open-meteo.com')
    .describe('Base URL for the Marine forecast API'),
  airQualityBaseUrl: z
    .string()
    .default('https://air-quality-api.open-meteo.com')
    .describe('Base URL for the CAMS Air Quality forecast API'),
  geocodingBaseUrl: z
    .string()
    .default('https://geocoding-api.open-meteo.com')
    .describe('Base URL for the Open-Meteo Geocoding API'),
  ensembleBaseUrl: z
    .string()
    .default('https://ensemble-api.open-meteo.com')
    .describe('Base URL for the Open-Meteo Ensemble forecast API'),
  floodBaseUrl: z
    .string()
    .default('https://flood-api.open-meteo.com')
    .describe('Base URL for the Open-Meteo GloFAS Flood API'),
  climateBaseUrl: z
    .string()
    .default('https://climate-api.open-meteo.com')
    .describe('Base URL for the Open-Meteo Climate (CMIP6 projections) API'),
  dataframeDropEnabled: z
    .stringbool()
    .default(false)
    .describe('Register openmeteo_dataframe_drop as callable; off leaves it listed as disabled'),
  clampLimits: z
    .stringbool()
    .default(true)
    .describe(
      'Lower a count input above its cap to the cap, with a notice; off advertises the cap as a maximum and rejects a larger value',
    ),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

/**
 * Loads `./.env` into `process.env`, never overriding a variable already set: the read
 * the framework's own config makes on its first parse. Tool definitions read this config
 * when their modules are imported, which under Node comes before the framework's parse,
 * so a setting kept only in `.env` would otherwise be missed. A missing file is the
 * normal case. An unreadable one is left to the framework's parse at startup: under Bun
 * that parse reads the same file and reports why it failed, while Node's loader reports
 * an unreadable file as missing, so under Node its settings are ignored.
 */
function loadEnvFile(): void {
  try {
    process.loadEnvFile();
  } catch {
    // Left to the framework's config parse at startup; see above.
  }
}

/** Parses the server's env vars once, after loading `./.env`; later calls return the cached parse. */
export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  if (_config) return _config;
  loadEnvFile();
  _config = parseEnvConfig(ServerConfigSchema, {
    apiBaseUrl: 'OPEN_METEO_API_BASE_URL',
    archiveBaseUrl: 'OPEN_METEO_ARCHIVE_BASE_URL',
    marineBaseUrl: 'OPEN_METEO_MARINE_BASE_URL',
    airQualityBaseUrl: 'OPEN_METEO_AIR_QUALITY_BASE_URL',
    geocodingBaseUrl: 'OPEN_METEO_GEOCODING_BASE_URL',
    ensembleBaseUrl: 'OPEN_METEO_ENSEMBLE_BASE_URL',
    floodBaseUrl: 'OPEN_METEO_FLOOD_BASE_URL',
    climateBaseUrl: 'OPEN_METEO_CLIMATE_BASE_URL',
    dataframeDropEnabled: 'OPENMETEO_DATAFRAME_DROP_ENABLED',
    clampLimits: 'OPENMETEO_CLAMP_LIMITS',
  });
  return _config;
}
