/**
 * @fileoverview Shared DataCanvas spill helpers for the spill-capable weather tools
 * (openmeteo_get_forecast, openmeteo_get_historical, openmeteo_get_marine,
 * openmeteo_get_air_quality, openmeteo_get_ensemble, openmeteo_get_flood,
 * openmeteo_get_climate). Owns the one inline budget every spill
 * decision is measured against, the column schema handed to `spillover()`, and the
 * canvas-less fallback those tools take when DataCanvas is disabled.
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

/** True when a record carries a non-null value in any column other than `time`. */
function hasNonNullValue(record: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'time' && value != null) return true;
  }
  return false;
}

/**
 * Rows that fit {@link PREVIEW_CHARS}, starting at the first record carrying data.
 * Always at least one row when `records` is non-empty.
 *
 * The canvas-less half of the spill decision. `CANVAS_PROVIDER_TYPE` defaults to
 * `none`, so `getCanvas()` returns undefined on a default deployment and the tools
 * would otherwise fall through an exceeded budget to an unbounded inline return
 * carrying `truncated: false` — the field a client reads to decide whether anything is
 * missing. Bounding here against the same budget `spillover()` drains to keeps the
 * response the same size and `truncated` honest in either configuration; the only
 * difference is that there is no canvas holding the remainder, which
 * {@link noCanvasNotice} states in `format()`.
 *
 * The leading all-null run is skipped because on this path the preview is everything
 * the caller gets. Three real response shapes open with one: an ensemble `past_days`
 * response leads with placeholder rows the models don't hindcast; the forecast API
 * serves fewer past days than `past_days: 92` allows, so the unserved head comes back
 * null; and a GloFAS reanalysis range that starts before the coordinate's record
 * begins is null until it does. A chronological head would spend the whole budget
 * inside that run and return a response with no data at all. When every row is null
 * the head is returned as-is — that is the honest answer, not an empty array.
 *
 * Measures `JSON.stringify(row).length` per row and stops on the row that would cross
 * the budget, matching `spillover()`'s drain exactly.
 *
 * @param budget - Character ceiling for the returned rows. Defaults to the whole
 * {@link PREVIEW_CHARS}; {@link boundedPreviewByCadence} passes a share of it when the
 * response carries both cadences.
 */
export function boundedPreview<T extends Record<string, unknown>>(
  records: readonly T[],
  budget: number = PREVIEW_CHARS,
): T[] {
  const firstUseful = records.findIndex(hasNonNullValue);
  const rows: T[] = [];
  let chars = 0;
  for (const row of records.slice(firstUseful < 0 ? 0 : firstUseful)) {
    chars += JSON.stringify(row).length;
    if (chars > budget && rows.length > 0) break;
    rows.push(row);
  }
  return rows;
}

/** Serialized size of `rows`, in the same measure {@link PREVIEW_CHARS} is expressed in. */
function serializedLength(rows: readonly Record<string, unknown>[]): number {
  let chars = 0;
  for (const row of rows) chars += JSON.stringify(row).length;
  return chars;
}

/**
 * A preview per cadence, the two together fitting {@link PREVIEW_CHARS}.
 *
 * Taking one preview over the concatenated `[...hourly, ...daily]` array and splitting
 * the result afterwards cannot reach the daily rows: hourly records lead, so a wide
 * hourly window spends the whole budget before the first daily row and `daily` comes
 * back empty even though the rows exist upstream. Bounding each cadence separately is
 * what keeps both surfaces populated — and it gives each its own leading-all-null skip
 * (see {@link boundedPreview}) rather than only the hourly head's.
 *
 * How the budget divides: each cadence is guaranteed half, and a cadence that needs
 * less releases the rest to the other. Daily takes its half first, hourly then takes
 * everything daily left, and daily is re-taken against whatever hourly left in turn —
 * floored at its first pass, which is what holds the guarantee when hourly overshoots
 * on a single oversized row. A fixed half each would cut a single-cadence response to
 * half the rows it returns today; a first-come split would starve whichever cadence
 * came second. Daily leads because it is the cheap one — a 92-day marine window serves
 * 2,400 hourly rows against 100 daily, so daily takes about an eighth of the budget and
 * never reaches its half: measured against that response, hourly goes from 343 rows to
 * 301 and daily from 0 to all 100.
 *
 * The pair overshoots by at most one row per cadence, exactly as a single
 * {@link boundedPreview} does: each cadence keeps its first row even when that row alone
 * crosses the budget, so `daily` is non-empty whenever daily records exist.
 */
export function boundedPreviewByCadence<T extends Record<string, unknown>>(
  hourly: readonly T[],
  daily: readonly T[],
): { hourly: T[]; daily: T[] } {
  const dailyFloor = serializedLength(boundedPreview(daily, PREVIEW_CHARS / 2));
  const hourlyRows = boundedPreview(hourly, PREVIEW_CHARS - dailyFloor);
  const dailyBudget = Math.max(dailyFloor, PREVIEW_CHARS - serializedLength(hourlyRows));
  return { hourly: hourlyRows, daily: boundedPreview(daily, dailyBudget) };
}

/**
 * Split concatenated hourly + daily records back into the two cadences.
 *
 * Hourly and daily stage into one union table (one `table_name`, ragged rows padded by
 * the appender), so timestamp shape is the only discriminator: hourly is
 * `YYYY-MM-DDTHH:MM`, daily is `YYYY-MM-DD`. The tools with both cadences apply this to
 * `spillover()`'s preview rows, which arrive concatenated from the staged set — it is
 * the same rule a caller uses against the staged table (`WHERE time LIKE '%T%'`). The
 * canvas-less path never needs it: it still holds the two record arrays separately and
 * bounds each one through {@link boundedPreviewByCadence}.
 */
export function splitByCadence(records: readonly TimeRecord[]): {
  hourly: Record<string, unknown>[];
  daily: Record<string, unknown>[];
} {
  const hourly: Record<string, unknown>[] = [];
  const daily: Record<string, unknown>[] = [];
  for (const record of records) {
    if (typeof record.time !== 'string') continue;
    (record.time.includes('T') ? hourly : daily).push(record);
  }
  return { hourly, daily };
}

/**
 * `format()` notice for a preview bounded by {@link boundedPreview} with no canvas
 * behind it — states why the response carries no `canvas_id`, how the preview was
 * selected, and both ways to reach the rows it omits.
 *
 * @param narrowing - The tool's own inputs that shrink the payload, e.g.
 * `'a shorter start_date–end_date range, or fewer daily_variables'`. Named per tool
 * because the levers differ: only some take `models`, and only some take a date range.
 */
export function noCanvasNotice(narrowing: string): string {
  return (
    '⚠️ Large result — this is a bounded preview, and the remaining rows are not in this response. ' +
    'There is no canvas_id because DataCanvas is disabled on this server (CANVAS_PROVIDER_TYPE=none). ' +
    'The preview starts at the first row carrying data, so any leading all-null rows are omitted. ' +
    `To reach the full dataset, set CANVAS_PROVIDER_TYPE=duckdb and re-run, or narrow the request: ${narrowing}.`
  );
}
