/**
 * @fileoverview One `notice` per response, and the coverage analysis that feeds it.
 *
 * `ctx.enrich.notice()` writes a single `notice` key and is last-write-wins, so the
 * things a weather response can need to say — a requested variable came back with the
 * unit `"undefined"`, a recognized variable has no data at this location or in this
 * window, and the full row set was staged on a canvas — cannot each call it.
 * {@link composeNotice} collects the parts and writes the whole string every time one
 * arrives, so no source silently drops another and no handler has to remember an emit
 * step before each of its return paths.
 *
 * The coverage analysis here — over a series ({@link findCoverageGaps}) or a single
 * `current` instant ({@link findCurrentGaps}) — is the counterpart to two neighbours it
 * is deliberately not:
 *   - `undefinedUnitColumns` in `variable-cadence.ts` catches a name the endpoint
 *     parsed but does not serve, which it reports by setting the unit to the literal
 *     string `"undefined"`. Coverage gaps carry real units (`μg/m³`, `°C`) and only
 *     the values are null, so that check never fires on them — and the columns it
 *     does catch are excluded here rather than reported twice.
 *   - `coverageGapError` in `open-meteo-service.ts` rejects an out-of-domain
 *     *coordinate* for a regional model before a response exists. This runs on a
 *     successful HTTP 200 whose values are null anyway: a requested *time window* that
 *     predates a dataset's archive or exceeds a model's forecast horizon, or a
 *     *location* the dataset carries nothing for — pollen outside Europe, waves at a
 *     land point.
 *
 * It also attributes the columns of a multi-model forecast or archive response to the
 * models that produced them ({@link columnModel}), which is how a model upstream
 * silently dropped ({@link describeDroppedModels}) and a model that does not serve a
 * variable ({@link describeModelUnserved}) get named.
 *
 * @module mcp-server/tools/response-notice
 */

import type { ColumnarBlock, UnitsMap } from '@/services/open-meteo/types.js';

/** The slice of the handler `Context` {@link composeNotice} writes through. */
interface NoticeSink {
  readonly enrich: { notice(text: string): void };
}

/** Collects the parts of a response's single `notice` and keeps it written. */
export interface NoticeComposer {
  /**
   * Append a part and rewrite the whole notice. Ignores `undefined` and blank
   * strings, so a source that has nothing to say can call this unconditionally.
   */
  add(part: string | undefined): void;
}

/**
 * A composer bound to `ctx`. Each {@link NoticeComposer.add} rewrites the full
 * composed string, which is what makes the underlying last-write-wins behaviour
 * correct rather than lossy — the final write always carries every part.
 *
 * Parts are joined with a space into one line: the framework renders `notice` as a
 * single markdown blockquote in `content[]`, prefixing only the first line with `> `,
 * so an embedded newline would drop the rest out of the quote.
 */
export function composeNotice(ctx: NoticeSink): NoticeComposer {
  const parts: string[] = [];
  return {
    add(part) {
      if (!part) return;
      parts.push(part);
      ctx.enrich.notice(parts.join(' '));
    },
  };
}

/** Which side of a response a gap was found on. */
export type CoverageCadence = 'daily' | 'hourly';

/** A set of variables sharing one temporal coverage gap in one cadence. */
export interface CoverageGap {
  readonly cadence: CoverageCadence;
  /** First timestamp carrying data. Absent when the whole window is null. */
  readonly first?: string;
  readonly kind: 'all-null' | 'partial';
  /** Last timestamp carrying data. Absent when the whole window is null. */
  readonly last?: string;
  readonly nullRows: number;
  readonly totalRows: number;
  /** The requested variables affected, in the order upstream listed their columns. */
  readonly variables: readonly string[];
}

/** Names listed per gap before the rest are counted — enough to act on, short enough to read. */
const MAX_NAMED = 4;

/**
 * Collapse the per-member and per-model column fan-outs back to the variable a caller
 * asked for. Without it a 51-member ensemble reports one gap per member per variable.
 */
export type ColumnGrouping = (column: string) => string;

/** Strips the ensemble endpoint's `_memberNN` suffix. */
export const byEnsembleVariable: ColumnGrouping = (column) => column.replace(/_member\d+$/, '');

/**
 * Coverage gaps among the recognized variables of one columnar block.
 *
 * A gap is a variable whose values are null where the response has rows, with a real
 * unit — the shape Open-Meteo returns for a window or location outside a dataset's
 * coverage: an archive range before the product's first data, a forecast horizon past
 * what the selected model runs, or a point the dataset carries nothing for (pollen
 * outside Europe, waves at a land point). Columns upstream marked with the unit
 * `"undefined"` are skipped; those are unserved names, already named by their own notice.
 *
 * Columns are grouped by `grouping` and a group is judged on its combined values, so a
 * variable is reported once however many members or models carry it, and is reported
 * only when no member carries data for that row.
 *
 * Groups sharing an identical gap are merged into one entry, which is what keeps the
 * message short: the common case is every requested variable running out at the same
 * timestamp because the model's horizon, not the variable, is what ended.
 */
export function findCoverageGaps(
  cadence: CoverageCadence,
  block: ColumnarBlock | undefined,
  units: UnitsMap | undefined,
  grouping: ColumnGrouping = (column) => column,
): CoverageGap[] {
  const times = block?.time;
  if (!block || !times || times.length === 0) return [];

  const groups = new Map<string, (number | string | null)[][]>();
  for (const [column, values] of Object.entries(block)) {
    if (column === 'time' || units?.[column] === 'undefined') continue;
    const name = grouping(column);
    const existing = groups.get(name);
    if (existing) existing.push(values);
    else groups.set(name, [values]);
  }

  /** Gaps keyed by shape, so variables that ran out together are named together. */
  const merged = new Map<string, { first?: string; last?: string; nullRows: number }>();
  const named = new Map<string, string[]>();
  for (const [name, columns] of groups) {
    let first: string | undefined;
    let last: string | undefined;
    let nullRows = 0;
    for (const [row, time] of times.entries()) {
      if (columns.some((values) => values[row] != null)) {
        first ??= time;
        last = time;
      } else {
        nullRows += 1;
      }
    }
    if (nullRows === 0) continue;

    const key = `${first ?? ''}|${last ?? ''}|${nullRows}`;
    merged.set(key, {
      ...(first !== undefined && { first }),
      ...(last !== undefined && { last }),
      nullRows,
    });
    named.set(key, [...(named.get(key) ?? []), name]);
  }

  return [...merged].map(([key, shape]) => ({
    cadence,
    kind: shape.first === undefined ? ('all-null' as const) : ('partial' as const),
    ...shape,
    totalRows: times.length,
    variables: named.get(key) ?? [],
  }));
}

/**
 * Null rows a `partial` gap needs before it earns a sentence.
 *
 * Every sentence in the composed notice reads with the same weight, so a single stray
 * null — a climate pull whose final projected day is empty, 1 row of 36,890 — arrived
 * looking exactly as consequential as a model running out of forecast horizon. Six is
 * the smallest gap observed live that a caller can act on: `ncep_gefs025` over a
 * sixteen-day window serves ten days and returns six null daily rows, and narrowing
 * `forecast_days` or switching models is a real response to that. Anything shorter is
 * noise in the data, not a coverage boundary.
 *
 * Applied to the message only — {@link findCoverageGaps} still detects, merges, and
 * returns the gap, so the analysis stays complete for any other reader.
 */
const MIN_REPORTED_NULL_ROWS = 6;

/**
 * True when a gap is too small to be worth a sentence. `all-null` never qualifies,
 * whatever its row count: absent data is the answer to the request, not a gap in it.
 */
function isNegligible(gap: CoverageGap): boolean {
  return gap.kind === 'partial' && gap.nullRows < MIN_REPORTED_NULL_ROWS;
}

/** `a, b, c, and 5 more`, capped at {@link MAX_NAMED} names. */
function nameList(variables: readonly string[]): string {
  if (variables.length <= MAX_NAMED) return variables.join(', ');
  return `${variables.slice(0, MAX_NAMED).join(', ')}, and ${variables.length - MAX_NAMED} more`;
}

/**
 * The surfaced message: one sentence per gap worth reporting, naming the affected
 * variables and either that the whole window is empty or where the data actually starts
 * and stops. A partial gap under {@link MIN_REPORTED_NULL_ROWS} is left out, so a stray
 * null does not read like a coverage boundary.
 *
 * `record_count` is deliberately untouched by any of this — it reports rows, and the
 * rows are real. What the caller cannot see without this sentence is that the values
 * in them are not.
 *
 * Returns `undefined` when there is nothing to report, so it composes straight into
 * {@link NoticeComposer.add}.
 */
export function describeCoverageGaps(...gaps: readonly CoverageGap[][]): string | undefined {
  const sentences = gaps
    .flat()
    .filter((gap) => !isNegligible(gap))
    .map((gap) =>
      gap.kind === 'all-null'
        ? `No ${gap.cadence} data for ${nameList(gap.variables)} anywhere in the requested window — ` +
          `all ${gap.totalRows} values are null even though the units are real, so this location or ` +
          'the requested window falls outside this dataset’s coverage rather than the names being unserved.'
        : `Partial ${gap.cadence} coverage for ${nameList(gap.variables)}: data runs ${gap.first} to ` +
          `${gap.last}, and ${gap.nullRows} of ${gap.totalRows} rows are null.`,
    );
  return sentences.length > 0 ? sentences.join(' ') : undefined;
}

/**
 * The requested `current` variables that came back `null` under a real unit — the
 * single-instant counterpart to {@link findCoverageGaps}. `time` and `interval` are
 * metadata rather than requested variables, and a key whose unit is `"undefined"` is an
 * unserved name already reported by its own notice, so all three are skipped.
 */
export function findCurrentGaps(
  current: Record<string, unknown> | undefined,
  units: UnitsMap | undefined,
): string[] {
  if (!current) return [];
  return Object.entries(current)
    .filter(
      ([key, value]) =>
        key !== 'time' && key !== 'interval' && units?.[key] !== 'undefined' && value === null,
    )
    .map(([key]) => key);
}

/**
 * One sentence naming the {@link findCurrentGaps} variables, or `undefined` when there
 * are none, so it composes straight into {@link NoticeComposer.add}. The unit is real,
 * so the name is served — what is missing is coverage at this location and time (pollen
 * outside Europe, say), and the null is the answer rather than a zero.
 */
export function describeCurrentGaps(variables: readonly string[]): string | undefined {
  if (variables.length === 0) return;
  const [value, unit, it, name] =
    variables.length === 1
      ? ['value is', 'unit is', 'it has', 'name']
      : ['values are', 'units are', 'they have', 'names'];
  return (
    `No current value for ${nameList(variables)} — the ${value} null even though the ${unit} ` +
    `real, so ${it} no coverage at this location and time rather than the ${name} being unserved.`
  );
}

/** What a multi-model request asked for: the models, and the variables they fan out over. */
export interface ModelSelection {
  /** The requested models, as sent; `undefined` when the caller selected none. */
  readonly models: readonly string[] | undefined;
  /** Every requested hourly and daily variable name. */
  readonly variables: readonly string[];
}

/**
 * The requested model a column belongs to. With 2+ models the forecast and archive
 * endpoints name every hourly and daily column `<variable>_<model>`, so a column is
 * attributed only when it spells exactly one requested variable–model pair — a bare
 * suffix match would give `temperature_2m_gfs_seamless` to a requested `seamless` too.
 * `undefined` for a bare column, an unrecognized one, or a selection of fewer than two
 * models (whose columns carry plain names).
 */
export function columnModel(column: string, selection: ModelSelection): string | undefined {
  const { models, variables } = selection;
  if (!models || models.length < 2) return;
  return models.find((model) => {
    const suffix = `_${model}`;
    return column.endsWith(suffix) && variables.includes(column.slice(0, -suffix.length));
  });
}

/**
 * A notice for the models a 2+-model response silently left out, or `undefined` when
 * every requested model is accounted for.
 *
 * Open-Meteo answers a multi-model request in which some models have no data at the
 * coordinate (a regional model outside its domain) with HTTP 200 and those models
 * dropped — no error, no field naming them. Only when every model misses does it reject
 * the request, which the service raises as a coverage gap. Two shapes follow:
 *   - Suffixed columns remain for the models that served the point: name each requested
 *     model with no `<variable>_<model>` column, and the ones the response does compare.
 *   - One model remains, and its columns come back with plain names: which model that is
 *     cannot be read off the response (the snapped grid coordinates are the only hint,
 *     and too fragile to attribute by), so say the values are unattributable and name
 *     the candidates rather than guess.
 *
 * Reads the column names of the hourly and daily `blocks`; `current` is a single
 * unsuffixed block by design and is not passed.
 */
export function describeDroppedModels(
  selection: ModelSelection,
  ...blocks: (ColumnarBlock | undefined)[]
): string | undefined {
  const models = [...new Set(selection.models)];
  if (models.length < 2) return;

  const columns = blocks.flatMap((block) => Object.keys(block ?? {}));
  const served = new Set(columns.map((column) => columnModel(column, selection)));
  const present = models.filter((model) => served.has(model));
  const missing = models.filter((model) => !served.has(model));
  const bare = columns.filter((column) => selection.variables.includes(column));

  if (bare.length > 0) {
    return `${nameList(bare)} came back without a model suffix although ${models.length} models were requested (${models.join(', ')}) — Open-Meteo leaves out a requested model that has no data at this coordinate (typically a regional model outside its domain), and the columns of the one left carry plain names, so these values are unattributable: they come from one of ${missing.join(', ')}, and the response does not say which. Request one model at a time to attribute them.`;
  }
  if (missing.length === 0 || present.length === 0) return;
  return `Open-Meteo returned no columns for ${missing.join(', ')} — it leaves a requested model out of the response when it has no data at this coordinate (typically a regional model outside its domain), so this response compares only ${present.join(', ')}.`;
}

/**
 * A notice for the model-suffixed columns among `columns` (those upstream reported with
 * the unit `"undefined"`), or `undefined` when none is attributable to a model.
 *
 * On a plain column that unit means the endpoint does not serve the name in the cadence
 * it was requested under; on a `<variable>_<model>` column it means that model does not
 * serve the variable at all — `lightning_potential_gfs_hrrr` beside a real-unit
 * `lightning_potential_icon_seamless` — so the cadence advice would point the caller at
 * the wrong input. The caller keeps reporting the unattributed columns its own way.
 */
export function describeModelUnserved(
  columns: readonly string[],
  selection: ModelSelection,
): string | undefined {
  const byModel = new Map<string, string[]>();
  const attributed: string[] = [];
  for (const column of columns) {
    const model = columnModel(column, selection);
    if (model === undefined) continue;
    attributed.push(column);
    byModel.set(model, [...(byModel.get(model) ?? []), column.slice(0, -(model.length + 1))]);
  }
  if (attributed.length === 0) return;
  const pairs = [...byModel].map(
    ([model, variables]) => `${model} does not serve ${nameList(variables)}`,
  );
  const remedy =
    new Set([...byModel.values()].flat()).size === 1
      ? 'Read it from a model that serves it.'
      : 'Read those variables from a model that serves them.';
  return `${nameList(attributed)} returned no data — Open-Meteo reported the unit as "undefined", which on a model-suffixed column means that model does not serve the variable: ${pairs.join('; ')}. ${remedy}`;
}

/**
 * The notice for every column upstream reported with the unit `"undefined"` on a tool
 * that takes `models`: the model-suffixed ones through {@link describeModelUnserved}, the
 * rest as a name the endpoint does not serve in the cadence it was requested under — plus
 * the selected model, when exactly one was sent, as the other thing that can leave a
 * column empty. `undefined` when `columns` is empty.
 *
 * @param wording.server - What serves the data, in the sentence: `the endpoint`, `the archive`.
 * @param wording.fields - The input fields a misplaced name may belong in, e.g.
 * `hourly_variables or daily_variables`.
 */
export function describeUnservedColumns(
  columns: readonly string[],
  selection: ModelSelection,
  wording: { readonly fields: string; readonly server: string },
): string | undefined {
  const unattributed = columns.filter((column) => !columnModel(column, selection));
  const [onlyModel, ...others] = selection.models ?? [];
  const modelClause =
    onlyModel !== undefined && others.length === 0
      ? `, or the selected model (${onlyModel}) does not serve it`
      : '';
  const cadenceSentence =
    unattributed.length > 0
      ? `${unattributed.join(', ')} returned no data — Open-Meteo reported the unit as "undefined", which means ${wording.server} does not serve that name in the cadence it was requested under${modelClause}. Check the spelling, and whether it belongs in ${wording.fields}.`
      : undefined;
  return (
    [describeModelUnserved(columns, selection), cadenceSentence].filter(Boolean).join(' ') ||
    undefined
  );
}
