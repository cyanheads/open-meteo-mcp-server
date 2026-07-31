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
| `openmeteo_search_locations` | Resolve a place name to ranked coordinate matches. Required first step before any weather tool — weather tools take coordinates, not names. Returns name, country, admin1/2, lat/lon, elevation, timezone, population, and feature type for disambiguation. | `name: string`, `count?: 1–10` | `readOnlyHint: true` |
| `openmeteo_get_forecast` | Weather forecast for coordinates: hourly and/or daily variables for up to 16 days. Optional `past_days` (up to 92) covers recent history when ERA5 has a lag. Reshapes columnar API response into per-timestamp records. `timezone=auto` default localizes to the location. Wide windows spill to DataCanvas. | `latitude`, `longitude`, `hourly_variables?: string[]`, `daily_variables?: string[]`, `forecast_days?: 1–16`, `past_days?: 0–92`, `wind_speed_unit?`, `temperature_unit?`, `canvas_id?` | `readOnlyHint: true` |
| `openmeteo_get_historical` | Historical weather from the ERA5 reanalysis archive (1940–present, ~5-day lag). Date range required; same variable vocabulary as `openmeteo_get_forecast` so past and forecast are directly comparable. Large ranges spill to DataCanvas. | `latitude`, `longitude`, `start_date: ISO date`, `end_date: ISO date`, `hourly_variables?: string[]`, `daily_variables?: string[]`, `timezone?`, `temperature_unit?`, `wind_speed_unit?`, `canvas_id?` | `readOnlyHint: true` |
| `openmeteo_get_marine` | Marine wave and ocean conditions for a coastal or ocean coordinate: wave height/period/direction, wind-wave, swell components. Reshapes columnar response into per-timestamp records. One window per call: `forecast_days`/`past_days` for the forecast, or `start_date`+`end_date` together for the archive (real wave values back to at least 2022). Best for open-ocean and coastal points; inland points return near-zero wave values. Wide windows spill to DataCanvas. | `latitude`, `longitude`, `hourly_variables?: string[]`, `daily_variables?: string[]`, `forecast_days?: 1–8`, `past_days?: 0–92`, `start_date?: ISO date`, `end_date?: ISO date`, `timezone?`, `canvas_id?` | `readOnlyHint: true`, `idempotentHint: true` |
| `openmeteo_get_air_quality` | Modeled CAMS air quality: PM2.5, PM10, NO2, SO2, O3, CO, dust, pollen, and European/US AQI indices. Modeled grid data — cross-reference `openaq-mcp-server` for measured station readings. One window per call: `forecast_days`/`past_days` for the forecast, or `start_date`+`end_date` together for the archive (real CAMS values back to at least 2022-10-01). Wide windows spill to DataCanvas. | `latitude`, `longitude`, `hourly_variables?: string[]`, `forecast_days?: 1–7`, `past_days?: 0–92`, `start_date?: ISO date`, `end_date?: ISO date`, `timezone?`, `canvas_id?` | `readOnlyHint: true`, `idempotentHint: true` |
| `openmeteo_get_elevation` | Terrain elevation from Copernicus DEM (~90m resolution) for one or more coordinates. Accepts up to 100 coordinate pairs in one call. | `latitudes: number[]`, `longitudes: number[]` | `readOnlyHint: true`, `idempotentHint: true` |
| `openmeteo_get_ensemble` | Probabilistic ensemble forecast — up to 51 members, up to 16 days ahead. Each member's values appear as a suffixed column (`temperature_2m_member01`). Use the spread across members for exceedance probabilities and uncertainty. Large multi-member pulls spill to DataCanvas. | `latitude`, `longitude`, `hourly_variables?: string[]`, `daily_variables?: string[]`, `models?`, `forecast_days?: 1–16`, `past_days?: 0–92`, `timezone?`, `canvas_id?` | `readOnlyHint: true`, `idempotentHint: true` |
| `openmeteo_get_flood` | GloFAS river discharge (m³/s) for the river nearest the coordinates — the API snaps to the nearest stream, no river ID needed. One mode per call: `forecast_days` for the outlook, or `start_date`+`end_date` together for reanalysis history back to 1984. Wide ranges spill to DataCanvas. | `latitude`, `longitude`, `daily_variables?: string[]`, `forecast_days?: 1–210`, `start_date?: ISO date`, `end_date?: ISO date`, `timezone?`, `canvas_id?` | `readOnlyHint: true`, `idempotentHint: true` |
| `openmeteo_get_climate` | Bias-corrected daily CMIP6 climate projections, 1950–2050 — the future-projection counterpart to `openmeteo_get_historical`. With 2+ models each variable is suffixed by model name. Daily resolution only. Multi-decade multi-model pulls spill to DataCanvas. | `latitude`, `longitude`, `start_date: ISO date`, `end_date: ISO date`, `daily_variables?: string[]`, `models?: string[]` (max 7), `timezone?`, `canvas_id?` | `readOnlyHint: true`, `idempotentHint: true` |
| `openmeteo_dataframe_describe` | List the tables and columns staged on a DataCanvas by the seven spill-capable tools. Call before querying to discover table names. | `canvas_id: string` | `readOnlyHint: true`, `idempotentHint: true` |
| `openmeteo_dataframe_query` | Run a read-only SQL SELECT against tables staged on a DataCanvas. Takes the `canvas_id` and the `table_name` returned when a tool spills (`truncated: true`). | `canvas_id: string`, `sql: string` | `readOnlyHint: true` |

### Resources

None. All data is ephemeral time-series — no stable URI pattern warrants a resource. Tool-only access is complete for every workflow.

### Prompts

None. The domain is data-lookup, not interactive guidance.

---

## Overview

Global weather and climate data via Open-Meteo's keyless API — forecast up to 16 days, ERA5 historical reanalysis back to 1940, marine/wave conditions, modeled air quality, place-name geocoding, and terrain elevation. No API key for non-commercial use; no auth; a generous fair-use ceiling (~10k requests/day).

Fills the **global** gap in keyless weather coverage that `nws-weather-mcp-server` and `noaa-cdo-mcp-server` leave: NWS is US-only; NOAA CDO has token management friction. Open-Meteo serves any coordinates on Earth with consistent variable names across both forecast and history, making past-vs-forecast comparisons on one schema practical.

The server is self-contained: `openmeteo_search_locations` resolves free-text place names to coordinates so agents don't need an external geocoder.

**Attribution:** Weather data by Open-Meteo.com (CC BY 4.0). Non-commercial use is free and keyless; commercial use requires the paid API tier.

---

## Requirements

- Forecast: `api.open-meteo.com/v1/forecast` — hourly and daily variables up to 16 days forward and 92 days back (via `past_days`), explicit variable selection, metric/imperial units, `timezone=auto`
- Historical: `archive-api.open-meteo.com/v1/archive` — ERA5 reanalysis 1940–present, ~5-day lag (variable); `start_date`/`end_date` required
- Marine: `marine-api.open-meteo.com/v1/marine` — wave/swell/ocean variables; daily marine variables supported; `forecast_days` 1–16 upstream, but the wave columns run out before the window does — the null boundary moves with each model run (measured at hour 216 on 2026-07-31), so the tool caps at 8, `past_days` 0–92, or a `start_date`/`end_date` archive range
- Air quality: `air-quality-api.open-meteo.com/v1/air-quality` — CAMS-modeled; `forecast_days` 1–7 (hard upstream cap), `past_days` 0–92, or a `start_date`/`end_date` archive range
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

### `openmeteo_search_locations`

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

**Description:** Weather forecast for coordinates: hourly and/or daily variables for up to 16 days ahead, with optional `past_days` (up to 92) for recent history. Use `past_days` instead of `openmeteo_get_historical` for dates within the last 1–5 days, since the ERA5 archive has a variable lag. Reshapes the columnar API response into per-timestamp records. Common hourly variables: `temperature_2m`, `precipitation`, `wind_speed_10m`, `relative_humidity_2m`, `cloud_cover`, `uv_index`, `apparent_temperature`, `precipitation_probability`, `weather_code`, `surface_pressure`, `visibility`, `wind_direction_10m`, `wind_gusts_10m`, `dew_point_2m`. Common daily variables: `temperature_2m_max`, `temperature_2m_min`, `precipitation_sum`, `wind_speed_10m_max`, `sunrise`, `sunset`, `uv_index_max`, `precipitation_hours`, `weather_code`. A wide window — a large `past_days` plus many hourly variables — produces thousands of records; these spill to DataCanvas for SQL querying when canvas is enabled, and return a bounded preview with `truncated: true` when it is not. At least one of `hourly_variables` or `daily_variables` is required.

**Input schema:**
```ts
{
  latitude: z.number().min(-90).max(90)
    .describe('Latitude in decimal degrees (e.g., 47.6062 for Seattle). Use openmeteo_search_locations to resolve a place name to coordinates.'),
  longitude: z.number().min(-180).max(180)
    .describe('Longitude in decimal degrees (e.g., -122.3321 for Seattle).'),
  hourly_variables: z.array(z.string()).optional()
    .describe('Hourly variables to fetch (e.g., ["temperature_2m", "precipitation", "wind_speed_10m", "relative_humidity_2m", "cloud_cover", "uv_index", "apparent_temperature"]). Hourly names only — a daily aggregate such as temperature_2m_max or precipitation_sum belongs in daily_variables and is rejected here. At least one of hourly_variables or daily_variables is required.'),
  daily_variables: z.array(z.string()).optional()
    .describe('Daily summary variables (e.g., ["temperature_2m_max", "temperature_2m_min", "precipitation_sum", "wind_speed_10m_max", "sunrise", "sunset", "uv_index_max"]). Daily names only — an hourly name such as cloud_cover or temperature_2m belongs in hourly_variables and is rejected here; for a daily summary of an hourly variable use its published aggregate (cloud_cover_max, cloud_cover_mean, cloud_cover_min). At least one of hourly_variables or daily_variables is required.'),
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
    .describe('IANA timezone (e.g., "America/Los_Angeles") or "auto" to use the location\'s local timezone. Default "auto". The timezone from openmeteo_search_locations is ideal to pass here.'),
  canvas_id: z.string().optional()
    .describe('DataCanvas token for wide past_days or multi-variable queries. When a result is too large to return inline — driven by total payload size, so a wide multi-variable pull can spill at any row count — it spills to this canvas for SQL querying. Omit to create a fresh canvas.'),
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
  record_count: z.number().describe('Total number of records (hourly + daily rows) — the full upstream total when truncated is true, not the combined length of the hourly and daily previews.'),
  hourly: z.array(z.record(z.unknown())).optional()
    .describe('Per-hour records. Each object has a "time" field (ISO 8601) plus one key per requested variable with its value. Units are in the hourly_units map. When truncated, contains only a preview — query canvas_id for the full dataset when one is present.'),
  daily: z.array(z.record(z.unknown())).optional()
    .describe('Per-day records. Each object has a "time" field (YYYY-MM-DD) plus one key per requested variable with its value. Units are in the daily_units map. When truncated, contains only a preview — query canvas_id for the full dataset when one is present.'),
  hourly_units: z.record(z.string()).optional()
    .describe('Map of variable name → unit string for hourly data (e.g., {"temperature_2m": "°C", "precipitation": "mm"}).'),
  daily_units: z.record(z.string()).optional()
    .describe('Map of variable name → unit string for daily data.'),
  canvas_id: z.string().optional()
    .describe('DataCanvas token for the staged full dataset. Present only when truncated is true AND DataCanvas is enabled (CANVAS_PROVIDER_TYPE=duckdb) — absent otherwise, in which case the preview is all this response carries. Query with SQL using this token.'),
  table_name: z.string().optional()
    .describe('DuckDB table name for the staged data — pass to openmeteo_dataframe_query. Present only alongside canvas_id.'),
  truncated: z.boolean()
    .describe('True when the response was too large to return inline, so hourly and daily carry a bounded preview rather than the full set. With DataCanvas enabled the complete data is staged at canvas_id — every hourly and daily row, including any column the preview omits. With it disabled there is no canvas_id, and the omitted rows are reached only by narrowing the request.'),
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
    reason: 'variable_wrong_cadence',
    code: JsonRpcErrorCode.ValidationError,
    when: 'A variable Open-Meteo documents under one cadence was passed in the other cadence field — for example cloud_cover in daily_variables, or temperature_2m_max in hourly_variables',
    recovery: 'Move each variable the message names to the field the message names, or drop it — hourly_variables and daily_variables take separate Open-Meteo variable sets, and the message lists the same-cadence alternatives when the endpoint publishes any.',
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

**Enrichment:**
```ts
enrichment: {
  notice: z.string().optional()
    .describe('Warning that a requested variable came back with no data — names each column whose unit is "undefined", which is how the endpoint reports a name it parsed but does not serve in the requested cadence.'),
}
```

The same `variable_wrong_cadence` contract entry and cadence-aware pre-call guard are declared on `openmeteo_get_historical`, `openmeteo_get_marine`, and `openmeteo_get_ensemble`. The `notice` enrichment goes further — it is declared on every weather tool that takes variable names, so `openmeteo_get_air_quality`, `openmeteo_get_flood`, and `openmeteo_get_climate` carry it without a cadence guard. See the design decision below for which tools carry which half and why.

---

### `openmeteo_get_historical`

**Description:** Historical weather from the ERA5 reanalysis archive (1940–present). Requires `start_date` and `end_date` (ISO 8601 date, e.g., "2024-07-01"). ERA5 has a variable lag of up to ~5 days — for dates within the last week, use `openmeteo_get_forecast` with `past_days` instead. Uses the same variable names as the forecast API for direct comparison. Large date ranges (multi-year hourly) produce thousands of records — these spill to DataCanvas for SQL querying. At least one of `hourly_variables` or `daily_variables` is required.

**Input schema:**
```ts
{
  latitude: z.number().min(-90).max(90)
    .describe('Latitude in decimal degrees. Use openmeteo_search_locations to resolve a place name to coordinates.'),
  longitude: z.number().min(-180).max(180)
    .describe('Longitude in decimal degrees.'),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('Start date (YYYY-MM-DD, e.g., "2024-07-01"). ERA5 covers from 1940-01-01 to approximately 5 days ago.'),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('End date (YYYY-MM-DD, inclusive). Must be on or after start_date. For dates within the last ~5 days, use openmeteo_get_forecast with past_days instead.'),
  hourly_variables: z.array(z.string()).optional()
    .describe('Hourly ERA5 variables (e.g., ["temperature_2m", "precipitation", "wind_speed_10m", "relative_humidity_2m", "cloud_cover", "soil_moisture_0_to_7cm"]). Hourly names only — a daily aggregate such as temperature_2m_max or precipitation_sum belongs in daily_variables and is rejected here. At least one of hourly_variables or daily_variables required.'),
  daily_variables: z.array(z.string()).optional()
    .describe('Daily summary variables (e.g., ["temperature_2m_max", "temperature_2m_min", "precipitation_sum", "wind_speed_10m_max"]). Daily names only — an hourly name such as cloud_cover or temperature_2m belongs in hourly_variables and is rejected here; for a daily summary of an hourly variable use its published aggregate (cloud_cover_max, cloud_cover_mean, cloud_cover_min). At least one of hourly_variables or daily_variables required.'),
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
  record_count: z.number().describe('Total number of records (hourly + daily rows) — the full upstream total when truncated is true, not the combined length of the hourly and daily previews.'),
  hourly: z.array(z.record(z.unknown())).optional()
    .describe('Per-hour records with "time" (ISO 8601) + variable keys. Empty when only daily was requested.'),
  daily: z.array(z.record(z.unknown())).optional()
    .describe('Per-day records with "time" (YYYY-MM-DD) + variable keys. Empty when only hourly was requested.'),
  hourly_units: z.record(z.string()).optional()
    .describe('Variable → unit string for hourly data.'),
  daily_units: z.record(z.string()).optional()
    .describe('Variable → unit string for daily data.'),
  canvas_id: z.string().optional()
    .describe('DataCanvas token for the staged full dataset. Present only when truncated is true AND DataCanvas is enabled (CANVAS_PROVIDER_TYPE=duckdb) — absent otherwise, in which case the preview is all this response carries. Query with SQL using this token.'),
  truncated: z.boolean()
    .describe('True when the response was too large to return inline, so hourly and daily carry a bounded preview rather than the full set. With DataCanvas enabled the complete data is staged at canvas_id — every hourly and daily row, including any column the preview omits. With it disabled there is no canvas_id, and the omitted rows are reached only by narrowing the request.'),
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
  {
    reason: 'variable_wrong_cadence',
    code: JsonRpcErrorCode.ValidationError,
    when: 'A variable Open-Meteo documents under one cadence was passed in the other cadence field — for example cloud_cover in daily_variables, or temperature_2m_max in hourly_variables',
    recovery: 'Move each variable the message names to the field the message names, or drop it — hourly_variables and daily_variables take separate ERA5 variable sets, and the message lists the same-cadence alternatives when the archive publishes any.',
    retryable: false,
  },
]
```

**Enrichment:** same `notice` field as `openmeteo_get_forecast` — the archive shares the forecast API's silent all-null failure for a wrong-cadence name it parses but does not serve.

---

### `openmeteo_get_marine`

**Description:** Marine wave and ocean conditions for a coastal or ocean coordinate: wave height, wave period, wave direction, wind-wave height, swell height, sea-surface temperature. Forecast horizon up to 8 days with optional `past_days` (up to 92), or `start_date` and `end_date` together for an archive range back to at least 2022 — one window per call, and a range needs both ends. Reshapes columnar response into per-timestamp records. Wide windows spill to DataCanvas. Best for open-ocean and coastal exposed points — sheltered inland waters return near-zero wave values. Common hourly variables: `wave_height`, `wave_direction`, `wave_period`, `wind_wave_height`, `wind_wave_direction`, `wind_wave_period`, `swell_wave_height`, `swell_wave_direction`, `swell_wave_period`. Common daily: `wave_height_max`, `wave_direction_dominant`, `wave_period_max`. Note: `ocean_current_velocity` is null for non-open-ocean coordinates.

**Input schema:**
```ts
{
  latitude: z.number().min(-90).max(90)
    .describe('Latitude of a coastal or ocean point. Use openmeteo_search_locations to resolve a place name. Inland points return near-zero wave values.'),
  longitude: z.number().min(-180).max(180)
    .describe('Longitude in decimal degrees.'),
  hourly_variables: z.array(z.string()).optional()
    .describe('Hourly marine variables (e.g., ["wave_height", "wave_direction", "wave_period", "wind_wave_height", "swell_wave_height"]). Hourly names only — a daily aggregate such as wave_height_max or wave_direction_dominant belongs in daily_variables and is rejected here. At least one of hourly_variables or daily_variables required.'),
  daily_variables: z.array(z.string()).optional()
    .describe('Daily marine summary variables (e.g., ["wave_height_max", "wave_direction_dominant", "wave_period_max"]). Daily names only — an hourly name such as wave_height belongs in hourly_variables and is rejected here; for a daily summary use its published aggregate (wave_height_max). At least one required.'),
  forecast_days: z.number().int().min(1).max(8).optional()
    .describe('Forecast horizon in days (1–8). Omit for the upstream default of 7. Mutually exclusive with start_date/end_date.'),
  past_days: z.number().int().min(0).max(92).default(0)
    .describe('Include this many days of past data before today (0–92). Default 0. Must stay 0 when start_date/end_date are used.'),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe('Start date for the archive range (YYYY-MM-DD). Real wave values go back to at least 2022. Requires end_date.'),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe('End date for the archive range (YYYY-MM-DD, inclusive). Requires start_date.'),
  timezone: z.string().default('auto')
    .describe('IANA timezone or "auto". Default "auto".'),
  canvas_id: z.string().optional()
    .describe('DataCanvas token for wide past_days, archive-range, or multi-variable queries. Omit to create a fresh canvas.'),
}
```

**Output schema:**
```ts
{
  latitude: z.number().describe('Snapped latitude'),
  longitude: z.number().describe('Snapped longitude'),
  timezone: z.string().describe('Resolved IANA timezone'),
  record_count: z.number().describe('Total number of records (hourly + daily rows) — the full upstream total when truncated is true, not the combined length of the previews.'),
  hourly: z.array(z.record(z.unknown())).optional()
    .describe('Per-hour records with "time" (ISO 8601) + variable keys (e.g., wave_height in meters, wave_direction in degrees, wave_period in seconds). When truncated, contains only a preview.'),
  daily: z.array(z.record(z.unknown())).optional()
    .describe('Per-day summary records. When truncated, contains only a preview.'),
  hourly_units: z.record(z.string()).optional()
    .describe('Variable → unit string for hourly data.'),
  daily_units: z.record(z.string()).optional()
    .describe('Variable → unit string for daily data.'),
  canvas_id: z.string().optional()
    .describe('DataCanvas token for the staged full dataset. Present only when truncated is true AND DataCanvas is enabled.'),
  table_name: z.string().optional()
    .describe('DuckDB table name for the staged data — pass to openmeteo_dataframe_query. Present only alongside canvas_id.'),
  truncated: z.boolean()
    .describe('True when the response was too large to return inline, so hourly and daily carry a bounded preview rather than the full set.'),
}
```

---

### `openmeteo_get_air_quality`

**Description:** Modeled CAMS (Copernicus Atmosphere Monitoring Service) air quality: PM2.5, PM10, nitrogen dioxide, sulphur dioxide, ozone, carbon monoxide, dust, pollen, and European/US AQI indices. This is modeled grid data, not measured station readings — for measured data, use `openaq-mcp-server`. Forecast horizon up to 7 days with optional `past_days` (up to 92), or `start_date` and `end_date` together for an archive range back to at least 2022-10-01 — one window per call, and a range needs both ends. Wide windows spill to DataCanvas. Common variables: `pm2_5`, `pm10`, `carbon_monoxide`, `nitrogen_dioxide`, `sulphur_dioxide`, `ozone`, `dust`, `european_aqi`, `us_aqi`, `alder_pollen`, `birch_pollen`, `grass_pollen`, `mugwort_pollen`, `olive_pollen`, `ragweed_pollen`.

**Input schema:**
```ts
{
  latitude: z.number().min(-90).max(90)
    .describe('Latitude in decimal degrees. Use openmeteo_search_locations to resolve a place name.'),
  longitude: z.number().min(-180).max(180)
    .describe('Longitude in decimal degrees.'),
  hourly_variables: z.array(z.string()).optional()
    .describe('Hourly air quality variables (e.g., ["pm2_5", "pm10", "ozone", "nitrogen_dioxide", "european_aqi", "us_aqi"]). At least one required.'),
  forecast_days: z.number().int().min(1).max(7).optional()
    .describe('Forecast horizon in days (1–7). Omit for the upstream default of 5. Mutually exclusive with start_date/end_date.'),
  past_days: z.number().int().min(0).max(92).default(0)
    .describe('Include this many days of past data before today (0–92). Default 0. Must stay 0 when start_date/end_date are used.'),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe('Start date for the archive range (YYYY-MM-DD). Real CAMS values go back to at least 2022-10-01. Requires end_date.'),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe('End date for the archive range (YYYY-MM-DD, inclusive). Requires start_date.'),
  timezone: z.string().default('auto')
    .describe('IANA timezone or "auto". Default "auto".'),
  canvas_id: z.string().optional()
    .describe('DataCanvas token for wide past_days, archive-range, or multi-variable queries. Omit to create a fresh canvas.'),
}
```

**Output schema:**
```ts
{
  latitude: z.number().describe('Snapped latitude'),
  longitude: z.number().describe('Snapped longitude'),
  timezone: z.string().describe('Resolved IANA timezone'),
  record_count: z.number().describe('Total number of hourly records — the full upstream total when truncated is true, not the length of the preview.'),
  hourly: z.array(z.record(z.unknown())).optional()
    .describe('Per-hour records with "time" (ISO 8601) + variable keys. Units: pm2_5/pm10/dust in μg/m³, carbon_monoxide in μg/m³, nitrogen_dioxide/sulphur_dioxide/ozone in μg/m³, european_aqi/us_aqi as index values. When truncated, contains only a preview.'),
  hourly_units: z.record(z.string()).optional()
    .describe('Variable → unit string (e.g., {"pm2_5": "μg/m³", "european_aqi": "EAQI"}).'),
  data_source: z.literal('CAMS')
    .describe('Data source identifier — this is modeled CAMS data, forecast or archive, not measured station data.'),
  canvas_id: z.string().optional()
    .describe('DataCanvas token for the staged full dataset. Present only when truncated is true AND DataCanvas is enabled.'),
  table_name: z.string().optional()
    .describe('DuckDB table name for the staged data — pass to openmeteo_dataframe_query. Present only alongside canvas_id.'),
  truncated: z.boolean()
    .describe('True when the response was too large to return inline, so hourly carries a bounded preview rather than the full set.'),
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
3. **`openmeteo_search_locations`** — no reshape needed; guard `results ?? []`; `no_results` error contract.
4. **`openmeteo_get_elevation`** — simplest tool; validates array length parity; zips input coords with response array.
5. **`openmeteo_get_forecast`** — reshape helper for hourly + daily; `no_variables_requested` guard; rich `format()` output; DataCanvas spillover for wide `past_days` windows.
6. **`openmeteo_get_historical`** — same reshape; date validation; DataCanvas spillover for large ranges.
7. **`openmeteo_get_marine`** — same reshape; note ocean_current_velocity nullability; window guards and DataCanvas spillover.
8. **`openmeteo_get_air_quality`** — same reshape; surface `data_source: 'CAMS'` in output; window guards and DataCanvas spillover.

Each tool is independently testable. The reshape helper is the only shared internal logic.

---

## Design Decisions

**Single service, six endpoints.** All Open-Meteo endpoints share zero-auth, the same error envelope, and the same columnar response shape. Splitting into endpoint-specific services adds file count with no API seam — one `OpenMeteoService` with six methods is the right granularity.

**Handler-side reshape, not service-side.** The reshape from columnar arrays to per-timestamp records is in tool handlers (not the service). The service returns the raw API response; the tool reshapes it. This keeps the service return types exact mirrors of the API (easier to audit against upstream) and makes the reshape logic visible at the layer that designs the output schema.

**Shared reshape helper.** While reshape logic stays in handlers, the mechanical zip of `time[]` + `variable[][]` into `Record<string, unknown>[]` is identical across forecast, historical, marine, and air quality. A single `reshapeColumnar(hourlyData, hourlyUnits)` helper in a shared utils file avoids duplication without abstracting the handler logic.

**`past_days` on forecast vs. historical.** ERA5 lag is variable (confirmed: archive served 2026-05-29 data on 2026-05-30 — only ~1 day lag on this probe, not always 5). Rather than promise a fixed lag, the docs say "up to ~5 days." The tool descriptions direct agents to use `past_days` on forecast for "recent history" to sidestep the ambiguity entirely.

**No resources.** Weather time-series has no stable URI — it changes by the hour, is keyed by coordinates + variables + timezone, and doesn't map to addressable entities. Resources add no value here.

**DataCanvas for every tool with an unbounded response.** Seven qualify: multi-year hourly archive pulls reach tens of thousands of rows; ensemble and climate fan a variable out into one column per member or per model, so a payload grows by width as well as by length; flood's GloFAS reanalysis runs daily from 1984, ~15.5k rows (~285 KB) for a full-history pull; and forecast accepts `past_days: 92` alongside `forecast_days: 16`, a 108-day window that reaches the same class as the archive tool it defers to for recent history. Marine and air quality joined once they exposed `past_days` and a date range — 2,232 hourly rows at `past_days: 92` on both, and even the forecast-only window already reached ~135 KB (air quality, 20 variables × 7 days) and ~111 KB (marine, 12 variables × 7 days) inline with no retrieval path. Each of the seven gets an optional `canvas_id` input plus `truncated`/`record_count`/`canvas_id`/`table_name` output.

**An exceeded budget bounds the response whether or not a canvas exists.** `CANVAS_PROVIDER_TYPE` defaults to `none`, so on a default deployment `getCanvas()` returns undefined. Gating the whole size check behind a canvas would let an over-budget result fall through to an unbounded inline return carrying `truncated: false` — the field a client reads to decide whether anything is missing — so `boundedPreview()` in `spill-utils.ts` truncates against the same `PREVIEW_CHARS` budget with no canvas behind it, and `format()` says why there is no `canvas_id` and how to reach the rest (enable `CANVAS_PROVIDER_TYPE=duckdb`, or narrow the request). `record_count` keeps reporting the full upstream total on that path, not the preview length, so the caller can tell how much is missing. Rejecting wide inputs was the alternative and is worse: those ranges are valid, and a caller who wants the whole set should still be able to get it by enabling canvas.

**The canvas-less preview starts at the first row carrying data.** On that path the preview is everything the caller gets, and three real response shapes open with a run of all-null rows: an ensemble `past_days` response leads with placeholder rows the models don't hindcast; the forecast API serves fewer past days than `past_days: 92` allows, so the unserved head comes back null (a Seattle 92-day pull measured 733 null rows of 2,592, longer than the whole 80,000-character budget); and a GloFAS reanalysis range starting before the coordinate's record begins is null until it does (4,749 null rows of 15,523 from 1984). A chronological head spends the entire budget inside that run and returns a response with no data at all, so `boundedPreview()` skips it. Skipped rows are still counted in `record_count`, and when every row is null the head is returned as-is rather than an empty array. A two-cadence response gets the skip per cadence, since each array is bounded on its own. On the canvas path only ensemble reuses the same selection; the other six keep `spillover()`'s chronological head, since the canvas holds every row and a null-leading preview costs the caller nothing there.

**Spill eligibility is payload size, not row count.** The spill-capable tools measure the serialized size of the records they are about to return against one budget (`PREVIEW_CHARS` in `src/mcp-server/tools/spill-utils.ts`) and spill past it. That budget is the same number handed to `spillover()` as `previewChars`, which is what makes the precheck agree with the helper exactly: a result that would not spill never acquires a canvas. A row-count gate can only disagree — it misses a wide result that overflows the budget in a few hundred rows (a 16-day ensemble fan-out is ~376 KB in 384 rows), and it acquires a canvas for a narrow result that `spillover()` then declines to stage, burning a per-tenant canvas slot the caller never learns about because `canvas_id` is only surfaced on a real spill. The same total budget bounds the canvas-less path, so the two configurations return responses of the same size; how that budget divides between cadences differs, and the next decision says why.

**The canvas-less preview is bounded per cadence, and the budget splits half-and-half with the unused half released.** A single `boundedPreview()` over the concatenated `[...hourly, ...daily]` array cannot reach the daily rows: hourly records lead, so a wide hourly window spends the whole 80,000 characters before the first daily row and `daily` comes back empty even though the rows exist — a 92-day marine pull serves 2,400 hourly and 100 daily rows and returned 343 hourly, 0 daily. `boundedPreviewByCadence()` bounds each array separately instead. The division: each cadence is guaranteed half the budget, and a cadence that needs less releases the rest — daily takes its half, hourly takes everything daily left, daily is re-taken against whatever hourly left in turn, floored at its first pass so an hourly overshoot on a single oversized row cannot claw the guarantee back. A fixed half each was rejected because it would halve a single-cadence response for no reason; a straight first-come split was rejected because it starves whichever cadence comes second, which is the bug. Daily leads because it is the cheap side — 100 daily rows against 2,400 hourly in that same pull, so daily takes about an eighth of the budget and never reaches its half. Measured against that live response: hourly goes from 343 rows to 301 and daily from 0 to all 100, inside the same 80,000 characters. The pair overshoots by at most one row per cadence, exactly as one `boundedPreview()` does, and each cadence gets its own leading-all-null skip rather than only the hourly head's. `format()` headings keep reporting `record_count`, the full upstream total, not preview lengths. The canvas path is untouched: `spillover()` stages every row of both cadences, so splitting its concatenated preview by timestamp shape is a faithful view of what it drained.

**Spill schemas are derived from the full record set, never sniffed.** The spill-capable tools pass `spillover()` an explicit `schema` built from every staged row. Left to infer, `spillover()` samples only its own preview buffer, and two real response shapes defeat that window: an ensemble `past_days` response opens with a long run of all-null placeholder rows (the models don't hindcast), leaving every column with no non-null evidence and typing them all VARCHAR; and hourly records are concatenated ahead of daily ones, so a large hourly pull exhausts the window before a daily row is sampled — and a column missing from the schema is never created on the table at all. Types come from every observed value rather than the first non-null one: `precipitation` arrives as `[0, 0.5, 0]`, whose leading `0` alone would type the column integer and truncate every fractional reading, and `sunrise`/`sunset` are ISO 8601 strings, so a blanket "weather columns are numeric" rule would corrupt them.

**One union table, not per-cadence tables.** Hourly and daily records stage into a single table under a union schema. The tools' output exposes one `table_name`, so separate tables would need a second handle; and the canvas append path treats a key missing from a row exactly like an explicit null, so ragged rows need no padding. Callers separate cadences by timestamp shape — hourly is `YYYY-MM-DDTHH:MM`, daily is `YYYY-MM-DD` (`WHERE time LIKE '%T%'`) — the same guarantee the tools' own preview-splitting relies on, so a dedicated discriminator column would be redundant.

**Marine `daily_variables` included.** Live probe confirmed the marine API supports `daily` alongside `hourly`. Surfacing both mirrors the forecast/historical UX and lets agents get daily wave summaries without parsing 168 hourly records.

**`ocean_current_velocity` noted as unreliable for non-ocean points.** Live probe: all `null` for Puget Sound coordinates. Document this in the tool description rather than filtering the variable — agents should know to expect nulls.

**Marine and air quality expose the endpoints' full time range, not just the forecast half.** Both endpoints serve `past_days` and a `start_date`/`end_date` range alongside `forecast_days`, and both return real values well before today — CAMS from at least 2022-10-01, marine waves from at least 2022. The exact archive boundary is not pinned in either description: it sits somewhere in 2022, and a precise date would be a claim the probe does not support. The two windows are mutually exclusive upstream, which is why `forecast_days` carries no schema default on either tool — a Zod default is indistinguishable from an explicit value, so a defaulted `forecast_days` would ride along with every archive-range call and upstream would reject it. Omitting it falls through to the endpoint's own default (5 days air quality, 7 marine), matching the previous behavior exactly.

**Variable validation rejects a confident misplacement, never an unknown name.** Open-Meteo keeps a separate variable set per cadence, and a name in the wrong bucket fails in one of two ways — both reproduced live. One direction returns a 400 whose message echoes the *entire* encoded variable list, valid siblings included: the server sends `hourly`/`daily` through `URLSearchParams`, which percent-encodes the commas, so upstream reads the list as one value and names all of it. The offender is never isolated and a caller cannot converge. The other direction returns HTTP 200 with an all-null column and the unit string `"undefined"` — a success indistinguishable from a genuine data gap, so there is no upstream error to reframe at all. A closed allowlist would catch both but was ruled out because Open-Meteo's variable set evolves and a stale allowlist converts a working call into a local error. The rule that satisfies both: reject a name only when it is documented in the bucket *opposite* the one it arrived in; a name in neither set is unknown, not invalid, and goes upstream untouched. `src/mcp-server/tools/variable-cadence.ts` holds the catalogs, sourced from each endpoint's published documentation page.

**One catalog per endpoint, not one shared catalog.** The endpoints genuinely differ: the ensemble API publishes `temperature_2m_max` as a 3-hourly aggregation under `hourly`, where the forecast API publishes it under `daily` only, and the archive carries ERA5-specific `*_spread` columns (`temperature_2m_spread`, `precipitation_spread`) that no other endpoint publishes. A shared catalog would reject a valid ensemble request. Four catalogs — forecast, historical, marine, ensemble — the four tools with two cadence buckets. A tool with one bucket (air quality, flood, climate) cannot have a misplacement and carries no guard.

**The `"undefined"` unit is a runtime backstop on every tool that takes variable names.** The catalogs deliberately do not know every name, so an unserved variable can still come back as a silent all-null column — and this is not confined to the cadence-guarded tools. Every weather endpoint shares the forecast API's variable parser and splits the same two ways: a name the parser *resolves* but the endpoint does not serve returns HTTP 200 with an all-null column whose unit is the literal string `"undefined"`; only a name the parser cannot resolve at all (`bogus_xyz`) draws a 400. Probed live: `hourly=temperature_2m` on marine, `hourly=precipitation_probability` on ensemble, `daily=precipitation_sum` on flood, and `daily=river_discharge_max` on climate all take the silent path. Dimensionless variables like `is_day` and `uv_index` carry an empty unit rather than `"undefined"`, so the tell is unambiguous. All seven weather tools surface it as an `enrichment` notice — reaching `structuredContent` and `content[]` both — rather than throwing, because the name may be perfectly valid and simply unserved for that coordinate or model: `temperature_2m_max` under `hourly` is real data on `ecmwf_ifs025` and an all-null column on `gfs025`. Air quality, flood, and climate get the notice without a cadence guard — one bucket makes a misplacement structurally impossible, but not an unserved name. The ensemble notice strips the `_memberNN` suffix before naming a variable, so a 51-member fan-out reports one name rather than fifty-one.

**`models` stays a free-form string, with a documented catalog behind it for advertising and isolation.** `openmeteo_get_ensemble` and `openmeteo_get_climate` take model names, and a misplacement cannot occur there — one field, no opposite bucket — so the cadence mechanism has nothing to compare against. Two problems remained: the advertised sets went stale (the ensemble API serves nineteen models where the description named four, and all four of those were spellings the documentation page no longer emits — they still resolve upstream, so nothing that worked before breaks), and a rejected multi-model *climate* request named every model the caller sent, valid ones included, because the array goes out as one percent-encoded comma list and upstream reads it as a single value. A `z.enum` on both fields would fix the advertising and break the pass-through, rejecting locally every model Open-Meteo adds — the same staleness converted into a hard failure. `src/mcp-server/tools/model-catalog.ts` takes the shape `variable-cadence.ts` already uses: a dated catalog sourced from each endpoint's documentation page, checked *after* upstream rejects rather than before the request. It supplies the advertised lists (so description, `models` describe, and `invalid_variable` recovery cannot drift apart) and narrows a rejected climate models echo to the requested names the documentation does not publish, guarding on the echoed value being exactly the requested list in order so a rejected *variable* name is never blamed on a model. A name the catalog does not carry still goes upstream untouched. Ensemble needs no isolation — it takes one model string, so its rejection already names only the offender.

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
| `forecast_days` | forecast, marine, air quality | forecast 1–16; marine 1–8; air quality 1–7 |
| `past_days` | forecast, marine, air quality | 0–92; default 0 |
| `start_date` / `end_date` | historical (required), marine, air quality | YYYY-MM-DD; sent as a pair, never with `forecast_days`/`past_days` |
| `temperature_unit` | forecast, historical | `celsius` (default) or `fahrenheit` |
| `wind_speed_unit` | forecast, historical | `kmh` (default), `mph`, `ms`, `kn` |
| `precipitation_unit` | forecast, historical | `mm` (default) or `inch` |

### Rate limits

Fair-use (non-commercial): ~10,000 req/day, 5,000/hour, 600/min. HTTP 429 on excess. Commercial use requires paid tier.
