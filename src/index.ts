#!/usr/bin/env node
/**
 * @fileoverview open-meteo-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import {
  openmeteoDataframeDescribeTool,
  openmeteoDataframeQueryTool,
  openmeteoGetAirQualityTool,
  openmeteoGetClimateTool,
  openmeteoGetElevationTool,
  openmeteoGetEnsembleTool,
  openmeteoGetFloodTool,
  openmeteoGetForecastTool,
  openmeteoGetHistoricalTool,
  openmeteoGetMarineTool,
  openmeteoSearchLocationsTool,
} from './mcp-server/tools/definitions/index.js';
import { setCanvas } from './services/canvas-accessor.js';
import { initOpenMeteoService } from './services/open-meteo/open-meteo-service.js';

await createApp({
  name: 'open-meteo-mcp-server',
  title: 'open-meteo-mcp-server',
  tools: [
    openmeteoSearchLocationsTool,
    openmeteoGetElevationTool,
    openmeteoGetForecastTool,
    openmeteoGetHistoricalTool,
    openmeteoGetMarineTool,
    openmeteoGetAirQualityTool,
    openmeteoGetEnsembleTool,
    openmeteoGetFloodTool,
    openmeteoGetClimateTool,
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
    '1. openmeteo_search_locations — resolve a place name to coordinates (required first step for name-based queries)\n' +
    '2. openmeteo_get_forecast — up to 16 days ahead + 92 days past_days; hourly and/or daily variables. A wide window spills like the historical tool\n' +
    '3. openmeteo_get_historical — ERA5 archive from 1940; use start_date/end_date\n' +
    '4. openmeteo_get_marine — wave/swell for coastal and ocean points; up to 8 forecast days, past_days, or a start_date+end_date archive range back to at least 2022\n' +
    '5. openmeteo_get_air_quality — CAMS modeled PM2.5, PM10, ozone, AQI; up to 7 forecast days, past_days, or a start_date+end_date archive range back to at least 2022-10-01\n' +
    '6. openmeteo_get_elevation — Copernicus DEM terrain elevation for up to 100 coordinate pairs\n' +
    '7. openmeteo_get_ensemble — probabilistic ensemble forecast (up to 51 members, 16 days); use for exceedance probabilities and uncertainty quantification\n' +
    '8. openmeteo_get_flood — GloFAS river discharge forecast (up to 210 days) OR reanalysis (from 1984, start_date+end_date together); the two modes are mutually exclusive. Coordinate-based, snaps to nearest river\n' +
    '9. openmeteo_get_climate — bias-corrected daily CMIP6 climate projections (1950–2050, up to 7 models); use for multi-decade "what will conditions look like" questions\n\n' +
    'DataCanvas workflow (requires CANVAS_PROVIDER_TYPE=duckdb):\n' +
    '- openmeteo_get_forecast, openmeteo_get_historical, openmeteo_get_marine, openmeteo_get_air_quality, openmeteo_get_ensemble, openmeteo_get_flood, or openmeteo_get_climate with a large query returns canvas_id + truncated: true\n' +
    '- openmeteo_dataframe_describe — list tables and columns on the canvas\n' +
    '- openmeteo_dataframe_query — run SQL SELECT against staged tables\n\n' +
    'Notes:\n' +
    '- All weather tools take latitude/longitude — use openmeteo_search_locations first for place names\n' +
    '- ERA5 has a variable lag (~1–5 days). For recent history, use openmeteo_get_forecast with past_days\n' +
    '- All responses use timezone=auto by default (localizes to the location)\n' +
    '- Variable names are exact API names: temperature_2m, pm2_5, wave_height, river_discharge, etc.\n' +
    '- hourly_variables and daily_variables take separate variable sets — cloud_cover is hourly, temperature_2m_max is daily. A variable passed in the wrong field is rejected before the request, naming the value and the field it belongs in\n' +
    '- Large forecast/historical/marine/air-quality/ensemble/flood/climate queries spill to DataCanvas when CANVAS_PROVIDER_TYPE=duckdb; with it unset they return a bounded preview and truncated: true, so narrow the request or enable canvas to reach the rest',
});
