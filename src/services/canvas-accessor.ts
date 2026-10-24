/**
 * @fileoverview DataCanvas accessor for open-meteo-mcp-server.
 * Canvas is a Tier 3 capability, on by default (CANVAS_PROVIDER_TYPE=duckdb).
 * Used by openmeteo_get_forecast, openmeteo_get_historical, openmeteo_get_marine,
 * openmeteo_get_air_quality, openmeteo_get_ensemble, openmeteo_get_flood, and
 * openmeteo_get_climate for large result-set spillover.
 * Returns undefined when canvas is disabled (CANVAS_PROVIDER_TYPE=none) — the
 * spill-capable tools then bound the response themselves (see spill-utils' boundedPreview).
 * @module services/canvas-accessor
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';

let _canvas: DataCanvas | undefined;

export const setCanvas = (c: DataCanvas | undefined): void => {
  _canvas = c;
};

export const getCanvas = (): DataCanvas | undefined => _canvas;
