<div align="center">
  <h1>@cyanheads/open-meteo-mcp-server</h1>
  <p><b>Geocode places, fetch global weather forecasts, historical climate, marine conditions, air quality, and terrain elevation via MCP. STDIO or Streamable HTTP.</b>
  <div>12 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.5.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/open-meteo-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/open-meteo-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/open-meteo-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Global weather from Open-Meteo: forecasts, history back to 1940, marine conditions, air quality, probabilistic ensembles, river discharge, and climate projections. Look up any place by name, pull hourly and daily variables, and run SQL over large results. No API key required.

### Tools

| Tool | Description |
|:---|:---|
| `openmeteo_search_locations` | Resolve a place name to ranked coordinates with country, region, timezone, and population |
| `openmeteo_get_forecast` | Current conditions and hourly/daily forecast up to 16 days, with up to 92 past days, from best match or chosen models side by side |
| `openmeteo_get_historical` | Hourly/daily history from the reanalysis archive, 1940 to present |
| `openmeteo_get_marine` | Wave, swell, and sea-surface conditions: current, up to 8 forecast days, or an archive range, in metric or imperial units |
| `openmeteo_get_air_quality` | Modeled CAMS pollutants, pollen, and AQI: current, up to 7 forecast days, or an archive range |
| `openmeteo_get_elevation` | Copernicus DEM terrain elevation: up to 1,000 coordinate pairs, the first 100 sampled per call with the rest reported for resubmission |
| `openmeteo_get_ensemble` | Per-member ensemble forecast (up to 64 members, up to 35 days) for exceedance and uncertainty |
| `openmeteo_get_flood` | GloFAS river discharge: a ~6-month forecast or a date range from 1984, from seamless or chosen v4 models |
| `openmeteo_get_climate` | Bias-corrected daily CMIP6 projections, 1950–2050, across up to 7 models |
| `openmeteo_dataframe_describe` | List the tables and columns staged on a DataCanvas |
| `openmeteo_dataframe_query` | Run a read-only SQL `SELECT` against staged tables |
| `openmeteo_dataframe_drop` | Remove one staged table or view from a DataCanvas (opt-in) |

The server also publishes an agent skill, `open-meteo-guide` (`skill://open-meteo-guide/SKILL.md`, source in `skills/open-meteo-guide/`): which tool answers which question, plus the gates for exceedance odds, frost, comparisons to a normal, climate shifts, surf spots, river cells, and AQI timing.

## Capability reference

### `openmeteo_search_locations` <sub>tool</sub>

- A bare place `name` ("Paris", not "Paris, France"), with optional `country` (ISO 3166-1 alpha-2) and `language` (default `en`); `count` 1–10, default 5
- Each result carries coordinates, an IANA `timezone`, `country` / `country_code`, `admin1` / `admin2`, `population`, and `feature_code`; no match fails as `no_results`
- A `notice` flags a top match with null or sub-100,000 population, which often means a historic exonym ("Bangalore", "Calcutta")
- A native-script query that misses under `en` is retried once in the language its script implies; `effective_language` names it when the retry succeeds (`上海` → `zh`), and results come back localized

---

### `openmeteo_get_forecast` <sub>tool</sub>

- At least one of `current_variables`, `hourly_variables`, or `daily_variables` (up to 50 each); `forecast_days` 1–16 (default 7), `past_days` 0–92 (default 0)
- Per-timestamp `hourly` / `daily` records with `hourly_units` / `daily_units`; `current_variables` adds a `current` object from 15-minute data (`interval` 900) plus `current_units`
- Omitting `models` reads Open-Meteo `best_match`; `models` compares deterministic models (e.g. `ncep_gfs_seamless`, `ecmwf_ifs025`, `dwd_icon_seamless`; older spellings like `gfs_seamless` still resolve). With 2+ models each hourly and daily column carries a model-name suffix, and `models` is echoed. `current_variables` takes at most one model (`current_multi_model`)
- A regional model with no data at the point is dropped from a multi-model response: the `notice` names it, or, when one model is left with unsuffixed columns, says the values cannot be attributed to a model; when every requested model misses, the call fails as `coverage_gap`
- Prefer `past_days` over `openmeteo_get_historical` for the last week, where the archive's ERA5 components lag

---

### `openmeteo_get_historical` <sub>tool</sub>

- `start_date` and `end_date` required (YYYY-MM-DD, from 1940-01-01), plus at least one of `hourly_variables` / `daily_variables`, named as on the forecast tool
- Omitting `models` reads Best Match (IFS HRES + ERA5 + ERA5-Land, source varies by date); up to 8 `models` pin a source. The ERA5 family runs about a week behind, `ecmwf_ifs` has no delay, and `cerra` covers Europe only
- Output echoes `models` and the returned `date_range`; with 2+ models each column carries a model-name suffix. A model with no data at the point (`cerra` outside Europe) is dropped from a multi-model response; the `notice` names it, or, when one model is left with unsuffixed columns (`era5,cerra`), says the values cannot be attributed to a model

---

### `openmeteo_get_marine` <sub>tool</sub>

- One window per call: `forecast_days` 1–8 (upstream default 7) with `past_days` 0–92, or a `start_date` / `end_date` archive range back to at least 2022. Mixing them fails as `forecast_window_conflict`, a lone date as `date_range_incomplete`
- At least one of `current_variables`, `hourly_variables`, or `daily_variables` (wave height, period, and direction, swell, sea-surface temperature); sheltered water returns near-zero waves, a point well inland returns nulls (named in the `notice`), a land point near the coast is answered from a nearby sea cell with real values and no notice (check the response's `latitude` / `longitude` is the water you meant), and `ocean_current_velocity` is null off the open ocean
- `current_variables` takes the hourly names and adds a `current` object from 15-minute data (`interval` 900) plus `current_units`, alongside either window; a daily name there fails as `variable_wrong_cadence`
- `length_unit` (`metric` / `imperial`) sets every height, `sea_level_height_msl` included, in m or ft; `wind_speed_unit` (`kmh`, `mph`, `ms`, `kn`) sets `ocean_current_velocity`; `temperature_unit` (`celsius` / `fahrenheit`) sets `sea_surface_temperature`. Open-Meteo converts the values, and the `*_units` maps label them (`mph` reads `mp/h`)

---

### `openmeteo_get_air_quality` <sub>tool</sub>

- One window per call: `forecast_days` 1–7 (upstream default 5) with `past_days` 0–92, or a `start_date` / `end_date` archive range from August 2022 (`us_aqi` starts a day later). Same `forecast_window_conflict` and `date_range_incomplete` rejections as the marine tool
- At least one of `current_variables` (a `current` object, `interval` 3600) or `hourly_variables`: PM2.5, PM10, NO2, SO2, O3, CO, dust, pollen, European and US AQI. Pollen is modeled for Europe only, in pollen season; elsewhere it comes back null and the `notice` names it
- `data_source: "CAMS"` marks every response as modeled grid data, not station measurements

---

### `openmeteo_get_elevation` <sub>tool</sub>

- Parallel `latitudes[]` / `longitudes[]` arrays of up to 1,000 pairs; unequal lengths fail as `coordinate_count_mismatch`, compared on the full arrays
- Samples the first 100 pairs (the Elevation API's per-request limit) in one upstream request; `unprocessed_count` says how many were left and `next_offset` is where to resume — resubmit `latitudes.slice(next_offset)` and `longitudes.slice(next_offset)` until `next_offset` is `null`. A call of 100 or fewer returns `0` / `null`. Each sampled pair counts as one call against Open-Meteo's per-IP limits (600 a minute), so a seventh 100-pair slice inside one minute comes back `rate_limited`
- `elevations[]` in input order, each `{ latitude, longitude, elevation_m }` from the Copernicus DEM (~90 m); `elevation_m` is `null` where the DEM has no value (latitude 90), without failing the rest of the call

---

### `openmeteo_get_ensemble` <sub>tool</sub>

- At least one of `hourly_variables` / `daily_variables`; `forecast_days` 1–35 (default 7), `past_days` 0–92. Most models end within 16 days (`ncep_gefs05` runs to about day 34); past that, columns are null and the `notice` says where data ends
- `models` takes one ensemble name (e.g. `ecmwf_ifs025_ensemble`, 51 members; `gem_global_ensemble`, 21); omitted or blank selects `ecmwf_ifs025_ensemble`, echoed in `model`
- Each variable returns per-member columns (`temperature_2m_member01`, …) across up to 64 members; `member_count` excludes the control run. A regional model queried outside its coverage fails as a non-retryable input error; switch to a global model

---

### `openmeteo_get_flood` <sub>tool</sub>

- `daily_variables` required (up to 20), all in m³/s: `river_discharge` plus the statistics `river_discharge_mean` / `_median` / `_min` / `_max` / `_p25` / `_p75`, which carry ensemble spread on forecast-run days and repeat `river_discharge` on reanalysis days
- One mode per call: `forecast_days` 1–210 (the current GloFAS run reaches about six months; later days are null), or a `start_date` / `end_date` range from 1984-01-01. Mixing them fails as `forecast_days_conflict`, a lone date as `date_range_incomplete`
- Omitting `models` reads `seamless_v4`: `consolidated_v4` reanalysis before 2023-08-05, `forecast_v4` runs from then on. `models: ["consolidated_v4"]` reads the reanalysis through 2025-05-31 (null after, and on `forecast_days`); `forecast_v4` starts 2023-06-01. Output echoes `models`; with 2+ models each column carries a model-name suffix, and the `notice` names null spans
- Discharge comes from the GloFAS 0.05° grid cell nearest the coordinate, not reliably the cell on the river you mean; when the value is far below what the river carries, step the coordinate 0.05° across the channel and compare. Null outside GloFAS coverage

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

- `canvas_id` plus a read-only `SELECT` against the staged `table_name`; `rows` holds up to 100 rows, fewer when wide rows would pass the 80,000-character inline ceiling (values are never cut). `row_count` is the exact total; page with `OFFSET <rows.length>` under an `ORDER BY`
- If the count fails or runs past 5 seconds, rows still return, `row_count` is a lower bound, and `count_error` names the reason (e.g. `count_timeout`)
- Fails as `canvas_not_enabled`, `canvas_not_found`, `missing_table`, `system_catalog_access` (system catalogs are blocked), or `row_too_large` (the first row alone exceeds the ceiling: select fewer columns, or shorten values with `left()`, `substr()`, or `list_slice()`)

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
- DataCanvas spillover on the seven weather tools: with `CANVAS_PROVIDER_TYPE=duckdb` (the default) an over-budget result is staged as a DuckDB table (response carries `canvas_id`, `table_name`, `truncated: true`); with `none` it returns a bounded preview and `truncated: true`
- `models` on the forecast, historical, ensemble, climate, and flood tools is not an allowlist, so a model Open-Meteo adds later works without a server update

Agent-friendly output:

- Location-first workflow: `openmeteo_search_locations` returns the IANA `timezone` alongside coordinates, ready for any weather tool's `timezone` input (default `auto`)
- Typed rejections: `variable_wrong_cadence` (names the correct field), `request_too_large` (names the inputs to narrow), `coverage_gap` (a coordinate outside the dataset's grid or the model's domain), and `rate_limited`; only `Too many concurrent requests` is retried first. An outage that outlasts three attempts fails as `upstream_unavailable`, or `upstream_timeout` when the last attempt timed out
- Request URLs never appear in error data or client-visible logs
- One `notice` per response for what the data alone won't show: unserved variable names, nulls outside a dataset's coverage, and where spilled rows went

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http open-meteo-mcp-server https://open-meteo.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add open-meteo-mcp-server -- npx -y @cyanheads/open-meteo-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "open-meteo-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/open-meteo-mcp-server"]
    }
  }
}
```

No API key is required for non-commercial use; commercial use requires [Open-Meteo's paid API tier](https://open-meteo.com/en/pricing). For Docker or a source build, see [Running the server](#running-the-server).

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
| `CANVAS_PROVIDER_TYPE` | `duckdb` stages over-budget weather results on a DataCanvas and enables the dataframe tools; `none` returns a bounded preview. | `duckdb` |
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

Requires [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).

- **Clone and install:**

  ```sh
  git clone https://github.com/cyanheads/open-meteo-mcp-server.git
  cd open-meteo-mcp-server && bun install
  ```

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/open-meteo-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/open-meteo-mcp-server`. To run it over stdio from an MCP client, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/open-meteo-mcp-server:latest"]`. To build locally, `docker build -t open-meteo-mcp-server .`; OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools, initializes the Open-Meteo service and DataCanvas. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/definitions` | Tool definitions (`*.tool.ts`), one file per tool. |
| `src/mcp-server/tools` | Shared tool helpers — model catalog, cadence validation, columnar reshape, spillover, response notices. |
| `src/services/open-meteo` | HTTP client for the Open-Meteo APIs — retry, error classification, coverage-gap rejection. |
| `src/services/canvas-accessor.ts` | DataCanvas accessor shared by the spill-capable tools. |
| `skills/` | Agent skill published over MCP and in the npm package, Docker image, and `.mcpb` bundle (`open-meteo-guide`). |
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
