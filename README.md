<div align="center">
  <h1>@cyanheads/open-meteo-mcp-server</h1>
  <p><b>Geocode places, fetch global weather forecasts, historical climate, marine conditions, air quality, and terrain elevation via MCP. STDIO or Streamable HTTP.</b>
  <div>11 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.10-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/open-meteo-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/open-meteo-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/open-meteo-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/open-meteo-mcp-server/releases/latest/download/open-meteo-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=open-meteo-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3Blbi1tZXRlby1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22open-meteo-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fopen-meteo-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://open-meteo.caseyjhand.com/mcp](https://open-meteo.caseyjhand.com/mcp)

</div>

---

## Overview

Global weather from Open-Meteo: forecasts, historical archive, marine conditions, air quality, probabilistic ensembles, river discharge, and CMIP6 climate projections. Geocode place names, pull hourly and daily variables, and run SQL over large results staged to DataCanvas. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `openmeteo_search_locations` | Resolve a place name to ranked coordinate matches with country, region, elevation, timezone, and population |
| `openmeteo_get_forecast` | Weather forecast for coordinates: current conditions and/or hourly and daily variables for up to 16 days, with optional recent past data; wide windows spill to DataCanvas |
| `openmeteo_get_historical` | Historical weather from the Open-Meteo reanalysis archive (1940–present); Best Match by default, or pin a `models` selection; large ranges spill to DataCanvas |
| `openmeteo_get_marine` | Marine wave and ocean conditions for coastal or ocean coordinates: wave height, period, direction, swell, and sea-surface temperature; up to 8 forecast days, `past_days`, or a `start_date`/`end_date` archive range; large windows spill to DataCanvas |
| `openmeteo_get_air_quality` | Modeled CAMS air quality: PM2.5, PM10, NO2, O3, CO, dust, pollen, and European/US AQI indices; current conditions, up to 7 forecast days, `past_days`, or a `start_date`/`end_date` archive range; large windows spill to DataCanvas |
| `openmeteo_get_elevation` | Terrain elevation from Copernicus DEM (~90m resolution) for up to 100 coordinate pairs per call |
| `openmeteo_get_ensemble` | Probabilistic ensemble forecast: per-member hourly/daily time series (up to 51 members, 16 days) for exceedance and uncertainty analysis |
| `openmeteo_get_flood` | GloFAS river discharge forecast (up to 210 days) or reanalysis (1984–present); coordinate-based, resolving to the largest river within 5 km; large ranges spill to DataCanvas |
| `openmeteo_get_climate` | Bias-corrected daily CMIP6 climate projections (1950–2050) across up to 7 models; large ranges spill to DataCanvas |
| `openmeteo_dataframe_describe` | List tables and columns on a DataCanvas staged by `openmeteo_get_forecast`, `openmeteo_get_historical`, `openmeteo_get_marine`, `openmeteo_get_air_quality`, `openmeteo_get_ensemble`, `openmeteo_get_flood`, or `openmeteo_get_climate` |
| `openmeteo_dataframe_query` | Run a read-only SQL SELECT against tables staged on a DataCanvas |

## Capability reference

### `openmeteo_search_locations` <sub>tool</sub>

- Returns name, country, admin1/admin2, latitude, longitude, elevation, IANA timezone, population, and GeoNames feature code
- Search by a bare place name — a city, region, or landmark ("Baoding", not "Baoding Hebei"; "Paris", not "Paris, France"); a compound "City Region" or "City, Country" string matches nothing
- Disambiguate same-named places (e.g., "Springfield") with the optional `country` filter (ISO 3166-1 alpha-2) or by raising `count` (default 5, up to 10) and reading `admin1`/`country` on each result
- Pass the timezone from a result directly to weather tools as the `timezone` parameter
- Fails with a `no_results` error (not an empty array) when nothing matches
- When the top match has null or sub-100,000 population, the response carries an advisory `notice` naming that place, its country, and its feature code — historic and colonial exonyms ("Bangalore", "Calcutta") can resolve to an unrelated small feature rather than the modern city

---

### `openmeteo_get_forecast` <sub>tool</sub>

- Up to 16 forecast days (`forecast_days`, default 7) plus optional `past_days` (0–92) for recent history — prefer `past_days` over `openmeteo_get_historical` for the last ~5 days, where the archive's ERA5 components lag
- At least one of `current_variables`, `hourly_variables`, or `daily_variables` is required; `current_variables` alone satisfies it and returns a `current` object plus `current_units` from Open-Meteo's 15-minute current-conditions data
- Hourly and daily are separate variable sets — a variable documented under the other cadence is rejected before the request, naming the field it belongs in and same-cadence alternatives
- Configurable temperature, wind-speed, and precipitation units; reshapes the columnar API response into per-timestamp records with parallel `hourly_units`/`daily_units` maps
- A wide window (large `past_days` plus many hourly variables) spills to DataCanvas when `CANVAS_PROVIDER_TYPE=duckdb` — output carries `canvas_id` and `truncated: true`; an over-wide request Open-Meteo refuses outright fails as `request_too_large`, naming the levers to narrow it

---

### `openmeteo_get_historical` <sub>tool</sub>

- Requires `start_date` and `end_date` (YYYY-MM-DD); archive covers 1940-01-01 to present
- Omitting `models` reads Best Match (blends IFS HRES, ERA5, and ERA5-Land — source varies by date); pass `models` to pin one: `era5`/`era5_land`/`era5_ensemble` update daily with about a 5-day delay, `ecmwf_ifs` has none, `cerra` covers Europe only (elsewhere it fails as a coverage-gap error). Not an allowlist — an unlisted name still goes upstream
- With 2+ models each variable column is suffixed with the model name
- Same variable vocabulary as `openmeteo_get_forecast` for direct past/forecast comparison; at least one of `hourly_variables` or `daily_variables` is required, and the two are separate sets — a wrong-cadence name is rejected before the request
- Large date ranges (multi-year hourly) spill to DataCanvas when `CANVAS_PROVIDER_TYPE=duckdb` — output carries `canvas_id` and `truncated: true`; query via `openmeteo_dataframe_describe` then `openmeteo_dataframe_query`

---

### `openmeteo_get_marine` <sub>tool</sub>

- Up to 8 forecast days (`forecast_days`, upstream default 7) with optional `past_days` (0–92), or an archive range via `start_date`/`end_date` (real wave values go back to at least 2022)
- One window per call — a date range is mutually exclusive with `forecast_days`/`past_days`, and needs both ends (a lone `start_date` or `end_date` is rejected)
- At least one of `hourly_variables` or `daily_variables` is required; the two are separate sets — a wrong-cadence name is rejected before the request
- Inland or sheltered-water points return near-zero wave values (physically correct, not an error); `ocean_current_velocity` is null for non-open-ocean coordinates
- Wide windows spill to DataCanvas when `CANVAS_PROVIDER_TYPE=duckdb` — output carries `canvas_id` and `truncated: true`; query with `openmeteo_dataframe_query`

---

### `openmeteo_get_air_quality` <sub>tool</sub>

- Up to 7 forecast days (`forecast_days`, upstream default 5) with optional `past_days` (0–92), or an archive range via `start_date`/`end_date` — the CAMS global archive begins August 2022; earlier dates return nulls, and `us_aqi` starts a day later than the pollutant series
- One window per call — a date range is mutually exclusive with `forecast_days`/`past_days`, and needs both ends
- At least one of `current_variables` or `hourly_variables` is required; `current_variables` alone answers "right now" (a `current` object plus `current_units`, interval 3600s on this endpoint)
- Grid-modeled CAMS data, coarser than ground stations — cross-reference `openaq-mcp-server` for measured readings; output carries `data_source: "CAMS"` to distinguish the two
- Wide windows spill to DataCanvas when `CANVAS_PROVIDER_TYPE=duckdb` — output carries `canvas_id` and `truncated: true`; query with `openmeteo_dataframe_query`

---

### `openmeteo_get_elevation` <sub>tool</sub>

- Accepts parallel `latitudes[]`/`longitudes[]` arrays of equal length, up to 100 pairs per call
- Returns results in input order: `{ latitude, longitude, elevation_m }` from the Copernicus DEM (~90m resolution)
- Useful for geographic context, elevation-adjusted weather interpretation, or route planning

---

### `openmeteo_get_ensemble` <sub>tool</sub>

- Up to 16 forecast days (`forecast_days`, default 7) with optional `past_days` (0–92); at least one of `hourly_variables` or `daily_variables` is required, and the two are separate sets (though this endpoint's own catalog publishes `temperature_2m_max`/`_min` under both)
- Each requested variable returns as per-member columns (`temperature_2m_member01`, `temperature_2m_member02`, …) across up to 64 members — use the spread for exceedance probabilities and uncertainty ranges
- `models` selects one global or regional ensemble (member counts vary, e.g. `ecmwf_ifs025_ensemble` 51, `gem_global_ensemble` 21); omit for the API default blend. Not an allowlist — an unlisted name still goes upstream
- A regional model queried outside its coverage area fails as a non-retryable input error naming the gap — switch to a global model rather than retrying
- Large multi-member, multi-day pulls spill to DataCanvas when `CANVAS_PROVIDER_TYPE=duckdb` — output carries `canvas_id` and `truncated: true`; query with `openmeteo_dataframe_query`

---

### `openmeteo_get_flood` <sub>tool</sub>

- Coordinate-based — no river ID needed; discharge comes from the largest modeled river within 5 km of the point, which is not always the closest one. Vary the coordinate by about 0.1° and compare when a result looks unrepresentative
- Forecast horizon up to 210 days (`forecast_days`); reanalysis history from 1984-01-01 to present via `start_date`/`end_date`
- One mode per call — `forecast_days` is mutually exclusive with a `start_date`/`end_date` range, and the range needs both ends
- Daily variables: `river_discharge` (ensemble mean), `river_discharge_mean`/`_min`/`_max`/`_median`, `river_discharge_p25`/`_p75` — all in m³/s; returns null for coordinates outside GloFAS coverage
- Wide reanalysis ranges spill to DataCanvas when `CANVAS_PROVIDER_TYPE=duckdb` — output carries `canvas_id` and `truncated: true`; query with `openmeteo_dataframe_query`

---

### `openmeteo_get_climate` <sub>tool</sub>

- Coverage 1950-01-01 to 2050-12-31, daily resolution only — the future-projection counterpart to `openmeteo_get_historical`
- Up to 7 bias-corrected CMIP6 models (e.g. `CMCC_CM2_VHR4`, `MRI_AGCM3_2_S`); not an allowlist — an unlisted name still goes upstream, and a multi-model rejection names only the offending model
- With 2+ models each variable appears once per model, suffixed with the model name; a single or omitted model returns plain variable names
- Not all models carry all variables — missing combinations return null rather than an error
- Multi-decade daily pulls across several models spill to DataCanvas when `CANVAS_PROVIDER_TYPE=duckdb` — output carries `canvas_id` and `truncated: true`; query with `openmeteo_dataframe_query`

---

### `openmeteo_dataframe_describe` <sub>tool</sub>

- Lists tables and columns on a DataCanvas staged by any of the seven spillover tools (`openmeteo_get_forecast`, `_historical`, `_marine`, `_air_quality`, `_ensemble`, `_flood`, `_climate`) — call this first, since table and column names are generated per request
- Fails with `canvas_not_enabled` when `CANVAS_PROVIDER_TYPE` is not `duckdb`, or `canvas_not_found` when `canvas_id` is unknown or past its 24-hour sliding TTL
- Output includes each table's row count, column types, and nullability, plus the canvas's `expires_at`

---

### `openmeteo_dataframe_query` <sub>tool</sub>

- Runs a read-only SQL `SELECT` against tables staged by the seven spillover tools — pass the `canvas_id` and reference the exact `table_name` they return, or discover both via `openmeteo_dataframe_describe`
- Fails with `canvas_not_enabled` when `CANVAS_PROVIDER_TYPE` is not `duckdb`, `canvas_not_found` when `canvas_id` is unknown or past its 24-hour sliding TTL, or `missing_table` when the SQL references a table not staged on the canvas
- System catalogs (`information_schema`, `sqlite_master`, `pg_catalog`, `duckdb_*()` functions) are blocked so callers cannot enumerate other staged canvases — fails as `system_catalog_access`
- Result rows are capped at 100 inline; `row_count` reports the full total — page further results with `LIMIT`/`OFFSET` in the SQL

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Open-Meteo-specific:

- No API key required for non-commercial use — zero-config out of the box; commercial use requires Open-Meteo's paid API tier
- Self-contained geocoding — `openmeteo_search_locations` resolves place names so agents don't need a separate geocoder
- Historical archive from 1940 to present on the same variable schema as the forecast API, with a `models` selector for pinning the reanalysis source
- Automatic columnar-to-record reshape — Open-Meteo's parallel time/variable arrays become per-timestamp records with a `*_units` map
- DataCanvas spillover for all seven forecast/archive tools — an over-budget result stages a DuckDB dataframe for SQL querying; with `CANVAS_PROVIDER_TYPE=none` (the default) those tools return a bounded preview with `truncated: true` instead

Agent-friendly output:

- Location-first workflow — `openmeteo_search_locations` returns the IANA timezone alongside coordinates, ready to pass straight to any weather tool's `timezone` parameter
- Discriminated rejections — an over-wide request fails as `request_too_large` naming the levers to shrink it, distinct from a rate-limit rejection, which is not retried
- Cadence-aware validation — a variable documented under the wrong cadence (hourly vs. daily) is rejected before the upstream call, naming the field it belongs in and same-cadence alternatives
- Notice on silent data changes — an unserved variable name or a snapped-to-grid coordinate surfaces in the response `notice` rather than passing as an unremarked data gap

## Getting started

### Public Hosted Instance

A public instance is available at `https://open-meteo.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "open-meteo-mcp-server": {
      "type": "streamable-http",
      "url": "https://open-meteo.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "open-meteo-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/open-meteo-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "open-meteo-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/open-meteo-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "open-meteo-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/open-meteo-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key required. Non-commercial use is free and keyless.
- Commercial use requires [Open-Meteo's paid API tier](https://open-meteo.com/en/pricing).

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/open-meteo-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd open-meteo-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

## Configuration

All configuration is validated at startup via Zod schemas. No API key is required for non-commercial use — all variables are optional.

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_HOST` | HTTP server host | `127.0.0.1` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path | `/mcp` |
| `MCP_HTTP_MAX_BODY_BYTES` | Maximum HTTP request body bytes; `0` disables the limit. | `1048576` |
| `MCP_PUBLIC_URL` | Public origin for TLS-terminating reverse-proxy deployments | — |
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless`. The server declares `stateless` in code, so it applies when this is unset; set a value to override it. `auto` resolves to `stateful`. | `stateless` |
| `MCP_HTTP_RESUMABILITY` | Replay missed SSE events for stateful HTTP sessions. No effect on stateless mode or protocol revision 2026-07-28. | `true` |
| `MCP_HTTP_RESUMABILITY_MAX_EVENTS` | Events retained per stateful session for replay; oldest evicted first. | `512` |
| `MCP_HTTP_RESUMABILITY_TTL_MS` | How long retained events remain replayable (ms). | `300000` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `notice`, `warning`, `error`) | `info` |
| `MCP_LOG_RATE_LIMIT_THRESHOLD` | Maximum repeated emissions per level and message in each log window; `0` disables suppression. | `10` |
| `MCP_LOG_RATE_LIMIT_WINDOW_MS` | Repeated-log suppression window (ms). | `60000` |
| `MCP_GC_PRESSURE_INTERVAL_MS` | Opt-in forced-GC interval (ms, Bun only). Set to `60000` if heap growth is observed under sustained HTTP traffic. | `0` |
| `LOGS_DIR` | Directory for log files (Node.js only) | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `CANVAS_PROVIDER_TYPE` | Canvas engine for `openmeteo_get_forecast` / `openmeteo_get_historical` / `openmeteo_get_marine` / `openmeteo_get_air_quality` / `openmeteo_get_ensemble` / `openmeteo_get_flood` / `openmeteo_get_climate` spillover: `duckdb` or `none`. At `none` those tools still bound an over-budget response to a preview and set `truncated: true` — there is just no canvas holding the rows they omit | `none` |
| `OPEN_METEO_API_BASE_URL` | Override for the main forecast + elevation API | `https://api.open-meteo.com` |
| `OPEN_METEO_ARCHIVE_BASE_URL` | Override for the historical archive API | `https://archive-api.open-meteo.com` |
| `OPEN_METEO_MARINE_BASE_URL` | Override for the marine forecast API | `https://marine-api.open-meteo.com` |
| `OPEN_METEO_AIR_QUALITY_BASE_URL` | Override for the CAMS air quality API | `https://air-quality-api.open-meteo.com` |
| `OPEN_METEO_GEOCODING_BASE_URL` | Override for the geocoding API | `https://geocoding-api.open-meteo.com` |
| `OPEN_METEO_ENSEMBLE_BASE_URL` | Override for the ensemble forecast API | `https://ensemble-api.open-meteo.com` |
| `OPEN_METEO_FLOOD_BASE_URL` | Override for the GloFAS flood API | `https://flood-api.open-meteo.com` |
| `OPEN_METEO_CLIMATE_BASE_URL` | Override for the CMIP6 climate projections API | `https://climate-api.open-meteo.com` |
| `OTEL_ENABLED` | Enable OpenTelemetry tracing and metrics | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run the production version:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck  # Lint, format, typecheck, security
  bun run test      # Vitest test suite
  ```

### Docker

```sh
docker build -t open-meteo-mcp-server .
docker run --rm -p 3010:3010 open-meteo-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/open-meteo-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools, initializes the Open-Meteo service |
| `src/config` | Server-specific environment variable parsing and validation with Zod |
| `src/mcp-server/tools/definitions` | Tool definitions (`*.tool.ts`) — one file per tool; includes `dataframe-describe.tool.ts` and `dataframe-query.tool.ts` |
| `src/services/open-meteo` | Open-Meteo HTTP client wrapping all nine endpoints with retry, error classification, and columnar reshape |
| `src/services/canvas-accessor.ts` | DataCanvas accessor for `openmeteo_get_forecast` / `openmeteo_get_historical` / `openmeteo_get_marine` / `openmeteo_get_air_quality` / `openmeteo_get_ensemble` / `openmeteo_get_flood` / `openmeteo_get_climate` spillover |
| `tests/` | Unit and integration tests mirroring `src/` |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools in the `tools[]` array in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Attribution

Weather data by [Open-Meteo.com](https://open-meteo.com/), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
