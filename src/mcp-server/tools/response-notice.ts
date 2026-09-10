/**
 * @fileoverview One `notice` per response, and the temporal-coverage analysis that
 * feeds it.
 *
 * `ctx.enrich.notice()` writes a single `notice` key and is last-write-wins, so the
 * three things a weather response can need to say — a requested variable came back
 * with the unit `"undefined"`, a recognized variable's window falls outside the
 * dataset's coverage, and the full row set was staged on a canvas — cannot each call
 * it. {@link composeNotice} collects the parts and writes the whole string every time
 * one arrives, so no source silently drops another and no handler has to remember an
 * emit step before each of its return paths.
 *
 * The coverage analysis here is the temporal counterpart to two neighbours it is
 * deliberately not:
 *   - `undefinedUnitColumns` in `variable-cadence.ts` catches a name the endpoint
 *     parsed but does not serve, which it reports by setting the unit to the literal
 *     string `"undefined"`. Coverage gaps carry real units (`μg/m³`, `°C`) and only
 *     the values are null, so that check never fires on them — and the columns it
 *     does catch are excluded here rather than reported twice.
 *   - `coverageGapError` in `open-meteo-service.ts` rejects an out-of-domain
 *     *coordinate* for a regional model before a response exists. This runs on a
 *     successful HTTP 200 for an in-domain coordinate whose requested *time window*
 *     predates a dataset's archive or exceeds a model's forecast horizon.
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
 * Temporal coverage gaps among the recognized variables of one columnar block.
 *
 * A gap is a variable whose values are null where the response has rows, with a real
 * unit — the shape Open-Meteo returns for a window outside a dataset's coverage: an
 * archive range before the product's first data, or a forecast horizon past what the
 * selected model runs. Columns upstream marked with the unit `"undefined"` are skipped;
 * those are unserved names, already named by their own notice.
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

/** `a, b, c, and 5 more`, capped at {@link MAX_NAMED} names. */
function nameList(variables: readonly string[]): string {
  if (variables.length <= MAX_NAMED) return variables.join(', ');
  return `${variables.slice(0, MAX_NAMED).join(', ')}, and ${variables.length - MAX_NAMED} more`;
}

/**
 * The surfaced message: one sentence per gap, naming the affected variables and either
 * that the whole window is empty or where the data actually starts and stops.
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
    .map((gap) =>
      gap.kind === 'all-null'
        ? `No ${gap.cadence} data for ${nameList(gap.variables)} anywhere in the requested window — ` +
          `all ${gap.totalRows} values are null even though the units are real, so the window falls ` +
          'outside this dataset’s coverage rather than the names being unserved.'
        : `Partial ${gap.cadence} coverage for ${nameList(gap.variables)}: data runs ${gap.first} to ` +
          `${gap.last}, and ${gap.nullRows} of ${gap.totalRows} rows are null.`,
    );
  return sentences.length > 0 ? sentences.join(' ') : undefined;
}
