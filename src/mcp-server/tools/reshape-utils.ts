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
 * e.g. `time: iso8601 | temperature_2m: °C | precipitation: mm`
 *
 * Every entry is rendered, `time` included. This is a units *map*, and upstream
 * gives `time` a real unit (`iso8601`) like any other key — dropping it would
 * leave `content[]` carrying less than `structuredContent.*_units`, which keeps
 * the entry. Not to be confused with {@link formatRecord}'s `time` exclusion:
 * that one drops `time` from a data record's per-variable listing because the
 * record's timestamp is already rendered as its leading label.
 */
export function formatUnits(units: UnitsMap | undefined): string {
  if (!units) return '';
  return Object.entries(units)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' | ');
}

/**
 * Format a single per-timestamp record as a markdown line for `format()` output.
 * e.g. `**2024-07-01T00:00** — temperature_2m: 18 | precipitation: 0`
 * Accepts `Record<string, unknown>` to match both narrowed `TimeRecord` values
 * (returned from reshapeColumnar) and the output-schema type in format() callbacks.
 */
export function formatRecord(rec: Record<string, unknown>): string {
  const { time, ...vars } = rec;
  const vals = Object.entries(vars)
    .map(([k, v]) => `${k}: ${v ?? 'null'}`)
    .join(' | ');
  return `**${time}** — ${vals}`;
}
