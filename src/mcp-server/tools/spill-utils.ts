/**
 * @fileoverview Shared DataCanvas spill helpers for the spill-capable weather tools
 * (openmeteo_get_forecast, openmeteo_get_historical, openmeteo_get_marine,
 * openmeteo_get_air_quality, openmeteo_get_ensemble, openmeteo_get_flood,
 * openmeteo_get_climate). Owns the one inline ceiling every spill decision is measured
 * against, the accounting that keeps a whole response inside it, the column schema
 * handed to `spillover()`, and the canvas-less fallback those tools take when
 * DataCanvas is disabled.
 * @module mcp-server/tools/spill-utils
 */

import {
  type CanvasInstance,
  type ColumnSchema,
  inferSchemaFromRows,
  type RegisterTableResult,
  spillover,
} from '@cyanheads/mcp-ts-core/canvas';
import type { TimeRecord, UnitsMap } from '@/services/open-meteo/types.js';

/**
 * Ceiling for one complete inline surface, in characters.
 *
 * It bounds the whole response, not its rows: the serialized `structuredContent` and
 * the rendered `content[0].text` are each held to this number, unit maps, scalar
 * metadata, and `format()`'s own header and notice text included. Rows get whatever
 * is left after the rest is accounted for — see {@link inlineBudget}.
 *
 * The two surfaces carry the same data in different currencies, so a row is charged
 * the larger of its two costs (see {@link recordCost}) rather than its JSON length
 * alone. That is what keeps a response honest on `content[]` clients as well as
 * `structuredContent` ones.
 *
 * One documented exception, unchanged from the row-only budget this replaces: a
 * single record wider than the whole budget is still returned, because a response
 * carrying no data at all is worse than one that overshoots (see
 * {@link boundedPreview}).
 */
export const INLINE_CHARS = 80_000;

/**
 * Characters reserved for everything in a response that is neither a preview row nor
 * a unit map: the scalar fields (coordinates, elevation, timezone, `record_count`,
 * `model`/`models`, `member_count`, `date_range`, `canvas_id`, `table_name`,
 * `truncated`), the composed `notice`, and `format()`'s own header lines, spill or
 * no-canvas notice, section headings, and attribution footer.
 *
 * Sized against the widest of those: a climate response echoing seven model names,
 * plus a notice carrying the unit warning, a coverage gap, and the canvas pointer
 * together, plus the longest of the two spill notices ({@link noCanvasNotice}).
 */
const RESPONSE_SCAFFOLD_CHARS = 3_500;

/**
 * Rows a response is guaranteed regardless of how wide its unit maps are, and — by
 * the arithmetic below — the ceiling the unit maps themselves are held to.
 *
 * Only the extreme fan-out shapes come near it: an ensemble request pairing dozens of
 * variables with a 51-member model publishes a unit entry per member per variable, so
 * the maps alone can outweigh the whole budget. Reserving this much for rows means the
 * maps are capped at `INLINE_CHARS - RESPONSE_SCAFFOLD_CHARS - MIN_ROW_CHARS`, and a
 * response that hits the cap says so rather than silently shipping a partial map.
 */
const MIN_ROW_CHARS = 8_000;

/** Ceiling on the combined unit maps — the complement of {@link MIN_ROW_CHARS}. */
const UNITS_CHARS = INLINE_CHARS - RESPONSE_SCAFFOLD_CHARS - MIN_ROW_CHARS;

/**
 * What one record costs against {@link INLINE_CHARS}, on whichever surface renders it
 * larger.
 *
 * `structuredContent` carries the record as JSON inside an array, so it costs
 * `JSON.stringify(record).length` plus the one comma joining it to its neighbour —
 * the row-boundary byte a rows-only budget never counted, and the whole of the
 * overshoot on a several-hundred-row preview.
 *
 * `content[0].text` carries the same record through `formatRecord`, which spends
 * `k: v` and ` | ` per field where JSON spends `"k":v` and `,` — one character more
 * per field, against seven fewer for the timestamp it promotes to a leading label.
 * Charging a full character per field (`time` included) covers that difference for
 * any record and keeps the accounting to two cheap reads.
 */
function recordCost(record: Record<string, unknown>): number {
  return JSON.stringify(record).length + Object.keys(record).length + 1;
}

/** Combined cost of `records`, in the same measure {@link INLINE_CHARS} is expressed in. */
function totalCost(records: readonly Record<string, unknown>[]): number {
  let chars = 0;
  for (const record of records) chars += recordCost(record);
  return chars;
}

/**
 * The unit maps a response can carry inline, the entries that cost it, and the
 * characters its preview rows have left.
 *
 * @typeParam T - The unit-map tuple handed in, preserved position for position.
 */
export interface InlineBudget<T> {
  /**
   * Entries dropped from the maps because they alone would have left no room for
   * rows. `0` for every response that is not an extreme fan-out — the maps are
   * returned untouched, and complete, whenever they fit.
   */
  readonly omittedUnits: number;
  /** Characters left for preview rows once the maps and the scaffold are accounted for. */
  readonly rowBudget: number;
  /** The maps as they can be carried, in the order they were passed. */
  readonly units: T;
}

/** Serialized cost of a unit map, or 0 when absent. */
const unitsCost = (units: UnitsMap | undefined): number =>
  units ? JSON.stringify(units).length : 0;

/**
 * Divide {@link INLINE_CHARS} between a response's unit maps and its preview rows.
 *
 * Call it once per handler with every unit map the response will carry, and use the
 * maps it hands back rather than the ones passed in — they are the same objects
 * unless the cap fired. Both halves of the split have to happen together: a row
 * budget computed from untrimmed maps would promise room the maps then take, and
 * maps trimmed without recomputing the budget would give rows less than they can
 * have.
 *
 * The maps are kept whole whenever they fit, which is every realistic shape — a
 * trimmed map costs the caller the one cheap thing this server can tell them about a
 * staged column that `openmeteo_dataframe_describe` cannot, since units come from the
 * upstream envelope and are never written into the canvas schema. Only when they
 * would leave rows less than {@link MIN_ROW_CHARS} are entries dropped, and
 * {@link unitsTrimmedNotice} states the count and the levers that recover them.
 */
export function inlineBudget<T extends readonly (UnitsMap | undefined)[]>(
  ...unitMaps: T
): InlineBudget<{ [K in keyof T]: UnitsMap | undefined }> {
  const total = unitMaps.reduce<number>((chars, units) => chars + unitsCost(units), 0);
  if (total <= UNITS_CHARS) {
    return {
      units: unitMaps as unknown as { [K in keyof T]: UnitsMap | undefined },
      omittedUnits: 0,
      rowBudget: INLINE_CHARS - RESPONSE_SCAFFOLD_CHARS - total,
    };
  }

  /*
   * Over the cap: fill up to it in the order upstream listed the columns, so the
   * entries that survive are the ones whose columns lead the response, and count what
   * that dropped. Six characters per entry cover the four quotes plus the `:` and `,`
   * JSON spends on it.
   */
  let spent = 2; // the enclosing braces of the first map
  let omitted = 0;
  const trimmed = unitMaps.map((units): UnitsMap | undefined => {
    if (!units) return undefined;
    const kept: UnitsMap = {};
    for (const [name, unit] of Object.entries(units)) {
      const entry = name.length + unit.length + 6;
      if (spent + entry > UNITS_CHARS) {
        omitted += 1;
        continue;
      }
      kept[name] = unit;
      spent += entry;
    }
    return kept;
  });

  return {
    units: trimmed as { [K in keyof T]: UnitsMap | undefined },
    omittedUnits: omitted,
    rowBudget: MIN_ROW_CHARS,
  };
}

/**
 * True when `records` cost more than `budget` — the one call that decides a spill.
 *
 * Spill eligibility is payload size, never row count: a wide result overflows at any
 * count (returning hundreds of KB inline with no retrieval path), while a narrow
 * result over a count gate would burn a per-tenant canvas slot on a response that fits.
 *
 * It is also the sole decision-maker: {@link stageSpill} tells `spillover()` to stage
 * rather than asking it, for the reason recorded there.
 *
 * Short-circuits once the budget is passed, so measuring a huge result costs no more
 * than measuring a borderline one.
 *
 * @param budget - The `rowBudget` from {@link inlineBudget} for this response.
 */
export function exceedsInlineBudget(records: readonly TimeRecord[], budget: number): boolean {
  let chars = 0;
  for (const record of records) {
    chars += recordCost(record);
    if (chars > budget) return true;
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

/**
 * The `previewChars` handed to `spillover()`: the minimum the helper accepts, which
 * makes it stage a table for any non-empty source.
 *
 * The decision was already made by {@link exceedsInlineBudget}, in a currency that
 * covers both inline surfaces; `spillover()` only knows JSON length, so re-asking it
 * reopens the gap between the two. The preview it buffers under this value is empty
 * and unused — every tool selects its own through {@link boundedPreview} or
 * {@link boundedPreviewByCadence}, which is also what gives both cadences and the
 * canvas-less path the same rows.
 */
const SPILL_ALWAYS = 1;

/**
 * Register the complete record set on `canvas` and return the table handle.
 *
 * The one call shape all seven tools make. Callers reach it only after
 * {@link exceedsInlineBudget} ruled the records oversized, so the table is always
 * registered — the inline preview is selected separately and the staged table holds
 * every row, in chronological source order.
 */
export async function stageSpill(
  canvas: CanvasInstance,
  records: readonly TimeRecord[],
  signal?: AbortSignal,
): Promise<RegisterTableResult> {
  const result = await spillover({
    canvas,
    source: records,
    schema: deriveSpillSchema(records),
    previewChars: SPILL_ALWAYS,
    ...(signal !== undefined && { signal }),
  });
  if (!result.spilled) {
    throw new Error(
      'spillover() declined to stage a record set already ruled oversized — previewChars is 1, so this is unreachable for a non-empty source.',
    );
  }
  return result.handle;
}

/** True when a record carries a non-null value in any column other than `time`. */
function hasNonNullValue(record: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'time' && value != null) return true;
  }
  return false;
}

/**
 * Rows that fit `budget`, starting at the first record carrying data.
 * Always at least one row when `records` is non-empty.
 *
 * The canvas-less half of the spill decision, and the canvas half too: both paths take
 * their preview from here, so the same records produce the same rows whether or not
 * DataCanvas is configured. `CANVAS_PROVIDER_TYPE` defaults to `none`, so `getCanvas()`
 * returns undefined on a default deployment and the tools would otherwise fall through
 * an exceeded budget to an unbounded inline return carrying `truncated: false` — the
 * field a client reads to decide whether anything is missing. The only difference
 * between the two paths is that one has a canvas holding the remainder, which
 * {@link canvasPointerNotice} names and {@link noCanvasNotice} explains the absence of.
 *
 * The leading all-null run is skipped because the preview is all the caller sees of
 * the rows themselves. Three real response shapes open with one: an ensemble
 * `past_days` response leads with placeholder rows the models don't hindcast; the
 * forecast API serves fewer past days than `past_days: 92` allows, so the unserved
 * head comes back null; and a GloFAS reanalysis range that starts before the
 * coordinate's record begins is null until it does. A chronological head would spend
 * the whole budget inside that run and return a response with no data at all. When
 * every row is null the head is returned as-is — that is the honest answer, not an
 * empty array.
 *
 * Charges {@link recordCost} per row and stops on the row that would cross the budget,
 * so the rows fit both inline surfaces rather than only the JSON one.
 *
 * @param budget - Character ceiling for the returned rows: the `rowBudget` from
 * {@link inlineBudget}, or the share of it {@link boundedPreviewByCadence} passes when
 * the response carries both cadences.
 */
export function boundedPreview<T extends Record<string, unknown>>(
  records: readonly T[],
  budget: number,
): T[] {
  const firstUseful = records.findIndex(hasNonNullValue);
  const rows: T[] = [];
  let chars = 0;
  for (const row of records.slice(firstUseful < 0 ? 0 : firstUseful)) {
    chars += recordCost(row);
    if (chars > budget && rows.length > 0) break;
    rows.push(row);
  }
  return rows;
}

/**
 * A preview per cadence, the two together fitting `budget`.
 *
 * Every two-cadence tool takes its preview from here, on the canvas branch and the
 * canvas-less one alike. Two shapes it replaces, both of which leave `daily` empty on a
 * wide hourly window: one preview over the concatenated `[...hourly, ...daily]` array —
 * hourly records lead, so the budget is spent before the first daily row — and
 * splitting `spillover()`'s `previewRows` back apart afterwards, which is that same
 * concatenated head one step later. Bounding each cadence separately is what keeps both
 * surfaces populated — and it gives each its own leading-all-null skip (see
 * {@link boundedPreview}) rather than only the hourly head's.
 *
 * It is also the one place the combined row ceiling is set. Calling
 * {@link boundedPreview} once per cadence instead measures each against the whole
 * budget, so a two-cadence response carries roughly twice what a single-cadence one
 * does: the widest ensemble shape — a 64-member model suffixing every variable per
 * member, 193 columns — measured 157,527 characters that way against 78,999 here, and
 * the halved budget still leaves 7 hourly and 6 daily rows rather than starving either.
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
  budget: number,
): { daily: T[]; hourly: T[] } {
  const dailyFloor = totalCost(boundedPreview(daily, budget / 2));
  const hourlyRows = boundedPreview(hourly, budget - dailyFloor);
  const dailyBudget = Math.max(dailyFloor, budget - totalCost(hourlyRows));
  return { hourly: hourlyRows, daily: boundedPreview(daily, dailyBudget) };
}

/**
 * The canvas pointer, for the response payload — names both tools an agent needs to
 * reach the staged rows, `describe` first.
 *
 * `describe` leads because the staged table name is generated (`spilled_<hex>`) and its
 * columns vary per request — per-member `_memberNN` suffixes, per-model suffixes, a
 * union of the hourly and daily column sets — so there is no valid SQL to write until
 * the schema has been read.
 */
export function canvasPointerNotice(rowCount: number, tableName: string, canvasId: string): string {
  return (
    `Staged ${rowCount} rows to table "${tableName}" on canvas ${canvasId} — use ` +
    'openmeteo_dataframe_describe to inspect columns, then openmeteo_dataframe_query to ' +
    'analyze the full set with SQL.'
  );
}

/** The same pointer for `format()`, so `content[]` names both tools too. */
export function canvasPointerLine(canvasId: string, tableName: string): string {
  return (
    `⚠️ Large result — full data staged on canvas \`${canvasId}\`, table \`${tableName}\`. ` +
    'Inspect columns with openmeteo_dataframe_describe, then query with SQL via ' +
    'openmeteo_dataframe_query.'
  );
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

/**
 * Notice for the unit entries {@link inlineBudget} had to drop, or `undefined` when it
 * kept them all — which is every response short of an extreme column fan-out.
 *
 * Units are not recoverable from the canvas: they come from the upstream envelope and
 * are never written into the staged schema, so `openmeteo_dataframe_describe` reports a
 * column's DuckDB type and not its physical unit. Narrowing the request is the way
 * back to a complete map, so the message names the levers that do it.
 *
 * @param narrowing - The tool's own inputs that shrink the column set, e.g.
 * `'fewer hourly_variables, or a models value with fewer members'`.
 */
export function unitsTrimmedNotice(omitted: number, narrowing: string): string | undefined {
  if (omitted === 0) return undefined;
  return (
    `${omitted} unit entries were omitted to keep this response within its inline size ceiling — ` +
    'the units map is incomplete. Units are not staged on the canvas, so re-run with a ' +
    `narrower column set to see them all: ${narrowing}.`
  );
}
