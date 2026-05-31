<div align="center">
  <h1>@cyanheads/open-meteo-mcp-server</h1>
  <p><b>Geocode places, fetch global weather forecasts, ERA5 historical climate, marine conditions, air quality, and terrain elevation via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/open-meteo-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/open-meteo-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/open-meteo-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^5.9.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/open-meteo-mcp-server/releases/latest/download/open-meteo-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=open-meteo-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3Blbi1tZXRlby1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22open-meteo-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fopen-meteo-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://open-meteo.caseyjhand.com/mcp](https://open-meteo.caseyjhand.com/mcp)

</div>

---

## Tools

Six tools covering geocoding, weather forecasts, historical climate, marine conditions, air quality, and terrain elevation — all from Open-Meteo's keyless API:

| Tool | Description |
|:---|:---|
| `openmeteo_geocode` | Resolve a place name to ranked coordinate matches with country, region, elevation, timezone, and population |
| `openmeteo_get_forecast` | Weather forecast for coordinates: hourly and/or daily variables for up to 16 days, with optional recent past data |
| `openmeteo_get_historical` | Historical weather from the ERA5 reanalysis archive (1940–present); large ranges spill to DataCanvas |
| `openmeteo_get_marine` | Marine forecast for coastal or ocean coordinates: wave height, period, direction, swell, and sea-surface temperature |
| `openmeteo_get_air_quality` | Modeled CAMS air quality forecast: PM2.5, PM10, NO2, O3, CO, dust, pollen, and European/US AQI indices |
| `openmeteo_get_elevation` | Terrain elevation from Copernicus DEM (~90m resolution) for up to 100 coordinate pairs per call |

### `openmeteo_geocode`

Resolve a free-text place name to ranked coordinate matches. Required first step for name-based queries — all weather tools accept latitude/longitude, not place names.

- Returns name, country, admin1/admin2, latitude, longitude, elevation, IANA timezone, population, and GeoNames feature code
- Up to 10 ranked matches (default 5), most relevant first — use `count` for disambiguation when common names (e.g., "Springfield") may match multiple cities
- Pass the timezone from a geocode result directly to weather tools as the `timezone` parameter
- Returns an empty `results` array (not an error) when no places match

---

### `openmeteo_get_forecast`

Weather forecast for a coordinate pair with hourly and/or daily variable selection.

- Up to 16 forecast days ahead (`forecast_days 1–16`, default 7)
- `past_days` (0–92) covers recent history via the forecast model — use instead of `openmeteo_get_historical` for dates within the last ~5 days to avoid ERA5 lag
- Common hourly variables: `temperature_2m`, `precipitation`, `wind_speed_10m`, `relative_humidity_2m`, `cloud_cover`, `uv_index`, `apparent_temperature`, `precipitation_probability`, `weather_code`, `surface_pressure`, `visibility`, `wind_direction_10m`, `wind_gusts_10m`, `dew_point_2m`
- Common daily variables: `temperature_2m_max`, `temperature_2m_min`, `precipitation_sum`, `wind_speed_10m_max`, `sunrise`, `sunset`, `uv_index_max`, `precipitation_hours`, `weather_code`
- At least one of `hourly_variables` or `daily_variables` is required
- Configurable temperature unit (Celsius/Fahrenheit), wind speed unit (km/h, mph, m/s, knots), and precipitation unit (mm/inch)
- Reshapes the API's columnar response into per-timestamp records with a parallel `hourly_units` / `daily_units` map

---

### `openmeteo_get_historical`

Historical weather from the ERA5 reanalysis archive, covering 1940 to approximately 5 days ago.

- Requires `start_date` and `end_date` (YYYY-MM-DD); ERA5 has a variable ~1–5 day lag
- Same variable vocabulary as `openmeteo_get_forecast` — past and forecast data are directly comparable on one schema
- At least one of `hourly_variables` or `daily_variables` is required
- Large date ranges (multi-year hourly queries) spill to DataCanvas when `CANVAS_PROVIDER_TYPE=duckdb` — output includes `canvas_id` and `truncated: true` when the inline record limit is exceeded; query the canvas via `secedgar_dataframe_query` or equivalent

---

### `openmeteo_get_marine`

Marine weather forecast for coastal and open-ocean coordinates.

- Up to 7 forecast days (`forecast_days 1–7`, default 7)
- Common hourly variables: `wave_height`, `wave_direction`, `wave_period`, `wind_wave_height`, `wind_wave_direction`, `wind_wave_period`, `swell_wave_height`, `swell_wave_direction`, `swell_wave_period`
- Common daily variables: `wave_height_max`, `wave_direction_dominant`, `wave_period_max`
- At least one of `hourly_variables` or `daily_variables` is required
- Inland or sheltered-water points return near-zero wave values (physically correct); `ocean_current_velocity` is null for non-open-ocean coordinates

---

### `openmeteo_get_air_quality`

Modeled CAMS air quality forecast. Forecast-only — there is no historical archive for CAMS data.

- Up to 7 forecast days (`forecast_days 1–7`, default 5)
- Common variables: `pm2_5`, `pm10`, `carbon_monoxide`, `nitrogen_dioxide`, `sulphur_dioxide`, `ozone`, `dust`, `european_aqi`, `us_aqi`, `alder_pollen`, `birch_pollen`, `grass_pollen`, `mugwort_pollen`, `olive_pollen`, `ragweed_pollen`
- At least one variable from `hourly_variables` is required
- Grid-modeled data from CAMS — resolution is coarser than ground stations; for measured station readings, cross-reference `openaq-mcp-server`
- Output includes `data_source: "CAMS"` to distinguish modeled from measured data

---

### `openmeteo_get_elevation`

Terrain elevation from the Copernicus Digital Elevation Model (~90m resolution).

- Accepts parallel `latitudes[]` and `longitudes[]` arrays; both must have equal length (up to 100 pairs)
- Returns results in input order: `{ latitude, longitude, elevation_m }`
- Useful for geographic context, elevation-adjusted weather interpretation, or route planning

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Open-Meteo–specific:

- No API key required for non-commercial use — zero-config out of the box
- Self-contained geocoding: `openmeteo_geocode` resolves place names so agents don't need a separate geocoder
- ERA5 archive from 1940 to present with same variable schema as the forecast API — direct past/forecast comparisons on one schema
- Automatic columnar-to-record reshape: Open-Meteo returns parallel time/variable arrays; handlers convert to per-timestamp records with a `*_units` map
- DataCanvas spillover for `openmeteo_get_historical`: multi-year hourly queries that exceed the inline limit register a DuckDB dataframe for SQL querying
- Configurable base URLs for all five API endpoints (forecast, archive, marine, air quality, geocoding) — override for testing or self-hosted deployments
- **Attribution:** Weather data by [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0). Non-commercial use is free and keyless; commercial use requires Open-Meteo's paid API tier (~10,000 req/day, 5,000/hour fair-use ceiling for non-commercial)

Agent-friendly output:

- Geocode-first workflow: `openmeteo_geocode` returns the IANA timezone alongside coordinates — pass it directly as `timezone` to any weather tool
- Recovery hints on all error contracts — invalid variable names surface correction guidance with common variable examples
- Coordinate snapping transparency — responses echo the snapped `latitude`/`longitude` (Open-Meteo quantizes to the nearest model grid point) so agents can reason about grid alignment
- `data_source: "CAMS"` label on air quality results distinguishes modeled forecast data from measured station readings

## Getting started

### Public Hosted Instance

A public instance is available at `https://open-meteo.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "open-meteo": {
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
    "open-meteo": {
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
    "open-meteo": {
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
    "open-meteo": {
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

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
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
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path | `/mcp` |
| `MCP_PUBLIC_URL` | Public origin for TLS-terminating reverse-proxy deployments | — |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`) | `info` |
| `MCP_GC_PRESSURE_INTERVAL_MS` | Opt-in forced-GC interval (ms, Bun only). Set to `60000` if heap growth is observed under sustained HTTP traffic. | `0` |
| `LOGS_DIR` | Directory for log files (Node.js only) | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `CANVAS_PROVIDER_TYPE` | Canvas engine for `openmeteo_get_historical` spillover: `duckdb` or `none` | `duckdb` |
| `OPEN_METEO_API_BASE_URL` | Override for the main forecast + elevation API | `https://api.open-meteo.com` |
| `OPEN_METEO_ARCHIVE_BASE_URL` | Override for the ERA5 historical archive API | `https://archive-api.open-meteo.com` |
| `OPEN_METEO_MARINE_BASE_URL` | Override for the marine forecast API | `https://marine-api.open-meteo.com` |
| `OPEN_METEO_AIR_QUALITY_BASE_URL` | Override for the CAMS air quality API | `https://air-quality-api.open-meteo.com` |
| `OPEN_METEO_GEOCODING_BASE_URL` | Override for the geocoding API | `https://geocoding-api.open-meteo.com` |
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
| `src/mcp-server/tools/definitions` | Tool definitions (`*.tool.ts`) — one file per tool |
| `src/services/open-meteo` | Open-Meteo HTTP client wrapping all six endpoints with retry, error classification, and columnar reshape |
| `src/services/canvas-accessor.ts` | DataCanvas accessor for `openmeteo_get_historical` spillover |
| `tests/` | Unit and integration tests mirroring `src/` |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools in the `tools[]` array in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

---

> Weather data by [Open-Meteo.com](https://open-meteo.com/) — licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
