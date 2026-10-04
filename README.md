<div align="center">
  <h1>@cyanheads/open-meteo-mcp-server</h1>
  <p><b>Geocode places, fetch global weather forecasts, historical climate, marine conditions, air quality, and terrain elevation via MCP. STDIO or Streamable HTTP.</b>
  <div>12 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/open-meteo-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/open-meteo-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/open-meteo-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Global weather from Open-Meteo: forecasts, the historical archive, marine conditions, air quality, probabilistic ensembles, river discharge, and CMIP6 climate projections. Geocode a place name, pull hourly and daily variables for its coordinates, and run SQL over large results staged to DataCanvas. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `openmeteo_search_locations` | Resolve a place name to ranked coordinates with country, region, timezone, and population |
| `openmeteo_get_forecast` | Current conditions and hourly/daily forecast up to 16 days, with up to 92 past days |
| `openmeteo_get_historical` | Hourly/daily history from the reanalysis archive, 1940 to present |
| `openmeteo_get_marine` | Wave, swell, and sea-surface conditions: up to 8 forecast days or an archive range |
| `openmeteo_get_air_quality` | Modeled CAMS pollutants, pollen, and AQI: current, up to 7 forecast days, or an archive range |
| `openmeteo_get_elevation` | Copernicus DEM terrain elevation for up to 100 coordinate pairs |
| `openmeteo_get_ensemble` | Per-member ensemble forecast (up to 64 members, 16 days) for exceedance and uncertainty |
| `openmeteo_get_flood` | GloFAS river discharge forecast (up to 210 days) or reanalysis from 1984 |
| `openmeteo_get_climate` | Bias-corrected daily CMIP6 projections, 1950–2050, across up to 7 models |
| `openmeteo_dataframe_describe` | List the tables and columns staged on a DataCanvas |
| `openmeteo_dataframe_query` | Run a read-only SQL `SELECT` against staged tables |
| `openmeteo_dataframe_drop` | Remove one staged table or view from a DataCanvas (opt-in) |

## Capability reference

### `openmeteo_search_locations` <sub>tool</sub>

- A bare place `name` ("Paris", not "Paris, France"), with optional `country` (ISO 3166-1 alpha-2) and `language` (default `en`); `count` 1–10, default 5
- Each result carries coordinates, an IANA `timezone`, `country` / `country_code`, `admin1` / `admin2`, `population`, and `feature_code`; no match fails as `no_results`
- A `notice` flags a top match with null or sub-100,000 population, which is what a historic exonym ("Bangalore", "Calcutta") often resolves to

---

### `openmeteo_get_forecast` <sub>tool</sub>

- At least one of `current_variables`, `hourly_variables`, or `daily_variables` (up to 50 each); `forecast_days` 1–16 (default 7), `past_days` 0–92 (default 0)
- Per-timestamp `hourly` / `daily` records with `hourly_units` / `daily_units`; `current_variables` adds a `current` object from 15-minute data (`interval` 900) plus `current_units`
- Prefer `past_days` over `openmeteo_get_historical` for the last ~5 days, where the archive's ERA5 components lag

---

### `openmeteo_get_historical` <sub>tool</sub>

- `start_date` and `end_date` required (YYYY-MM-DD, from 1940-01-01), plus at least one of `hourly_variables` / `daily_variables`, named as on the forecast tool
- Omitting `models` reads Best Match (IFS HRES + ERA5 + ERA5-Land, source varies by date); up to 8 `models` pin a source. The ERA5 family runs ~5 days behind, `ecmwf_ifs` has no delay, and `cerra` covers Europe only
- Output echoes `models` and the returned `date_range`; with 2+ models each column carries a model-name suffix

---

### `openmeteo_get_marine` <sub>tool</sub>

- One window per call: `forecast_days` 1–8 (upstream default 7) with `past_days` 0–92, or a `start_date` / `end_date` archive range back to at least 2022. Mixing them fails as `forecast_window_conflict`, a lone date as `date_range_incomplete`
- At least one of `hourly_variables` / `daily_variables` (wave height, period, and direction, swell, sea-surface temperature); sheltered or inland points return near-zero waves, and `ocean_current_velocity` is null off the open ocean

---

### `openmeteo_get_air_quality` <sub>tool</sub>

- One window per call: `forecast_days` 1–7 (upstream default 5) with `past_days` 0–92, or a `start_date` / `end_date` archive range from August 2022 (`us_aqi` starts a day later). Same `forecast_window_conflict` and `date_range_incomplete` rejections as the marine tool
- At least one of `current_variables` (a `current` object, `interval` 3600) or `hourly_variables`: PM2.5, PM10, NO2, SO2, O3, CO, dust, pollen, European and US AQI
- `data_source: "CAMS"` marks every response as modeled grid data, not station measurements

---

### `openmeteo_get_elevation` <sub>tool</sub>

- Parallel `latitudes[]` / `longitudes[]` arrays of up to 100 pairs; unequal lengths fail as `coordinate_count_mismatch`
- `elevations[]` in input order, each `{ latitude, longitude, elevation_m }` from the Copernicus DEM (~90 m)

---

### `openmeteo_get_ensemble` <sub>tool</sub>

- At least one of `hourly_variables` / `daily_variables`; `forecast_days` 1–16 (default 7), `past_days` 0–92. `models` takes one ensemble name (e.g. `ecmwf_ifs025_ensemble`, 51 members; `gem_global_ensemble`, 21), or is omitted for the API default blend
- Each variable returns as per-member columns (`temperature_2m_member01`, …) across up to 64 members; `member_count` counts the perturbed members, not the control run
- A regional model queried outside its coverage fails as a non-retryable input error naming the gap; switch to a global model

---

### `openmeteo_get_flood` <sub>tool</sub>

- `daily_variables` required (up to 20): `river_discharge` (ensemble mean), `river_discharge_mean` / `_min` / `_max` / `_median` / `_p25` / `_p75`, all in m³/s
- One mode per call: `forecast_days` 1–210, or a `start_date` / `end_date` reanalysis range from 1984-01-01. Mixing them fails as `forecast_days_conflict`, a lone date as `date_range_incomplete`
- Discharge comes from the largest modeled river within 5 km, not always the closest; vary the coordinate by ~0.1° when a value looks off. Null outside GloFAS coverage

---

### `openmeteo_get_climate` <sub>tool</sub>

- `start_date` / `end_date` within 1950-01-01 to 2050-12-31 and `daily_variables` required (the API is daily-only); up to 7 CMIP6 `models`, e.g. `CMCC_CM2_VHR4`, `MRI_AGCM3_2_S`
- With 2+ models each variable is suffixed with the model name; a single or omitted model returns plain names. A variable a model doesn't carry comes back null

---

### `openmeteo_dataframe_describe` <sub>tool</sub>

- Takes the `canvas_id` a spilled weather tool returned; lists each table's `name`, `kind`, `row_count`, and columns (name, type, nullability), plus the canvas `expires_at`
- Fails as `canvas_not_enabled` when canvas is off, or `canvas_not_found` when the ID is unknown or past its 24-hour sliding TTL

---

### `openmeteo_dataframe_query` <sub>tool</sub>

- `canvas_id` plus a read-only `SELECT` against the staged `table_name`; `rows` is capped at 100 inline and `row_count` gives the full total, so page with `LIMIT` / `OFFSET`
- Fails as `canvas_not_enabled`, `canvas_not_found`, `missing_table`, or `system_catalog_access` (system catalogs are blocked)

---

### `openmeteo_dataframe_drop` <sub>tool</sub>

- Off by default: listed as disabled until `OPENMETEO_DATAFRAME_DROP_ENABLED=true`
- `canvas_id` plus the exact `table_name` from `openmeteo_dataframe_describe`; removes that one table or view and returns `dropped` and the `remaining_tables`. A name that is not staged returns `dropped: false`, so a repeated drop is safe
- Fails as `canvas_not_enabled`, `canvas_not_found`, or `invalid_table_name` (not a plain SQL identifier, or a reserved keyword)

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Open-Meteo-specific:

- No API key for non-commercial use; commercial use requires Open-Meteo's paid API tier
- Columnar API responses reshaped into per-timestamp records with `*_units` maps, on the same variable names across forecast and archive
- DataCanvas spillover on the seven weather tools (forecast, historical, marine, air quality, ensemble, flood, climate): with `CANVAS_PROVIDER_TYPE=duckdb` an over-budget result is staged as a DuckDB table and the response carries `canvas_id`, `table_name`, and `truncated: true`; with the default `none` it returns a bounded preview and `truncated: true`
- `models` on the historical, ensemble, and climate tools is not an allowlist, so a model Open-Meteo adds later works without a server update

Agent-friendly output:

- Location-first workflow: `openmeteo_search_locations` returns the IANA `timezone` alongside coordinates, ready for any weather tool's `timezone` input (default `auto`)
- Typed rejections: a variable passed under the wrong cadence fails as `variable_wrong_cadence` before the upstream call, naming the field it belongs in; an over-wide request fails as `request_too_large`, naming the inputs to narrow; rate-limit rejections are not retried
- One `notice` per response for what the data alone won't show: variable names the endpoint doesn't serve, requested windows outside a dataset's coverage, and where spilled rows went

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

Every variable is optional.

| Variable | Description | Default |
|:---|:---|:---|
| `OPEN_METEO_API_BASE_URL` | Forecast and elevation API base URL. | `https://api.open-meteo.com` |
| `OPEN_METEO_ARCHIVE_BASE_URL` | Historical archive API base URL. | `https://archive-api.open-meteo.com` |
| `OPEN_METEO_MARINE_BASE_URL` | Marine API base URL. | `https://marine-api.open-meteo.com` |
| `OPEN_METEO_AIR_QUALITY_BASE_URL` | CAMS air quality API base URL. | `https://air-quality-api.open-meteo.com` |
| `OPEN_METEO_GEOCODING_BASE_URL` | Geocoding API base URL. | `https://geocoding-api.open-meteo.com` |
| `OPEN_METEO_ENSEMBLE_BASE_URL` | Ensemble API base URL. | `https://ensemble-api.open-meteo.com` |
| `OPEN_METEO_FLOOD_BASE_URL` | GloFAS flood API base URL. | `https://flood-api.open-meteo.com` |
| `OPEN_METEO_CLIMATE_BASE_URL` | CMIP6 climate API base URL. | `https://climate-api.open-meteo.com` |
| `CANVAS_PROVIDER_TYPE` | `duckdb` stages over-budget weather results on a DataCanvas and enables the dataframe tools; `none` returns a bounded preview. | `none` |
| `OPENMETEO_DATAFRAME_DROP_ENABLED` | `true` makes `openmeteo_dataframe_drop` callable; otherwise it is listed as disabled. | `false` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `notice`, `warning`, `error`). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

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
| `src/index.ts` | `createApp()` entry point — registers tools, initializes the Open-Meteo service and DataCanvas. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/definitions` | Tool definitions (`*.tool.ts`), one file per tool. |
| `src/mcp-server/tools` | Shared tool helpers — model catalog, cadence validation, columnar reshape, spillover, response notices. |
| `src/services/open-meteo` | HTTP client for the Open-Meteo APIs — retry, error classification, coverage-gap rejection. |
| `src/services/canvas-accessor.ts` | DataCanvas accessor shared by the spill-capable tools. |
| `tests/` | Unit, integration, fuzz, and smoke tests. |

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
