/**
 * @fileoverview Shared reshape utilities for Open-Meteo columnar API responses.
 * The API returns parallel arrays (time[], variable1[], variable2[], ...).
 * These helpers zip them into per-timestamp records for structured output.
 * @module mcp-server/tools/reshape-utils
 */

import type { ColumnarBlock, TimeRecord, UnitsMap } from '@/services/open-meteo/types.js';

/**
 * Reshape a columnar block (parallel time + variable arrays) into an array of
 * per-timestamp records. Each record contains the `time` field plus one key per
 * variable. Units are returned separately as a map — they do not appear inline.
 */
export function reshapeColumnar(block: ColumnarBlock): TimeRecord[] {
  const { time, ...variables } = block;
  const varEntries = Object.entries(variables);
  return time.map((t, i) => {
    const record: TimeRecord = { time: t };
    for (const [key, values] of varEntries) {
      record[key] = values[i] ?? null;
    }
    return record;
  });
}

/**
 * Format a units map as a human-readable string for `format()` output.
 * e.g. `temperature_2m: °C | precipitation: mm`
 */
export function formatUnits(units: UnitsMap | undefined): string {
  if (!units) return '';
  return Object.entries(units)
    .filter(([k]) => k !== 'time')
    .map(([k, v]) => `${k}: ${v}`)
    .join(' | ');
}
