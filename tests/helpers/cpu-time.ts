/**
 * @fileoverview CPU time a function spends per call, measured on the test's own thread,
 * for running-time bounds that never read the wall clock.
 * @module tests/helpers/cpu-time
 */

/** Batches per measurement; the least of them is the result. */
const BATCHES = 5;

/** Most CPU one measurement spends across its batches, in microseconds. */
const MEASUREMENT_BUDGET_MICROS = 1_000_000;

/** CPU microseconds this thread spends running `fn` `calls` times. */
function spentMicros(fn: () => void, calls: number): number {
  const before = process.threadCpuUsage();
  for (let i = 0; i < calls; i++) fn();
  const after = process.threadCpuUsage();
  return after.user - before.user + (after.system - before.system);
}

/**
 * CPU microseconds this thread spends per call of `fn`, over batches of up to `calls`
 * calls: the least of several batches, so a stray scheduler pause cannot inflate it. A
 * batch that registers no CPU at all counts as one microsecond — the clock's resolution.
 *
 * The first call is timed too, as an estimate of one call's cost. When `calls` calls at
 * that cost would spend more than {@link MEASUREMENT_BUDGET_MICROS} across the batches,
 * each batch makes fewer calls, at least one: a function that is no longer linear then
 * returns its cost in one budget and fails the caller's bound, instead of holding the
 * test until every batch has run in full.
 */
export function cpuMicrosPerCall(fn: () => void, calls: number): number {
  const estimate = Math.max(spentMicros(fn, 1), 1);
  const perBatch = Math.max(
    1,
    Math.min(calls, Math.floor(MEASUREMENT_BUDGET_MICROS / (BATCHES * estimate))),
  );
  let least = Number.POSITIVE_INFINITY;
  for (let batch = 0; batch < BATCHES; batch++) {
    least = Math.min(least, Math.max(spentMicros(fn, perBatch), 1) / perBatch);
  }
  return least;
}
