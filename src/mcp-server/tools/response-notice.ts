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
 * It also attributes the columns of a multi-model forecast, archive, climate, or marine response
 * — and of an ensemble one, whose member columns {@link byEnsembleVariable} groups under their model —
 * to the models that produced them ({@link columnModel}), which is how a model upstream
 * silently dropped ({@link describeDroppedModels}), a model that does not serve a
 * variable ({@link describeModelUnserved}), and a model that returned nothing for a
 * variable another selected model served ({@link findCoverageGaps}) get named.
 *
 * {@link renderNotice} is how the composed notice reaches `content[]`: every weather tool
 * and `openmeteo_search_locations` set it as their `enrichmentTrailer.notice.render`.
 *
 * @module mcp-server/tools/response-notice
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
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
 * Parts are joined with a space into one line, so the notice reads as one paragraph on
 * both surfaces.
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

/**
 * The `content[]` trailer line for a notice: a block quote, every line of it quoted,
 * whose text a CommonMark parse reads back as exactly `notice`.
 *
 * The framework's default notice line quotes the text as live Markdown, so a generated
 * canvas ID such as `_a4RmGLw5_` or a caller-typed name such as `*x*` would read as
 * emphasis. The escaping happens here, on the rendered line only: `structuredContent`
 * keeps the notice exactly as {@link composeNotice} wrote it.
 */
export function renderNotice(notice: string): string {
  return escapeMarkdownInline(notice)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/** Which side of a response a gap was found on. */
export type CoverageCadence = 'daily' | 'hourly';

/**
 * Whose an `all-null` gap is, on a request that selected `models`.
 *   - `model`: another requested model returned values for the same variables in this
 *     cadence, so the variables are servable at this point and in this window and the
 *     gap is `model`'s — whether it lacks them or its record does not reach the window,
 *     the remedy is the same: read them from `servedBy`.
 *   - `undetermined`: no requested model returned them. Nothing in the response
 *     separates a model that does not carry them from a location or window outside the
 *     data's coverage, so `models` are named beside the location and the window.
 *     `defaultRequested` is set when the tool's default model was among the requested
 *     ones: it returned no values for them either, so omitting `models` cannot help.
 *     `everyModelRequested` is set when the request named every model of a tool whose
 *     model set is closed, so there is no other model to try either.
 */
export type GapAttribution =
  | { readonly kind: 'model'; readonly model: string; readonly servedBy: readonly string[] }
  | {
      readonly kind: 'undetermined';
      readonly models: readonly string[];
      readonly defaultRequested?: true;
      readonly everyModelRequested?: true;
    };

/**
 * A tool's own wording for an `all-null` gap, where the shared sentences would claim more
 * than its data supports. Marine gives it: its default blend has gaps a single wave model
 * fills, and no wave model has data on land or under sea ice.
 */
export interface AllNullWording {
  /** Said last about a gap no requested model served: where the tool's data does not exist under any model. */
  readonly noSource: string;
  /**
   * Completes "…even though the units are real, so " when no models were selected, in
   * place of the location-or-window cause: the cause and every remedy, in the order a
   * caller should try them.
   */
  readonly unselected: string;
}

/** A set of variables sharing one temporal coverage gap in one cadence. */
export interface CoverageGap {
  /** Whose an `all-null` gap is, when the caller selected `models`. Absent otherwise. */
  readonly attribution?: GapAttribution;
  readonly cadence: CoverageCadence;
  /** First timestamp carrying data. Absent when the whole window is null. */
  readonly first?: string;
  readonly kind: 'all-null' | 'partial';
  /** Last timestamp carrying data. Absent when the whole window is null. */
  readonly last?: string;
  /** Null rows before `first`. Absent when the whole window is null. */
  readonly leadingNullRows?: number;
  readonly nullRows: number;
  readonly totalRows: number;
  /** Null rows after `last`. Absent when the whole window is null. */
  readonly trailingNullRows?: number;
  /** The requested variables affected, in the order upstream listed their columns. */
  readonly variables: readonly string[];
  /** The selection's {@link AllNullWording}, on an `all-null` gap. Absent when it gave none. */
  readonly wording?: AllNullWording;
}

/** Names listed per gap before the rest are counted — enough to act on, short enough to read. */
const MAX_NAMED = 4;

/**
 * Collapse the per-member and per-model column fan-outs back to the variable a caller
 * asked for. Without it a 51-member ensemble reports one gap per member per variable.
 */
export type ColumnGrouping = (column: string) => string;

/**
 * Strips the ensemble endpoint's `_memberNN` token, wherever upstream puts it: last on a
 * single model's columns (`temperature_2m_member01` → `temperature_2m`), and before the
 * model name when several models answered (`temperature_2m_member01_ncep_gefs025` →
 * `temperature_2m_ncep_gefs025`, that model's control-run column). Each model's members
 * therefore group under their own model, never as a variable of their own.
 */
export const byEnsembleVariable: ColumnGrouping = (column) =>
  column.replace(/_member\d+(?=_|$)/, '');

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
 *
 * Given the caller's model `selection`, an `all-null` group also carries its
 * {@link GapAttribution}, and the merge keeps apart what the attribution tells apart:
 * one entry per empty model and set of models that served the same variables, and one
 * for every column no selected model served. Without a selection, or with no models in
 * it, nothing is attributed. That last entry is flagged `defaultRequested` when the
 * selection's `defaultModel` is among the requested models, and `everyModelRequested`
 * when every one of its `acceptedModels` is. Every `all-null` entry carries the
 * selection's `allNullWording` when it gives one, models selected or not.
 */
export function findCoverageGaps(
  cadence: CoverageCadence,
  block: ColumnarBlock | undefined,
  units: UnitsMap | undefined,
  grouping: ColumnGrouping = (column) => column,
  selection?: ModelSelection,
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

  const spans = [...groups].map(([name, columns]) => coverageSpan(name, columns, times));
  const attribute = selection?.models?.length ? attributor(spans, selection) : undefined;

  /** Gaps keyed by shape, so variables that ran out together are named together. */
  const merged = new Map<string, MergedGap>();
  for (const { carried, name, nullRows } of spans) {
    if (nullRows === 0) continue;
    const owner = carried ? undefined : attribute?.(name);
    const shape = `${carried?.first ?? ''}|${carried?.last ?? ''}|${nullRows}`;
    const key =
      owner?.kind === 'model' ? `${shape}|${owner.model}|${owner.servedBy.join(',')}` : shape;

    const wording = carried ? undefined : selection?.allNullWording;
    const entry: MergedGap = merged.get(key) ?? {
      gap: {
        cadence,
        kind: carried ? 'partial' : 'all-null',
        ...carried,
        nullRows,
        totalRows: times.length,
        ...(wording && { wording }),
      },
      models: new Set(),
      ...(owner && { owner }),
      variables: [],
    };
    entry.variables.push(name);
    if (owner?.kind === 'undetermined') for (const model of owner.models) entry.models.add(model);
    merged.set(key, entry);
  }

  const requested = [...new Set(selection?.models)];
  const defaultRequested =
    selection?.defaultModel !== undefined && requested.includes(selection.defaultModel);
  const everyModelRequested =
    selection?.acceptedModels?.every((model) => requested.includes(model)) === true;
  return [...merged.values()].map(({ gap, models, owner, variables }) => ({
    ...gap,
    variables,
    ...(owner && {
      attribution:
        owner.kind === 'model'
          ? owner
          : {
              kind: owner.kind,
              models: requested.filter((model) => models.has(model)),
              ...(defaultRequested && { defaultRequested: true as const }),
              ...(everyModelRequested && { everyModelRequested: true as const }),
            },
    }),
  }));
}

/** One coverage group's rows: where its data starts and stops, and how many rows carry none. */
interface CoverageSpan {
  /** The first and last timestamp carrying data and the null rows outside them; absent when none does. */
  readonly carried?: Pick<CoverageGap, 'first' | 'last' | 'leadingNullRows' | 'trailingNullRows'>;
  readonly name: string;
  readonly nullRows: number;
}

/** A {@link findCoverageGaps} entry while groups are merged into it. */
interface MergedGap {
  readonly gap: Omit<CoverageGap, 'attribution' | 'variables'>;
  /** The models an `undetermined` entry names, gathered across the groups merged into it. */
  readonly models: Set<string>;
  readonly owner?: GapAttribution;
  readonly variables: string[];
}

/** The {@link CoverageSpan} of one group, read row by row over its combined columns. */
function coverageSpan(
  name: string,
  columns: readonly (readonly (number | string | null)[])[],
  times: readonly string[],
): CoverageSpan {
  let first: string | undefined;
  let last: string | undefined;
  let firstRow = 0;
  let lastRow = 0;
  let nullRows = 0;
  for (const [row, time] of times.entries()) {
    if (columns.some((values) => values[row] != null)) {
      if (first === undefined) {
        first = time;
        firstRow = row;
      }
      last = time;
      lastRow = row;
    } else {
      nullRows += 1;
    }
  }
  if (first === undefined || last === undefined) return { name, nullRows };
  return {
    carried: {
      first,
      last,
      leadingNullRows: firstRow,
      trailingNullRows: times.length - 1 - lastRow,
    },
    name,
    nullRows,
  };
}

/**
 * The {@link GapAttribution} of each empty group under `selection`, which must hold at
 * least one model. A model counts as serving a variable only through its own column for
 * it with a value in this cadence: a sibling variable with values from the same model
 * says nothing about this one — `daylight_duration` is astronomical and present for
 * every window, and `precipitation_hours` reads 0 where a model carries no
 * precipitation — and a column under the unit `"undefined"` never reached the groups.
 * A column that cannot be put on one requested model — a single model's plain names, or
 * the plain names the one survivor of a multi-model request keeps — names every
 * requested model.
 */
function attributor(
  spans: readonly CoverageSpan[],
  selection: ModelSelection,
): (name: string) => GapAttribution {
  const requested = [...new Set(selection.models)];
  /** Variable → the requested models whose column for it carries a value. */
  const served = new Map<string, Set<string>>();
  for (const { carried, name } of spans) {
    const source = carried && columnSource(name, selection);
    if (source) {
      served.set(source.variable, (served.get(source.variable) ?? new Set()).add(source.model));
    }
  }
  return (name) => {
    const source = columnSource(name, selection);
    if (!source) return { kind: 'undetermined', models: requested };
    const servers = served.get(source.variable);
    const servedBy = requested.filter((model) => servers?.has(model));
    return servedBy.length > 0
      ? { kind: 'model', model: source.model, servedBy }
      : { kind: 'undetermined', models: [source.model] };
  };
}

/**
 * Null rows that earn a `partial` gap its sentence wherever they sit.
 *
 * Every sentence in the composed notice reads with the same weight, so a single stray
 * null — a climate pull whose final projected day is empty, 1 row of 36,890 — arrived
 * looking exactly as consequential as a model running out of forecast horizon. Six is
 * the smallest interior run worth naming: `ncep_gefs025` over a sixteen-day window
 * serves ten days and returns six null daily rows, and narrowing `forecast_days` or
 * switching models is a real response to that. A shorter run in the interior is noise
 * in the data, not a coverage boundary; a shorter run at the window's edges can still be
 * one — see {@link MIN_EDGE_PERCENT}.
 */
const MIN_REPORTED_NULL_ROWS = 6;

/**
 * The share of the window, in percent, that a `partial` gap's null rows before its first
 * and after its last timestamp carrying data earn it a sentence at, under
 * {@link MIN_REPORTED_NULL_ROWS}.
 *
 * Nulls at an edge are where a dataset starts or stops — a model's horizon, an archive's
 * first day, the ERA5 lag — and on a short window that is a handful of rows: the last 1
 * of 35 daily rows of `ncep_gefs05`, the last 5 of 100 days of `era5`, the first 4 of 10
 * days of `era5_land` around its 1950 start. One percent sits between the largest edge
 * share that is noise (one trailing null of 36,890) and the smallest measured one a
 * caller acts on (one of 35). Interior nulls are not an edge and keep the six-row floor.
 */
const MIN_EDGE_PERCENT = 1;

/**
 * True when a gap is too small to be worth a sentence. `all-null` never qualifies,
 * whatever its row count: absent data is the answer to the request, not a gap in it.
 *
 * Applied to the message only — {@link findCoverageGaps} still detects, merges, and
 * returns the gap, so the analysis stays complete for any other reader.
 */
function isNegligible(gap: CoverageGap): boolean {
  if (gap.kind === 'all-null' || gap.nullRows >= MIN_REPORTED_NULL_ROWS) return false;
  const edgeRows = (gap.leadingNullRows ?? 0) + (gap.trailingNullRows ?? 0);
  return edgeRows * 100 < gap.totalRows * MIN_EDGE_PERCENT;
}

/** `a, b, c, and 5 more`, capped at {@link MAX_NAMED} names. */
function nameList(variables: readonly string[]): string {
  if (variables.length <= MAX_NAMED) return variables.join(', ');
  return `${variables.slice(0, MAX_NAMED).join(', ')}, and ${variables.length - MAX_NAMED} more`;
}

/**
 * The surfaced message: one sentence per gap worth reporting, naming the affected
 * variables and either that the whole window is empty or where the data actually starts
 * and stops. A partial gap is left out under {@link MIN_REPORTED_NULL_ROWS} unless its
 * edge rows reach {@link MIN_EDGE_PERCENT} of the window, so a stray null does not read
 * like a coverage boundary.
 *
 * An all-null gap's cause follows its {@link GapAttribution}: the model it belongs to
 * when another selected model served the same variables, the location, the window, or
 * the selected models when none did, and — with no models selected — the location or
 * the window.
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
        ? allNullSentence(gap)
        : `Partial ${gap.cadence} coverage for ${nameList(gap.variables)}: data runs ${gap.first} to ${gap.last}, and ${gap.nullRows} of ${gap.totalRows} rows ${gap.nullRows === 1 ? 'is' : 'are'} null.`,
    );
  return sentences.length > 0 ? sentences.join(' ') : undefined;
}

/** The sentence for an `all-null` gap, its cause chosen by {@link CoverageGap.attribution}. */
function allNullSentence(gap: CoverageGap): string {
  const columns = nameList(gap.variables);
  const { attribution, cadence, totalRows, wording } = gap;
  if (!attribution) {
    return wording
      ? `No ${cadence} data for ${columns} anywhere in the requested window — all ${totalRows} values are null even though the units are real, so ${wording.unselected}`
      : `No ${cadence} data for ${columns} anywhere in the requested window — all ${totalRows} values are null even though the units are real, so this location or the requested window falls outside this dataset’s coverage rather than the names being unserved.`;
  }
  const [them, variables] = gap.variables.length === 1 ? ['it', 'variable'] : ['them', 'variables'];
  switch (attribution.kind) {
    case 'model': {
      const { model, servedBy } = attribution;
      const from = servedBy.length === 1 ? servedBy[0] : `one of ${nameList(servedBy)}`;
      return `${model} returned no ${cadence} data for ${columns} — all ${totalRows} values are null, while ${nameList(servedBy)} returned values for the same ${variables}. Read ${them} from ${from}.`;
    }
    case 'undetermined': {
      const { defaultRequested, everyModelRequested, models } = attribution;
      const cause = `No ${cadence} data for ${columns} anywhere in the requested window — all ${totalRows} values are null even though the units are real, so this location or the requested window falls outside this dataset’s coverage, or ${nameList(models)} ${models.length === 1 ? 'does' : 'do'} not carry ${them}.`;
      const noSource = wording ? ` ${wording.noSource}` : '';
      if (everyModelRequested) return `${cause}${noSource}`;
      const remedy = defaultRequested
        ? 'Try another model.'
        : 'Try another model, or omit models to use the default.';
      return `${cause} ${remedy}${noSource}`;
    }
    default: {
      const unreachable: never = attribution;
      return unreachable;
    }
  }
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
  /**
   * The tool's whole model set, given only where that set is closed: no model outside it
   * serves the tool's data. Given, an all-null gap no requested model served offers no
   * other model once every one of these was requested.
   */
  readonly acceptedModels?: readonly string[];
  /** The tool's own {@link AllNullWording}, where the shared all-null sentences overclaim. */
  readonly allNullWording?: AllNullWording;
  /**
   * The model the tool reads when `models` is omitted. Given, an all-null gap no requested
   * model served offers omitting `models` only when this model was not among them.
   */
  readonly defaultModel?: string;
  /** The requested models, as sent; `undefined` when the caller selected none. */
  readonly models: readonly string[] | undefined;
  /** Every requested hourly and daily variable name. */
  readonly variables: readonly string[];
}

/** The requested model and variable a model-suffixed column spells. */
interface ColumnSource {
  readonly model: string;
  readonly variable: string;
}

/**
 * The suffixes a requested model's columns carry. Beside another model the archive
 * names Best Match's columns `<variable>_archive_best_match` and the marine endpoint
 * `<variable>_marine_best_match`, where the forecast endpoint names them
 * `<variable>_best_match`.
 */
function modelSuffixes(model: string): readonly string[] {
  return model === 'best_match'
    ? ['_best_match', '_archive_best_match', '_marine_best_match']
    : [`_${model}`];
}

/**
 * The requested model and variable `column` belongs to. With 2+ models the forecast,
 * archive, climate, and marine endpoints name every hourly and daily column
 * `<variable><suffix>` (see {@link modelSuffixes}), so a column is attributed only when
 * it spells exactly one requested variable–model pair — a bare suffix match would give
 * `temperature_2m_gfs_seamless` to a requested `seamless` too. `undefined` for a bare
 * column, an unrecognized one, or a selection of fewer than two models (whose columns
 * carry plain names).
 */
function columnSource(column: string, selection: ModelSelection): ColumnSource | undefined {
  const { models, variables } = selection;
  if (!models || models.length < 2) return;
  for (const model of models) {
    for (const suffix of modelSuffixes(model)) {
      const variable = column.slice(0, -suffix.length);
      if (column.endsWith(suffix) && variables.includes(variable)) return { model, variable };
    }
  }
  return;
}

/** The requested model a column belongs to — {@link columnSource}'s model. */
export function columnModel(column: string, selection: ModelSelection): string | undefined {
  return columnSource(column, selection)?.model;
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
 * On a plain column that unit means the endpoint parsed the name but serves no data for
 * it; on a `<variable>_<model>` column it means that model does not serve the variable —
 * `lightning_potential_gfs_hrrr` beside a real-unit `lightning_potential_icon_seamless` —
 * so the remedy is another model rather than another tool. The caller keeps reporting the
 * unattributed columns its own way.
 */
export function describeModelUnserved(
  columns: readonly string[],
  selection: ModelSelection,
): string | undefined {
  const byModel = new Map<string, string[]>();
  const attributed: string[] = [];
  for (const column of columns) {
    const source = columnSource(column, selection);
    if (source === undefined) continue;
    attributed.push(column);
    byModel.set(source.model, [...(byModel.get(source.model) ?? []), source.variable]);
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
 * The model a plain column came from once `models` was sent: the selected one, or on a
 * 2+-model call the one upstream kept, which the response does not name. `requested` is
 * the distinct requested models, never empty.
 */
export function describeAnsweringModel(requested: readonly string[]): string {
  return requested.length === 1
    ? `the selected model (${requested[0]})`
    : `the one model left in the response (one of ${requested.join(', ')})`;
}

/**
 * The notice for every column upstream reported with the unit `"undefined"` on a tool
 * that takes `models`: the model-suffixed ones through {@link describeModelUnserved}, the
 * rest as a name the endpoint parsed but serves no data for — typically a variable another
 * endpoint carries, such as `pm2_5` or `wave_height` on the forecast endpoint. A name sent
 * under the wrong cadence is not this case: upstream rejects it with HTTP 400. Once
 * `models` was sent, the model that answered is the other thing that can leave a plain
 * column empty: the selected one, or on a 2+-model call the one upstream kept. `undefined`
 * when `columns` is empty.
 *
 * @param wording.server - What serves the data, in the sentence: `the endpoint`, `the archive`.
 * @param wording.servedBy - Where the kinds of variable this endpoint parses but does not
 * serve are read, e.g. `air-quality variables (pm2_5, …) from openmeteo_get_air_quality`.
 */
export function describeUnservedColumns(
  columns: readonly string[],
  selection: ModelSelection,
  wording: { readonly server: string; readonly servedBy: string },
): string | undefined {
  const unattributed = columns.filter((column) => !columnModel(column, selection));
  const [names, it] = unattributed.length === 1 ? ['that name', 'it'] : ['those names', 'them'];
  const requested = [...new Set(selection.models)];
  const answered = requested.length === 0 ? undefined : describeAnsweringModel(requested);
  const unservedSentence =
    unattributed.length > 0
      ? `${unattributed.join(', ')} returned no data — Open-Meteo reported the unit as "undefined", which means ${wording.server} parsed ${names} but serves no data for ${it}${answered ? `, or ${answered} does not serve ${it}` : ''}. Drop ${it}${answered ? `, read ${it} from another model` : ''}, or request ${it} from the tool that serves that kind of variable: ${wording.servedBy}.`
      : undefined;
  return (
    [describeModelUnserved(columns, selection), unservedSentence].filter(Boolean).join(' ') ||
    undefined
  );
}
