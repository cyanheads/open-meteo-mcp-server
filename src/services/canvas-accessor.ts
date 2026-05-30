/**
 * @fileoverview DataCanvas accessor for open-meteo-mcp-server.
 * Canvas is an optional Tier 3 capability (requires CANVAS_PROVIDER_TYPE=duckdb).
 * Used by openmeteo_get_historical for large date-range spillover.
 * @module services/canvas-accessor
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';

let _canvas: DataCanvas | undefined;

export const setCanvas = (c: DataCanvas | undefined): void => {
  _canvas = c;
};

export const getCanvas = (): DataCanvas | undefined => _canvas;
