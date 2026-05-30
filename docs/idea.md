# open-meteo-mcp-server — Idea & Requirements

Global weather, climate history, and marine conditions for any coordinates via Open-Meteo — forecast (≤16 days), ERA5 reanalysis back to 1940, marine, air quality, geocoding, and elevation. No API key for non-commercial use.

| | |
|---|---|
| **Status** | Pre-build design · scaffolded on `@cyanheads/mcp-ts-core@0.9.16` |
| **Category** | external-data |
| **Auth** | none |
| **API cost** | free for non-commercial — no key; fair-use ~10,000/day, 5,000/hour, 600/min; paid commercial tier |
| **Pattern** | multi-endpoint single-source |
| **Complexity** | low–medium |
| **Composes with** | `openstreetmap-mcp-server`, `nws-weather-mcp-server`, `noaa-cdo-mcp-server`, `openaq-mcp-server`, `gbif-biodiversity-mcp-server` |

## Overview

Global weather via Open-Meteo's open API — forecast up to 16 days, historical reanalysis back to 1940 (ERA5), marine/wave conditions, and elevation for any coordinates on Earth. No API key for non-commercial use, no rate-limit auth, a generous fair-use ceiling.

It fills the **global** gap in keyless weather coverage: a single source for forecast and 80+ years of historical weather anywhere, with consistent variable names across both. It doesn't geocode free-text place names in the weather call itself, but ships a companion geocoding endpoint so the server is self-contained — no external geocoder dependency.

## Audience

Travel/logistics planning, agriculture, climate and trend analysis, outdoor-activity tooling — any agent workflow needing weather context for a location it knows only by name or coordinates.

## User Goals

- Get current conditions and a multi-day forecast for a place (by name or coordinates)
- Pull historical weather for a date range ("was last July unusually hot in Seville?")
- Resolve a place name to coordinates, elevation, and timezone
- Get marine/wave conditions for a coastal or ocean point
- Compare weather variables across locations or time windows
- Look up terrain elevation for a coordinate

## API Surface

Multiple Open-Meteo endpoints under one provider, no key. Each weather call takes `latitude`/`longitude` plus an explicit variable list; `timezone=auto` localizes timestamps.

| Endpoint | Host | Purpose |
|:---|:---|:---|
| Forecast | `api.open-meteo.com/v1/forecast` | Hourly + daily forecast (≤16 days), optional past days, 50+ variables |
| Historical (archive) | `archive-api.open-meteo.com/v1/archive` | ERA5 reanalysis 1940→present (~5-day lag), hourly/daily |
| Marine | `marine-api.open-meteo.com/v1/marine` | Wave height/period/direction, swell, sea-surface temp |
| Air Quality | `air-quality-api.open-meteo.com/v1/air-quality` | Modeled PM2.5/PM10/O3/NO2/SO2/CO, dust, pollen, AQI (CAMS) |
| Geocoding | `geocoding-api.open-meteo.com/v1/search` | Place name → coordinates, country, admin, elevation, timezone, population |
| Elevation | `api.open-meteo.com/v1/elevation` | Terrain elevation (Copernicus DEM) for coordinates |

Variables are selected explicitly (`temperature_2m`, `precipitation`, `wind_speed_10m`, `relative_humidity_2m`, `cloud_cover`, `uv_index`, …). Units configurable (metric/imperial). Responses are **columnar** (parallel `time[]` + `value[]` arrays) and must be reshaped into per-timestamp records for the LLM.

## Tool Surface (planned)

| Tool | Behavior |
|:---|:---|
| `openmeteo_geocode` | Resolve a place name to ranked coordinate matches: name, country, admin1/2, lat, lon, elevation, timezone, population, feature code. Required first step for name-based queries — weather tools take coordinates. Disambiguates duplicate names by country/population. |
| `openmeteo_forecast` | Forecast for coordinates. Hourly and/or daily variables; horizon ≤16 days; optional `past_days`. `timezone=auto` default. Returns reshaped per-timestamp records + units. Temp, precip, wind, humidity, cloud, UV, pressure, more. |
| `openmeteo_historical` | Historical weather from the ERA5 archive (1940→present, ~5-day lag). Coordinates, date range, hourly/daily variables — same vocabulary as forecast, so past vs. forecast compare on one schema. Large ranges spill to DataCanvas. |
| `openmeteo_marine` | Marine forecast for a coastal/ocean coordinate: wave height/period/direction, wind-wave and swell components, sea-surface temp. Same reshaped time-series shape. |
| `openmeteo_air_quality` | Modeled CAMS air quality: PM2.5, PM10, O3, NO2, SO2, CO, dust, pollen, European + US AQI. **Modeled** grid data, not a measurement — cross-reference `openaq-mcp-server` for measured station data. |
| `openmeteo_elevation` | Terrain elevation for one or more coordinates (Copernicus DEM, ~90m). Cheap geo utility. |

## Design Notes & Requirements

- **Two recurring patterns to surface in tool descriptions:** (1) geocode-before-forecast (weather tools need coordinates), and (2) explicit variable selection (no default variable set — bake common variable groups into descriptions so agents don't have to know the catalog).
- **Reshape columnar responses** (`time: [...]`, `temperature_2m: [...]`) into per-timestamp objects in the handler — raw parallel arrays are error-prone for an LLM to index.
- **Air quality overlaps `openaq` deliberately** — scope this server weather-first; keep `openmeteo_air_quality` as modeled-forecast and defer measured data to OpenAQ.
- **`timezone=auto` default** so daily aggregates align to local midnight; expose an override.
- **Document the ERA5 ~5-day lag** so agents don't query "yesterday" against the archive and get empty — recent past is covered by `forecast` with `past_days`.
- DataCanvas fits `openmeteo_historical` (multi-year hourly series) and multi-location comparisons.
- (Moonshot) climate-projection over the CMIP6 endpoint (downscaled scenarios to 2100) and the flood/river-discharge API — turns a weather server into a climate-analysis server.

## Build Constraints

- Framework: `@cyanheads/mcp-ts-core@0.9.16`
- No key → hostable; fair-use ~10k/day (non-commercial). Commercial use requires the paid tier — note in README
- Attribution: "Weather data by Open-Meteo.com" (CC BY 4.0)
- Handler-side reshaping of columnar arrays is a hard requirement
