/**
 * @fileoverview Shared DataCanvas spill helpers for the spill-capable weather tools
 * (openmeteo_get_historical, openmeteo_get_ensemble, openmeteo_get_climate). Owns the
 * one inline budget every spill decision is measured against, and the column schema
 * handed to `spillover()`.
 * @module mcp-server/tools/spill-utils
 */

import { type ColumnSchema, inferSchemaFromRows } from '@cyanheads/mcp-ts-core/canvas';
import type { TimeRecord } from '@/services/open-meteo/types.js';

/**
 * Character budget for inline records, and the single threshold that decides a spill.
 * Passed to `spillover()` as `previewChars` so the precheck below and the helper
 * measure the same rows against the same number.
 */
export const PREVIEW_CHARS = 80_000;

/**
 * True when `records` serialize past {@link PREVIEW_CHARS}.
 *
 * Spill eligibility is payload size, never row count. `spillover()` stages a table
 * only once a row pushes its running `JSON.stringify` total past `previewChars`, so
 * measuring that same total here makes the precheck and the helper agree exactly. A
 * row count cannot: a wide result overflows the budget at any count (returning
 * hundreds of KB inline with no retrieval path), while a narrow result over the count
 * would acquire a canvas `spillover()` then declines to use — burning a per-tenant
 * canvas slot the caller never learns about, since `canvas_id` is only surfaced when
 * data actually spills.
 *
 * Short-circuits once the budget is passed, so measuring a huge result costs no more
 * than measuring a borderline one.
 */
export function exceedsInlineBudget(records: readonly TimeRecord[]): boolean {
  let chars = 0;
  for (const record of records) {
    chars += JSON.stringify(record).length;
    if (chars > PREVIEW_CHARS) return true;
  }
  return false;
}

/**
 * Derive the canvas column schema for a spill from the complete staged record set.
 *
 * Handed to `spillover()` so it never falls back to inferring from its own preview
 * buffer, which samples only `previewChars` worth of leading rows. That window is the
 * root of two defects: a long leading run of all-null rows (the placeholder rows an
 * ensemble `past_days` response opens with, which the models don't hindcast) leaves
 * every column with no non-null evidence and types them all VARCHAR; and because
 * hourly records are concatenated ahead of daily ones, a large hourly pull exhausts
 * the window before a daily row is ever sampled, so daily-only columns never enter
 * the schema — and a column absent from the schema is never created on the table.
 *
 * Typing from every observed value — rather than the first non-null one, or an
 * assumption that weather columns are numeric — is what keeps this correct.
 * `precipitation` arrives as `[0, 0.5, 0]`: its leading `0` alone would type the
 * column integer, and the appender coerces to BIGINT through `Math.trunc`, silently
 * flattening every fractional reading to zero. `sunrise`/`sunset` are ISO 8601
 * strings, not numbers. Unioning the observed types per column widens mixed
 * integer/double to DOUBLE and leaves genuine strings VARCHAR.
 *
 * Rows may be ragged: the appender walks the schema's columns and treats a key
 * missing from a row exactly like an explicit null, so one union schema covers
 * concatenated hourly + daily records in a single table. Callers separate the two
 * cadences by timestamp shape — hourly is `YYYY-MM-DDTHH:MM`, daily is `YYYY-MM-DD`.
 *
 * @throws {McpError} ValidationError when `records` is empty — callers only reach a
 * spill once the budget above is exceeded, which implies at least one record.
 */
export function deriveSpillSchema(records: readonly TimeRecord[]): ColumnSchema[] {
  return inferSchemaFromRows(records);
}
