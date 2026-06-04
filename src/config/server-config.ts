/**
 * @fileoverview Server-specific environment variable configuration for open-meteo-mcp-server.
 * All fields are optional — the server works zero-config for non-commercial use.
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
    .describe('Base URL for the ERA5 historical archive API'),
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
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiBaseUrl: 'OPEN_METEO_API_BASE_URL',
    archiveBaseUrl: 'OPEN_METEO_ARCHIVE_BASE_URL',
    marineBaseUrl: 'OPEN_METEO_MARINE_BASE_URL',
    airQualityBaseUrl: 'OPEN_METEO_AIR_QUALITY_BASE_URL',
    geocodingBaseUrl: 'OPEN_METEO_GEOCODING_BASE_URL',
    ensembleBaseUrl: 'OPEN_METEO_ENSEMBLE_BASE_URL',
    floodBaseUrl: 'OPEN_METEO_FLOOD_BASE_URL',
  });
  return _config;
}
