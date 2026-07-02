# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-07-02 · 🛡️ Security

openmeteo_geocode tolerates sparse results and retries native-script queries; openmeteo_get_ensemble populates model/member_count; mcp-ts-core ^0.10.10 clears the transitive js-yaml advisory

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-06-20

mcp-ts-core ^0.10.9 maintenance — check-dependency-specifiers + plugin-manifest devcheck gates, ctx.content and invalid_sql skill sync, dependency refresh

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-06-12 · 🛡️ Security

mcp-ts-core ^0.10.6 adoption, dataframe_query system-catalog deny, Docker healthcheck + bundle cleaner

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-04

Ensemble forecast + GloFAS flood tools (openmeteo_get_ensemble, openmeteo_get_flood)

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-02

Adopt @cyanheads/mcp-ts-core 0.9.21 — per-request log context fix, secret-stripping in fetchWithTimeout, fail-fast withRetry; client config key renamed to package name; new scripts and skills.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-31

DataCanvas integration for openmeteo_get_historical: dataframe_query + dataframe_describe complete the historical spillover (#1)

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-30

Public hosted endpoint at https://open-meteo.caseyjhand.com/mcp

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-30

Initial release — 6 tools for global keyless weather via Open-Meteo: geocoding, forecast (≤16d), ERA5 archive (1940–present), marine, air quality, and elevation.
