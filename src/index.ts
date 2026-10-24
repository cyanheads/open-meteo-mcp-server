#!/usr/bin/env node
/**
 * @fileoverview open-meteo-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { normalizeEnv, parseConfig, resetConfig } from '@cyanheads/mcp-ts-core/config';
import { getServerConfig } from './config/server-config.js';
import {
  openmeteoDataframeDescribeTool,
  openmeteoDataframeDropTool,
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

parseConfig();
/**
 * DataCanvas defaults on; set CANVAS_PROVIDER_TYPE=none to disable it. "Unset" is the
 * framework parser's verdict, read through its own `normalizeEnv`: an empty or
 * whitespace-only value and an unsubstituted `${…}` placeholder all count as unset, so
 * each takes the default here instead of reaching the parser and resolving to none.
 */
const { CANVAS_PROVIDER_TYPE } = normalizeEnv({
  CANVAS_PROVIDER_TYPE: process.env.CANVAS_PROVIDER_TYPE,
});
if (CANVAS_PROVIDER_TYPE === undefined) process.env.CANVAS_PROVIDER_TYPE = 'duckdb';
resetConfig();

await createApp({
  name: 'open-meteo-mcp-server',
  title: 'open-meteo-mcp-server',
  sessionMode: 'stateless',
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
    openmeteoDataframeDropTool,
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
    '2. openmeteo_get_forecast — up to 16 days ahead + 92 days past_days; current_variables for conditions right now, and/or hourly and daily variables. Omitting models reads Open-Meteo best_match; set models to compare deterministic models (2+ suffix every hourly and daily column with the model name; current_variables takes at most one model). A wide window spills like the historical tool\n' +
    '3. openmeteo_get_historical — archive from 1940; use start_date/end_date. Omitting models reads Open-Meteo Best Match (IFS HRES + ERA5 + ERA5-Land); set models to pin one source\n' +
    '4. openmeteo_get_marine — wave/swell for coastal and ocean points; current_variables for conditions right now, up to 8 forecast days, past_days, or a start_date+end_date archive range back to at least 2022; length_unit "imperial" returns heights in ft, and wind_speed_unit / temperature_unit set the ocean current speed and sea-surface temperature units\n' +
    '5. openmeteo_get_air_quality — CAMS modeled PM2.5, PM10, ozone, AQI; current_variables for values right now, up to 7 forecast days, past_days, or a start_date+end_date archive range; the CAMS global archive begins in August 2022\n' +
    '6. openmeteo_get_elevation — Copernicus DEM terrain elevation; accepts up to 1,000 coordinate pairs and samples the first 100 per call — resubmit latitudes.slice(next_offset) and longitudes.slice(next_offset) until next_offset is null; each sampled pair counts as one call against the per-IP limits below\n' +
    '7. openmeteo_get_ensemble — probabilistic ensemble forecast (up to 64 members, up to 35 days; most models end within 16, and the response notice names where the data ends); use for exceedance probabilities and uncertainty quantification. Omitting models selects ecmwf_ifs025_ensemble. A regional model queried outside its coverage area fails as a coverage_gap input error naming the gap — switch to a global model, do not retry\n' +
    '8. openmeteo_get_flood — GloFAS river discharge: forecast_days (the current run reaches about six months; later days are null) OR a date range from 1984 (start_date+end_date together); the two modes are mutually exclusive. Omitting models reads seamless_v4 — consolidated_v4 reanalysis before 2023-08-05, forecast-run data from then on — so set models: ["consolidated_v4"] for reanalysis through 2025-05-31. Coordinate-based — discharge comes from the largest modeled river within 5 km of the point, not necessarily the closest; vary the coordinate by ~0.1° and compare when a result looks unrepresentative\n' +
    '9. openmeteo_get_climate — bias-corrected daily CMIP6 climate projections (1950–2050, up to 7 models); use for multi-decade "what will conditions look like" questions\n\n' +
    'DataCanvas workflow (on by default; CANVAS_PROVIDER_TYPE=none disables it):\n' +
    '- openmeteo_get_forecast, openmeteo_get_historical, openmeteo_get_marine, openmeteo_get_air_quality, openmeteo_get_ensemble, openmeteo_get_flood, or openmeteo_get_climate with a large query returns canvas_id + truncated: true\n' +
    '- openmeteo_dataframe_describe — list tables and columns on the canvas. Call it first: the staged table name is generated and its columns vary per request (per-member and per-model suffixes), so there is no valid SQL to write until the schema is read\n' +
    '- openmeteo_dataframe_query — run SQL SELECT against staged tables\n' +
    (getServerConfig().dataframeDropEnabled
      ? '- openmeteo_dataframe_drop — remove one staged table or view once you are done with it; the canvas and its other tables stay\n'
      : '') +
    '\n' +
    'Notes:\n' +
    '- All weather tools take latitude/longitude — use openmeteo_search_locations first for place names\n' +
    '- The archive default is the Best Match blend, so its provenance varies by date; its ERA5 components lag ~1–5 days while IFS HRES does not. For recent history, use openmeteo_get_forecast with past_days, or request models: ["ecmwf_ifs"] on openmeteo_get_historical\n' +
    '- current_variables on openmeteo_get_forecast, openmeteo_get_marine, and openmeteo_get_air_quality answers "right now" — a current object plus current_units, and no hourly series needed. The block\'s interval field is its aggregation interval in seconds (900 on the forecast and marine endpoints, 3600 on air quality): summed or averaged values cover the interval ending at current.time, instantaneous values are valid at current.time\n' +
    '- All responses use timezone=auto by default (localizes to the location)\n' +
    '- Variable names are exact API names: temperature_2m, pm2_5, wave_height, river_discharge, etc.\n' +
    '- hourly_variables and daily_variables take separate variable sets — cloud_cover is hourly, temperature_2m_max is daily. A variable passed in the wrong field is rejected before the request, naming the value and the field it belongs in\n' +
    '- Large forecast/historical/marine/air-quality/ensemble/flood/climate queries spill to DataCanvas when CANVAS_PROVIDER_TYPE=duckdb (the default); with none they return a bounded preview and truncated: true, so narrow the request or enable canvas to reach the rest. A two-cadence preview carries both hourly and daily rows in either configuration — neither is dropped for the other, and the two share one inline budget\n' +
    '- The models value on openmeteo_get_forecast, openmeteo_get_ensemble, openmeteo_get_climate, openmeteo_get_historical, and openmeteo_get_flood is not validated locally: a name the tool does not advertise still goes upstream, so a model Open-Meteo adds later works without a server update. When upstream rejects a multi-model request it names only the offending model — correct that one and leave the rest\n' +
    '- A multi-model forecast or historical request in which some models have no data at the coordinate (a regional model outside its domain) still succeeds: Open-Meteo drops those models, and the notice names them — or, when only one model is left and its columns come back unsuffixed, says the values cannot be attributed to a model. When every requested model misses, the call fails as coverage_gap\n' +
    '- The free Open-Meteo API (non-commercial use) allows fewer than 600 calls a minute, 5,000 an hour, and 10,000 a day per IP address, so every session this server serves draws on one shared budget. A request for more than 10 variables, or more than 2 weeks for one location, counts as more than one call, fractionally (2 weeks × 15 variables = 1.5 calls), and each coordinate pair an openmeteo_get_elevation call samples counts as one call — request only the variables and date range the question needs, and on a rate_limited error wait as the message directs before calling again',
});
