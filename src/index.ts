#!/usr/bin/env node
/**
 * @fileoverview open-meteo-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import {
  openmeteoDataframeDescribeTool,
  openmeteoDataframeQueryTool,
  openmeteoGeocodeTool,
  openmeteoGetAirQualityTool,
  openmeteoGetElevationTool,
  openmeteoGetEnsembleTool,
  openmeteoGetFloodTool,
  openmeteoGetForecastTool,
  openmeteoGetHistoricalTool,
  openmeteoGetMarineTool,
} from './mcp-server/tools/definitions/index.js';
import { setCanvas } from './services/canvas-accessor.js';
import { initOpenMeteoService } from './services/open-meteo/open-meteo-service.js';

await createApp({
  tools: [
    openmeteoGeocodeTool,
    openmeteoGetElevationTool,
    openmeteoGetForecastTool,
    openmeteoGetHistoricalTool,
    openmeteoGetMarineTool,
    openmeteoGetAirQualityTool,
    openmeteoGetEnsembleTool,
    openmeteoGetFloodTool,
    openmeteoDataframeQueryTool,
    openmeteoDataframeDescribeTool,
  ],
  resources: [],
  prompts: [],
  setup(core) {
    initOpenMeteoService();
    setCanvas(core.canvas);
  },
  instructions:
    'Open-Meteo global weather server — keyless, no API key required for non-commercial use.\n' +
    'Weather data by Open-Meteo.com (CC BY 4.0).\n\n' +
    'Workflow:\n' +
    '1. openmeteo_geocode — resolve a place name to coordinates (required first step for name-based queries)\n' +
    '2. openmeteo_get_forecast — up to 16 days ahead + 92 days past_days; hourly and/or daily variables\n' +
    '3. openmeteo_get_historical — ERA5 archive from 1940; use start_date/end_date\n' +
    '4. openmeteo_get_marine — wave/swell forecast for coastal and ocean points\n' +
    '5. openmeteo_get_air_quality — CAMS modeled PM2.5, PM10, ozone, AQI (forecast only)\n' +
    '6. openmeteo_get_elevation — Copernicus DEM terrain elevation for up to 100 coordinate pairs\n' +
    '7. openmeteo_get_ensemble — probabilistic ensemble forecast (up to 51 members, 16 days); use for exceedance probabilities and uncertainty quantification\n' +
    '8. openmeteo_get_flood — GloFAS river discharge forecast (up to 210 days) and reanalysis (from 1984); coordinate-based, snaps to nearest river\n\n' +
    'DataCanvas workflow (requires CANVAS_PROVIDER_TYPE=duckdb):\n' +
    '- openmeteo_get_historical or openmeteo_get_ensemble with a large query returns canvas_id + truncated: true\n' +
    '- openmeteo_dataframe_describe — list tables and columns on the canvas\n' +
    '- openmeteo_dataframe_query — run SQL SELECT against staged tables\n\n' +
    'Notes:\n' +
    '- All weather tools take latitude/longitude — use openmeteo_geocode first for place names\n' +
    '- ERA5 has a variable lag (~1–5 days). For recent history, use openmeteo_get_forecast with past_days\n' +
    '- All responses use timezone=auto by default (localizes to the location)\n' +
    '- Variable names are exact API names: temperature_2m, pm2_5, wave_height, river_discharge, etc.\n' +
    '- Large historical/ensemble queries spill to DataCanvas when CANVAS_PROVIDER_TYPE=duckdb',
});
