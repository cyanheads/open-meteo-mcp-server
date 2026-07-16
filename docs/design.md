---
name: open-meteo-mcp-server
status: designed
priority: high
difficulty: low-medium
category: external-data
api_docs: https://open-meteo.com/en/docs
---

# Open-Meteo MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `openmeteo_geocode` | Resolve a place name to ranked coordinate matches. Required first step before any weather tool — weather tools take coordinates, not names. Returns name, country, admin1/2, lat/lon, elevation, timezone, population, and feature type for disambiguation. | `name: string`, `count?: 1–10` | `readOnlyHint: true` |
| `openmeteo_get_forecast` | Weather forecast for coordinates: hourly and/or daily variables for up to 16 days. Optional `past_days` (up to 92) covers recent history when ERA5 has a lag. Reshapes columnar API response into per-timestamp records. `timezone=auto` default localizes to the location. | `latitude`, `longitude`, `hourly_variables?: string[]`, `daily_variables?: string[]`, `forecast_days?: 1–16`, `past_days?: 0–92`, `wind_speed_unit?`, `temperature_unit?` | `readOnlyHint: true` |
| `openmeteo_get_historical` | Historical weather from the ERA5 reanalysis archive (1940–present, ~5-day lag). Date range required; same variable vocabulary as `openmeteo_get_forecast` so past and forecast are directly comparable. Large ranges spill to DataCanvas. | `latitude`, `longitude`, `start_date: ISO date`, `end_date: ISO date`, `hourly_variables?: string[]`, `daily_variables?: string[]`, `timezone?`, `temperature_unit?`, `wind_speed_unit?` | `readOnlyHint: true` |
| `openmeteo_get_marine` | Marine forecast for a coastal or ocean coordinate: wave height/period/direction, wind-wave, swell components. Reshapes columnar response into per-timestamp records. Best for open-ocean and coastal points; inland points return near-zero wave values. | `latitude`, `longitude`, `hourly_variables?: string[]`, `daily_variables?: string[]`, `forecast_days?: 1–7`, `timezone?` | `readOnlyHint: true` |
| `openmeteo_get_air_quality` | Modeled CAMS air quality forecast: PM2.5, PM10, NO2, SO2, O3, CO, dust, pollen, and European/US AQI indices. Modeled grid data — cross-reference `openaq-mcp-server` for measured station readings. | `latitude`, `longitude`, `hourly_variables?: string[]`, `forecast_days?: 1–7`, `timezone?` | `readOnlyHint: true` |
| `openmeteo_get_elevation` | Terrain elevation from Copernicus DEM (~90m resolution) for one or more coordinates. Accepts up to 100 coordinate pairs in one call. | `latitudes: number[]`, `longitudes: number[]` | `readOnlyHint: true`, `idempotentHint: true` |

### Resources

None. All data is ephemeral time-series — no stable URI pattern warrants a resource. Tool-only access is complete for every workflow.

### Prompts

None. The domain is data-lookup, not interactive guidance.

---

## Overview

Global weather and climate data via Open-Meteo's keyless API — forecast up to 16 days, ERA5 historical reanalysis back to 1940, marine/wave conditions, modeled air quality, place-name geocoding, and terrain elevation. No API key for non-commercial use; no auth; a generous fair-use ceiling (~10k requests/day).

Fills the **global** gap in keyless weather coverage that `nws-weather-mcp-server` and `noaa-cdo-mcp-server` leave: NWS is US-only; NOAA CDO has token management friction. Open-Meteo serves any coordinates on Earth with consistent variable names across both forecast and history, making past-vs-forecast comparisons on one schema practical.

The server is self-contained: `openmeteo_geocode` resolves free-text place names to coordinates so agents don't need an external geocoder.

**Attribution:** Weather data by Open-Meteo.com (CC BY 4.0). Non-commercial use is free and keyless; commercial use requires the paid API tier.

---

## Requirements

- Forecast: `api.open-meteo.com/v1/forecast` — hourly and daily variables up to 16 days forward and 92 days back (via `past_days`), explicit variable selection, metric/imperial units, `timezone=auto`
- Historical: `archive-api.open-meteo.com/v1/archive` — ERA5 reanalysis 1940–present, ~5-day lag (variable); `start_date`/`end_date` required
- Marine: `marine-api.open-meteo.com/v1/marine` — wave/swell/ocean variables; daily marine variables supported
- Air quality: `air-quality-api.open-meteo.com/v1/air-quality` — CAMS-modeled; forecast only (not historical archive); `forecast_days` 1–7
- Geocoding: `geocoding-api.open-meteo.com/v1/search` — returns `results[]` array (absent/empty on no match); each result includes `id`, `name`, `latitude`, `longitude`, `elevation`, `timezone`, `country`, `country_code`, `admin1`, `admin2`, `population`, `feature_code`
- Elevation: `api.open-meteo.com/v1/elevation` — batch coordinate input (`latitudes[]`, `longitudes[]`), returns `elevation[]`
- **All API responses are columnar** — `hourly.time: [...]`, `hourly.<variable>: [...]` parallel arrays. Handler-side reshaping into per-timestamp objects is a hard requirement.
- `timezone=auto` default on all weather tools; expose override
- Responses include `<domain>_units` object (e.g., `hourly_units`, `daily_units`) with per-variable unit strings — include units in reshaped records
- Error shape: `{ "error": true, "reason": "..." }` — map to `ValidationError` or `ServiceUnavailable` by context
- No API key for non-commercial use; no auth headers required. All endpoints accept plain HTTPS GET with query params.
- Fair use: ~10,000 req/day, 5,000/hour, 600/min per IP. No programmatic rate-limit signal — rely on 429 status.

---

## Confirmed API Shapes (live-probed 2026-05-30)

### Forecast / Historical / Marine / Air Quality response envelope

```json
{
  "latitude": 47.595562,
  "longitude": -122.32443,
  "generationtime_ms": 0.198,
  "utc_offset_seconds": -25200,
  "timezone": "America/Los_Angeles",
  "timezone_abbreviation": "GMT-7",
  "elevation": 59.0,
  "hourly_units": { "time": "iso8601", "temperature_2m": "°C", "precipitation": "mm" },
  "hourly": {
    "time": ["2026-05-30T00:00", "2026-05-30T01:00", ...],
    "temperature_2m": [10.1, 9.4, ...],
    "precipitation": [0.0, 0.0, ...]
  },
  "daily_units": { "time": "iso8601", "temperature_2m_max": "°C" },
  "daily": {
    "time": ["2026-05-30", ...],
    "temperature_2m_max": [15.9, ...]
  }
}
```

Columnar shape confirmed — parallel `time[]` and `<variable>[]` arrays in both `hourly` and `daily`. Variable keys are exact API parameter names (e.g., `temperature_2m`, not `temperature`).

**Reshape target** (per-timestamp record) — raw variable values only, no inline `unit` field; units live in the separate `hourly_units`/`daily_units` map:
```ts
{ time: "2026-05-30T10:00", temperature_2m: 12.0, precipitation: 0.0, ... }
// hourly_units: { temperature_2m: "°C", precipitation: "mm" }
```

### Geocoding response

```json
{
  "results": [
    {
      "id": 5809844,
      "name": "Seattle",
      "latitude": 47.60621,
      "longitude": -122.33207,
      "elevation": 56.0,
      "feature_code": "PPLA2",
      "country_code": "US",
      "country": "United States",
      "admin1": "Washington",
      "admin2": "King",
      "admin3": "City of Seattle",
      "admin1_id": 5815135,
      "admin2_id": 5799783,
      "admin3_id": 7174408,
      "timezone": "America/Los_Angeles",
      "population": 780995,
      "postcodes": ["98101", ...]
    }
  ],
  "generationtime_ms": 0.559
}
```

No-match response: `{"generationtime_ms": 0.085}` — `results` key absent. Handler must guard `results ?? []`.

### Elevation response

```json
{ "elevation": [59.0] }
```

Parallel array matching input order. Batch-capable (up to 100 coordinates).

### Error response

```json
{ "error": true, "reason": "Latitude must be in range of -90 to 90°. Given: 999.0." }
```

Validated error format — thrown for out-of-range inputs, unknown variables, bad date ranges.

### Noted: marine ocean_current_velocity

`ocean_current_velocity` returns all `null` for inland/sheltered coordinates (confirmed: Puget Sound). Do not advertise this variable as reliable for non-open-ocean points.

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `OpenMeteoService` | All Open-Meteo endpoints (forecast, archive, marine, air quality, geocoding, elevation) | All tools |

Single service — all endpoints share the same base domain group, same auth model (none), same retry strategy, same error envelope. Split into sub-services only if handler composition demands it.

**Service structure:**
- `getGeocode(name, count)` → geocoding results
- `getForecast(lat, lon, params)` → columnar response (reshape in tool handler)
- `getHistorical(lat, lon, params)` → columnar response (reshape in tool handler)
- `getMarine(lat, lon, params)` → columnar response (reshape in tool handler)
- `getAirQuality(lat, lon, params)` → columnar response (reshape in tool handler)
- `getElevation(latitudes, longitudes)` → elevation array

**Resilience:**
- Retry boundary: service method wraps full pipeline (fetch + parse)
- Max retries: 2, base delay: 500ms (ephemeral failures — rate-limits and transients)
- HTTP status check: non-OK + `{"error": true}` body → classify as `ValidationError` (4xx input) or `ServiceUnavailable` (5xx transient)
- Parse failure: HTML body (CDN error page) → throw transient, not `SerializationError`
- Timeout: 15s (historical queries over large date ranges can be slow)

---

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `OPEN_METEO_API_BASE_URL` | No | `https://api.open-meteo.com` | Override for testing or self-hosted |
| `OPEN_METEO_ARCHIVE_BASE_URL` | No | `https://archive-api.open-meteo.com` | Archive endpoint override |
| `OPEN_METEO_MARINE_BASE_URL` | No | `https://marine-api.open-meteo.com` | Marine endpoint override |
| `OPEN_METEO_AIR_QUALITY_BASE_URL` | No | `https://air-quality-api.open-meteo.com` | Air quality endpoint override |
| `OPEN_METEO_GEOCODING_BASE_URL` | No | `https://geocoding-api.open-meteo.com` | Geocoding endpoint override |

No API key required. Config is optional-only — the server works zero-config for non-commercial use.

---

## Tool Detail

### `openmeteo_geocode`

**Description:** Resolve a place name to ranked coordinate matches with country, region, elevation, timezone, and population. Required prerequisite for name-based queries — all weather tools take latitude/longitude, not place names. Returns up to 10 matches ranked by population/relevance; use country or admin1 to disambiguate when multiple cities share a name.

**Input schema:**
```ts
{
  name: z.string().min(1).max(100)
    .describe('Place name to search. Can be a city, region, or landmark (e.g., "Seattle", "Mount Rainier"). Weather tools require coordinates — use the lat/lon from this result.'),
  count: z.number().int().min(1).max(10).default(5)
    .describe('Max results to return (1–10). Default 5. Return more when disambiguating common names like "Springfield" or "Portland".'),
  language: z.string().default('en')
    .describe('Response language for place names (ISO 639-1, e.g., "en", "de", "fr"). Default "en".'),
}
```

**Output schema:**
```ts
{
  results: z.array(z.object({
    id: z.number().describe('Open-Meteo place ID — stable reference for this location'),
    name: z.string().describe('Place name'),
    latitude: z.number().describe('Latitude in decimal degrees'),
    longitude: z.number().describe('Longitude in decimal degrees'),
    elevation: z.number().nullable().describe('Elevation in meters above sea level'),
    timezone: z.string().describe('IANA timezone (e.g., "America/Los_Angeles") — pass to weather tools as the timezone parameter'),
    country: z.string().describe('Country name'),
    country_code: z.string().describe('ISO 3166-1 alpha-2 country code'),
    admin1: z.string().nullable().describe('State, province, or region'),
    admin2: z.string().nullable().describe('County or district'),
    population: z.number().nullable().describe('Population (when available) — useful for disambiguating same-named cities'),
    feature_code: z.string().describe('GeoNames feature code describing the place type (e.g., "PPLA2" = state capital city, "PPL" = populated place)'),
  })).describe('Ranked matches (most relevant first). Empty when no results match.'),
  count: z.number().describe('Number of results returned'),
}
```

**Errors:**
```ts
errors: [
  {
    reason: 'no_results',
    code: JsonRpcErrorCode.NotFound,
    when: 'The search returned no matching places',
    recovery: 'Check the spelling, try a broader term (e.g., region instead of street), or search in English.',
    retryable: false,
  },
]
```

---

### `openmeteo_get_forecast`

**Description:** Weather forecast for coordinates: hourly and/or daily variables for up to 16 days ahead, with optional `past_days` (up to 92) for recent history. Use `past_days` instead of `openmeteo_get_historical` for dates within the last 1–5 days, since the ERA5 archive has a variable lag. Reshapes the columnar API response into per-timestamp records. Common hourly variables: `temperature_2m`, `precipitation`, `wind_speed_10m`, `relative_humidity_2m`, `cloud_cover`, `uv_index`, `apparent_temperature`, `precipitation_probability`, `weather_code`, `surface_pressure`, `visibility`, `wind_direction_10m`, `wind_gusts_10m`, `dew_point_2m`. Common daily variables: `temperature_2m_max`, `temperature_2m_min`, `precipitation_sum`, `wind_speed_10m_max`, `sunrise`, `sunset`, `uv_index_max`, `precipitation_hours`, `weather_code`. At least one of `hourly_variables` or `daily_variables` is required.

**Input schema:**
```ts
{
  latitude: z.number().min(-90).max(90)
    .describe('Latitude in decimal degrees (e.g., 47.6062 for Seattle). Use openmeteo_geocode to resolve a place name to coordinates.'),
  longitude: z.number().min(-180).max(180)
    .describe('Longitude in decimal degrees (e.g., -122.3321 for Seattle).'),
  hourly_variables: z.array(z.string()).optional()
    .describe('Hourly variables to fetch (e.g., ["temperature_2m", "precipitation", "wind_speed_10m", "relative_humidity_2m", "cloud_cover", "uv_index", "apparent_temperature"]). At least one of hourly_variables or daily_variables is required.'),
  daily_variables: z.array(z.string()).optional()
    .describe('Daily summary variables (e.g., ["temperature_2m_max", "temperature_2m_min", "precipitation_sum", "wind_speed_10m_max", "sunrise", "sunset", "uv_index_max"]). At least one of hourly_variables or daily_variables is required.'),
  forecast_days: z.number().int().min(1).max(16).default(7)
    .describe('Number of forecast days (1–16). Default 7.'),
  past_days: z.number().int().min(0).max(92).default(0)
    .describe('Include this many days of past data before today (0–92). Use for recent history — ERA5 archive has a variable ~5-day lag. Default 0.'),
  temperature_unit: z.enum(['celsius', 'fahrenheit']).default('celsius')
    .describe('Temperature unit. Default "celsius".'),
  wind_speed_unit: z.enum(['kmh', 'mph', 'ms', 'kn']).default('kmh')
    .describe('Wind speed unit: "kmh" (km/h), "mph", "ms" (m/s), or "kn" (knots). Default "kmh".'),
  precipitation_unit: z.enum(['mm', 'inch']).default('mm')
    .describe('Precipitation unit: "mm" or "inch". Default "mm".'),
  timezone: z.string().default('auto')
    .describe('IANA timezone (e.g., "America/Los_Angeles") or "auto" to use the location\'s local timezone. Default "auto". The timezone from openmeteo_geocode is ideal to pass here.'),
}
```

**Output schema:**
```ts
{
  latitude: z.number().describe('Snapped latitude (Open-Meteo snaps to nearest grid point)'),
  longitude: z.number().describe('Snapped longitude'),
  elevation: z.number().describe('Terrain elevation at grid point (meters)'),
  timezone: z.string().describe('Resolved IANA timezone'),
  utc_offset_seconds: z.number().describe('UTC offset in seconds for this timezone at query time'),
  hourly: z.array(z.record(z.unknown())).optional()
    .describe('Per-hour records. Each object has a "time" field (ISO 8601) plus one key per requested variable with its value. Units are in the hourly_units map.'),
  daily: z.array(z.record(z.unknown())).optional()
    .describe('Per-day records. Each object has a "time" field (YYYY-MM-DD) plus one key per requested variable with its value. Units are in the daily_units map.'),
  hourly_units: z.record(z.string()).optional()
    .describe('Map of variable name → unit string for hourly data (e.g., {"temperature_2m": "°C", "precipitation": "mm"}).'),
  daily_units: z.record(z.string()).optional()
    .describe('Map of variable name → unit string for daily data.'),
}
```

**Errors:**
```ts
errors: [
  {
    reason: 'invalid_variable',
    code: JsonRpcErrorCode.ValidationError,
    when: 'An unknown variable name was requested',
    recovery: 'Check the variable name against the Open-Meteo docs. Common hourly: temperature_2m, precipitation, wind_speed_10m, relative_humidity_2m, cloud_cover, uv_index. Common daily: temperature_2m_max, temperature_2m_min, precipitation_sum.',
    retryable: false,
  },
  {
    reason: 'no_variables_requested',
    code: JsonRpcErrorCode.ValidationError,
    when: 'Neither hourly_variables nor daily_variables was provided',
    recovery: 'Provide at least one of hourly_variables or daily_variables.',
    retryable: false,
  },
]
```

---

### `openmeteo_get_historical`

**Description:** Historical weather from the ERA5 reanalysis archive (1940–present). Requires `start_date` and `end_date` (ISO 8601 date, e.g., "2024-07-01"). ERA5 has a variable lag of up to ~5 days — for dates within the last week, use `openmeteo_get_forecast` with `past_days` instead. Uses the same variable names as the forecast API for direct comparison. Large date ranges (multi-year hourly) produce thousands of records — these spill to DataCanvas for SQL querying. At least one of `hourly_variables` or `daily_variables` is required.

**Input schema:**
```ts
{
  latitude: z.number().min(-90).max(90)
    .describe('Latitude in decimal degrees. Use openmeteo_geocode to resolve a place name to coordinates.'),
  longitude: z.number().min(-180).max(180)
    .describe('Longitude in decimal degrees.'),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('Start date (YYYY-MM-DD, e.g., "2024-07-01"). ERA5 covers from 1940-01-01 to approximately 5 days ago.'),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('End date (YYYY-MM-DD, inclusive). Must be on or after start_date. For dates within the last ~5 days, use openmeteo_get_forecast with past_days instead.'),
  hourly_variables: z.array(z.string()).optional()
    .describe('Hourly ERA5 variables (e.g., ["temperature_2m", "precipitation", "wind_speed_10m", "relative_humidity_2m", "cloud_cover", "soil_moisture_0_to_7cm"]). At least one of hourly_variables or daily_variables required.'),
  daily_variables: z.array(z.string()).optional()
    .describe('Daily summary variables (e.g., ["temperature_2m_max", "temperature_2m_min", "precipitation_sum", "wind_speed_10m_max"]). At least one of hourly_variables or daily_variables required.'),
  temperature_unit: z.enum(['celsius', 'fahrenheit']).default('celsius')
    .describe('Temperature unit. Default "celsius".'),
  wind_speed_unit: z.enum(['kmh', 'mph', 'ms', 'kn']).default('kmh')
    .describe('Wind speed unit. Default "kmh".'),
  precipitation_unit: z.enum(['mm', 'inch']).default('mm')
    .describe('Precipitation unit. Default "mm".'),
  timezone: z.string().default('auto')
    .describe('IANA timezone or "auto". Default "auto".'),
  canvas_id: z.string().optional()
    .describe('DataCanvas token for multi-year or multi-variable queries. When a result is too large to return inline — driven by total payload size, so a wide multi-variable pull can spill at any row count — it spills to this canvas for SQL querying. Omit to create a fresh canvas.'),
}
```

**Output schema:**
```ts
{
  latitude: z.number().describe('Snapped latitude'),
  longitude: z.number().describe('Snapped longitude'),
  elevation: z.number().describe('Elevation at grid point (meters)'),
  timezone: z.string().describe('Resolved IANA timezone'),
  date_range: z.object({
    start: z.string().describe('Actual start date of returned data'),
    end: z.string().describe('Actual end date of returned data'),
  }).describe('Date range of returned data'),
  record_count: z.number().describe('Total number of records (hourly or daily rows) in this response'),
  hourly: z.array(z.record(z.unknown())).optional()
    .describe('Per-hour records with "time" (ISO 8601) + variable keys. Empty when only daily was requested.'),
  daily: z.array(z.record(z.unknown())).optional()
    .describe('Per-day records with "time" (YYYY-MM-DD) + variable keys. Empty when only hourly was requested.'),
  hourly_units: z.record(z.string()).optional()
    .describe('Variable → unit string for hourly data.'),
  daily_units: z.record(z.string()).optional()
    .describe('Variable → unit string for daily data.'),
  canvas_id: z.string().optional()
    .describe('DataCanvas token — present only when truncated is true (data spilled). Query with SQL using this token.'),
  truncated: z.boolean()
    .describe('True when the response was too large to return inline and data spilled to canvas_id. Query the canvas for the full dataset — it holds every hourly and daily row, including any column the preview omits.'),
}
```

**Errors:**
```ts
errors: [
  {
    reason: 'date_out_of_range',
    code: JsonRpcErrorCode.ValidationError,
    when: 'start_date predates 1940-01-01 or end_date is within the ERA5 lag window',
    recovery: 'Use start_date >= 1940-01-01. For dates within the last ~5 days, use openmeteo_get_forecast with past_days instead.',
    retryable: false,
  },
  {
    reason: 'date_order_invalid',
    code: JsonRpcErrorCode.ValidationError,
    when: 'end_date is before start_date',
    recovery: 'Ensure end_date is on or after start_date.',
    retryable: false,
  },
  {
    reason: 'no_variables_requested',
    code: JsonRpcErrorCode.ValidationError,
    when: 'Neither hourly_variables nor daily_variables was provided',
    recovery: 'Provide at least one of hourly_variables or daily_variables.',
    retryable: false,
  },
]
```

---

### `openmeteo_get_marine`

**Description:** Marine weather forecast for a coastal or ocean coordinate: wave height, wave period, wave direction, wind-wave height, swell height, sea-surface temperature. Forecast horizon up to 7 days. Reshapes columnar response into per-timestamp records. Best for open-ocean and coastal exposed points — sheltered inland waters return near-zero wave values. Common hourly variables: `wave_height`, `wave_direction`, `wave_period`, `wind_wave_height`, `wind_wave_direction`, `wind_wave_period`, `swell_wave_height`, `swell_wave_direction`, `swell_wave_period`. Common daily: `wave_height_max`, `wave_direction_dominant`, `wave_period_max`. Note: `ocean_current_velocity` is null for non-open-ocean coordinates.

**Input schema:**
```ts
{
  latitude: z.number().min(-90).max(90)
    .describe('Latitude of a coastal or ocean point. Use openmeteo_geocode to resolve a place name. Inland points return near-zero wave values.'),
  longitude: z.number().min(-180).max(180)
    .describe('Longitude in decimal degrees.'),
  hourly_variables: z.array(z.string()).optional()
    .describe('Hourly marine variables (e.g., ["wave_height", "wave_direction", "wave_period", "wind_wave_height", "swell_wave_height"]). At least one of hourly_variables or daily_variables required.'),
  daily_variables: z.array(z.string()).optional()
    .describe('Daily marine summary variables (e.g., ["wave_height_max", "wave_direction_dominant", "wave_period_max"]). At least one required.'),
  forecast_days: z.number().int().min(1).max(7).default(7)
    .describe('Forecast horizon in days (1–7). Default 7.'),
  timezone: z.string().default('auto')
    .describe('IANA timezone or "auto". Default "auto".'),
}
```

**Output schema:**
```ts
{
  latitude: z.number().describe('Snapped latitude'),
  longitude: z.number().describe('Snapped longitude'),
  timezone: z.string().describe('Resolved IANA timezone'),
  hourly: z.array(z.record(z.unknown())).optional()
    .describe('Per-hour records with "time" (ISO 8601) + variable keys (e.g., wave_height in meters, wave_direction in degrees, wave_period in seconds).'),
  daily: z.array(z.record(z.unknown())).optional()
    .describe('Per-day summary records.'),
  hourly_units: z.record(z.string()).optional()
    .describe('Variable → unit string for hourly data.'),
  daily_units: z.record(z.string()).optional()
    .describe('Variable → unit string for daily data.'),
}
```

---

### `openmeteo_get_air_quality`

**Description:** Modeled CAMS (Copernicus Atmosphere Monitoring Service) air quality forecast: PM2.5, PM10, nitrogen dioxide, sulphur dioxide, ozone, carbon monoxide, dust, pollen, and European/US AQI indices. This is modeled grid data, not measured station readings — for measured data, use `openaq-mcp-server`. Forecast only (no historical archive). Common variables: `pm2_5`, `pm10`, `carbon_monoxide`, `nitrogen_dioxide`, `sulphur_dioxide`, `ozone`, `dust`, `european_aqi`, `us_aqi`, `alder_pollen`, `birch_pollen`, `grass_pollen`, `mugwort_pollen`, `olive_pollen`, `ragweed_pollen`.

**Input schema:**
```ts
{
  latitude: z.number().min(-90).max(90)
    .describe('Latitude in decimal degrees. Use openmeteo_geocode to resolve a place name.'),
  longitude: z.number().min(-180).max(180)
    .describe('Longitude in decimal degrees.'),
  hourly_variables: z.array(z.string()).optional()
    .describe('Hourly air quality variables (e.g., ["pm2_5", "pm10", "ozone", "nitrogen_dioxide", "european_aqi", "us_aqi"]). At least one required.'),
  forecast_days: z.number().int().min(1).max(7).default(5)
    .describe('Forecast horizon in days (1–7). Default 5.'),
  timezone: z.string().default('auto')
    .describe('IANA timezone or "auto". Default "auto".'),
}
```

**Output schema:**
```ts
{
  latitude: z.number().describe('Snapped latitude'),
  longitude: z.number().describe('Snapped longitude'),
  timezone: z.string().describe('Resolved IANA timezone'),
  hourly: z.array(z.record(z.unknown())).optional()
    .describe('Per-hour records with "time" (ISO 8601) + variable keys. Units: pm2_5/pm10/dust in μg/m³, carbon_monoxide in μg/m³, nitrogen_dioxide/sulphur_dioxide/ozone in μg/m³, european_aqi/us_aqi as index values.'),
  hourly_units: z.record(z.string()).optional()
    .describe('Variable → unit string (e.g., {"pm2_5": "μg/m³", "european_aqi": "EAQI"}).'),
  data_source: z.literal('CAMS')
    .describe('Data source identifier — this is modeled forecast data from CAMS, not measured station data.'),
}
```

---

### `openmeteo_get_elevation`

**Description:** Terrain elevation from the Copernicus Digital Elevation Model (~90m resolution) for one or more coordinate pairs. Accepts up to 100 pairs per call. Useful for geographic context, elevation-adjusted weather interpretation, or route planning.

**Input schema:**
```ts
{
  latitudes: z.array(z.number().min(-90).max(90)).min(1).max(100)
    .describe('Array of latitudes in decimal degrees (up to 100). Must be same length as longitudes.'),
  longitudes: z.array(z.number().min(-180).max(180)).min(1).max(100)
    .describe('Array of longitudes in decimal degrees (up to 100). Must be same length as latitudes.'),
}
```

**Output schema:**
```ts
{
  elevations: z.array(z.object({
    latitude: z.number().describe('Input latitude'),
    longitude: z.number().describe('Input longitude'),
    elevation_m: z.number().describe('Terrain elevation in meters above sea level'),
  })).describe('Elevation values in input order'),
}
```

**Errors:**
```ts
errors: [
  {
    reason: 'coordinate_count_mismatch',
    code: JsonRpcErrorCode.ValidationError,
    when: 'latitudes and longitudes arrays have different lengths',
    recovery: 'Provide equal-length latitude and longitude arrays.',
    retryable: false,
  },
]
```

---

## Implementation Order

1. **Config and server setup** — `src/config/server-config.ts` with base URL overrides (all optional); update `createApp()` instructions with geocode-before-forecast guidance and ERA5 lag note.
2. **OpenMeteoService** — HTTP client wrapping all six endpoints; columnar-to-records reshape helper; retry with 2 attempts, 500ms delay; error envelope detection.
3. **`openmeteo_geocode`** — no reshape needed; guard `results ?? []`; `no_results` error contract.
4. **`openmeteo_get_elevation`** — simplest tool; validates array length parity; zips input coords with response array.
5. **`openmeteo_get_forecast`** — reshape helper for hourly + daily; `no_variables_requested` guard; rich `format()` output.
6. **`openmeteo_get_historical`** — same reshape; date validation; DataCanvas spillover for large ranges.
7. **`openmeteo_get_marine`** — same reshape; note ocean_current_velocity nullability.
8. **`openmeteo_get_air_quality`** — same reshape; surface `data_source: 'CAMS'` in output.

Each tool is independently testable. The reshape helper is the only shared internal logic.

---

## Design Decisions

**Single service, six endpoints.** All Open-Meteo endpoints share zero-auth, the same error envelope, and the same columnar response shape. Splitting into endpoint-specific services adds file count with no API seam — one `OpenMeteoService` with six methods is the right granularity.

**Handler-side reshape, not service-side.** The reshape from columnar arrays to per-timestamp records is in tool handlers (not the service). The service returns the raw API response; the tool reshapes it. This keeps the service return types exact mirrors of the API (easier to audit against upstream) and makes the reshape logic visible at the layer that designs the output schema.

**Shared reshape helper.** While reshape logic stays in handlers, the mechanical zip of `time[]` + `variable[][]` into `Record<string, unknown>[]` is identical across forecast, historical, marine, and air quality. A single `reshapeColumnar(hourlyData, hourlyUnits)` helper in a shared utils file avoids duplication without abstracting the handler logic.

**`past_days` on forecast vs. historical.** ERA5 lag is variable (confirmed: archive served 2026-05-29 data on 2026-05-30 — only ~1 day lag on this probe, not always 5). Rather than promise a fixed lag, the docs say "up to ~5 days." The tool descriptions direct agents to use `past_days` on forecast for "recent history" to sidestep the ambiguity entirely.

**No resources.** Weather time-series has no stable URI — it changes by the hour, is keyed by coordinates + variables + timezone, and doesn't map to addressable entities. Resources add no value here.

**DataCanvas for historical, ensemble, flood, and climate.** These four are the tools whose response size is unbounded: multi-year hourly archive pulls reach tens of thousands of rows; ensemble and climate fan a variable out into one column per member or per model, so a payload grows by width as well as by length; and flood's GloFAS reanalysis runs daily from 1984, ~15.5k rows (~285 KB) for a full-history pull. Marine (max 7 days × 24h = 168 rows) and air quality (same) fit inline. Each of the four gets an optional `canvas_id` input plus `truncated`/`canvas_id`/`table_name` output.

**Spill eligibility is payload size, not row count.** The spill-capable tools measure the serialized size of the records they are about to return against one budget (`PREVIEW_CHARS` in `src/mcp-server/tools/spill-utils.ts`) and spill past it. That budget is the same number handed to `spillover()` as `previewChars`, which is what makes the precheck agree with the helper exactly: a result that would not spill never acquires a canvas. A row-count gate can only disagree — it misses a wide result that overflows the budget in a few hundred rows (a 16-day ensemble fan-out is ~376 KB in 384 rows), and it acquires a canvas for a narrow result that `spillover()` then declines to stage, burning a per-tenant canvas slot the caller never learns about because `canvas_id` is only surfaced on a real spill.

**Spill schemas are derived from the full record set, never sniffed.** The spill-capable tools pass `spillover()` an explicit `schema` built from every staged row. Left to infer, `spillover()` samples only its own preview buffer, and two real response shapes defeat that window: an ensemble `past_days` response opens with a long run of all-null placeholder rows (the models don't hindcast), leaving every column with no non-null evidence and typing them all VARCHAR; and hourly records are concatenated ahead of daily ones, so a large hourly pull exhausts the window before a daily row is sampled — and a column missing from the schema is never created on the table at all. Types come from every observed value rather than the first non-null one: `precipitation` arrives as `[0, 0.5, 0]`, whose leading `0` alone would type the column integer and truncate every fractional reading, and `sunrise`/`sunset` are ISO 8601 strings, so a blanket "weather columns are numeric" rule would corrupt them.

**One union table, not per-cadence tables.** Hourly and daily records stage into a single table under a union schema. The tools' output exposes one `table_name`, so separate tables would need a second handle; and the canvas append path treats a key missing from a row exactly like an explicit null, so ragged rows need no padding. Callers separate cadences by timestamp shape — hourly is `YYYY-MM-DDTHH:MM`, daily is `YYYY-MM-DD` (`WHERE time LIKE '%T%'`) — the same guarantee the tools' own preview-splitting relies on, so a dedicated discriminator column would be redundant.

**Marine `daily_variables` included.** Live probe confirmed the marine API supports `daily` alongside `hourly`. Surfacing both mirrors the forecast/historical UX and lets agents get daily wave summaries without parsing 168 hourly records.

**`ocean_current_velocity` noted as unreliable for non-ocean points.** Live probe: all `null` for Puget Sound coordinates. Document this in the tool description rather than filtering the variable — agents should know to expect nulls.

**`openmeteo_air_quality` is forecast-only.** Confirmed by API design — there is no archive endpoint for CAMS data. Tool description explicitly scopes to modeled forecast, with a pointer to `openaq-mcp-server` for measured station readings.

**No `weather_code` decoding table inline.** WMO weather interpretation codes (0–99) map to text descriptions. Rather than embed a decoding table in the tool (bloat), the handler reshapes codes as-is and the `format()` includes a brief mapping for the most common codes. Agents can request decoded descriptions if needed.

---

## Known Limitations

- **ERA5 lag is variable** — typically 1–5 days. Agents querying "yesterday" may get an empty result from the archive. The `past_days` parameter on the forecast tool is the reliable path for recent history.
- **Marine data for sheltered/inland waters** — Low wave values are accurate for sheltered inland waters but can be confusing for agents expecting open-ocean data for a coastal city. The tool description warns about this.
- **Air quality is modeled, not measured** — CAMS resolution is coarser than ground stations. Values can differ significantly from local measurements. Cross-reference `openaq-mcp-server` for point measurements.
- **Fair-use ceiling** — ~10,000 req/day for non-commercial use. No per-request signal when approaching the limit. The server should rely on 429 HTTP status detection only.
- **Coordinate snapping** — Open-Meteo snaps inputs to the nearest grid point. The response `latitude`/`longitude` reflect the snapped point, not the exact input. Returned in tool output for transparency.
- **No WMO weather code text** — `weather_code` variable returns integer codes (WMO 4677). Decoding is not built in; agents can request the `weather_code` variable and interpret using the standard table.

---

## API Reference

### Base URLs

| Endpoint | Base URL |
|:---------|:---------|
| Forecast | `https://api.open-meteo.com/v1/forecast` |
| Historical | `https://archive-api.open-meteo.com/v1/archive` |
| Marine | `https://marine-api.open-meteo.com/v1/marine` |
| Air Quality | `https://air-quality-api.open-meteo.com/v1/air-quality` |
| Geocoding | `https://geocoding-api.open-meteo.com/v1/search` |
| Elevation | `https://api.open-meteo.com/v1/elevation` |

### Key query parameters (weather endpoints)

| Parameter | Weather tools | Description |
|:----------|:-------------|:------------|
| `latitude` / `longitude` | all | Decimal degrees |
| `hourly` | forecast, historical, marine, air quality | Comma-separated variable names |
| `daily` | forecast, historical, marine | Comma-separated daily variable names |
| `timezone` | all | IANA timezone or `auto` |
| `forecast_days` | forecast | 1–16; default 7 |
| `past_days` | forecast | 0–92; default 0 |
| `start_date` / `end_date` | historical | YYYY-MM-DD; required |
| `temperature_unit` | forecast, historical | `celsius` (default) or `fahrenheit` |
| `wind_speed_unit` | forecast, historical | `kmh` (default), `mph`, `ms`, `kn` |
| `precipitation_unit` | forecast, historical | `mm` (default) or `inch` |

### Rate limits

Fair-use (non-commercial): ~10,000 req/day, 5,000/hour, 600/min. HTTP 429 on excess. Commercial use requires paid tier.
