/**
 * @fileoverview The recovery half of the Open-Meteo coverage-gap rejection, per
 * endpoint. The service writes it into the rejection's message, and the tools that
 * reach the gap declare the same sentence as their `coverage_gap` recovery, so
 * `content[]` states it once. A leaf of its own because the tool suites mock
 * `open-meteo-service.ts` wholesale, which a contract built from it at module load
 * would not survive.
 * @module services/open-meteo/coverage-gap
 */

/** Per-endpoint label: the retry `operation`, and the dataset a coverage gap names. */
export type OpenMeteoOperation =
  | 'geocode'
  | 'forecast'
  | 'historical'
  | 'marine'
  | 'air-quality'
  | 'ensemble'
  | 'flood'
  | 'climate'
  | 'elevation';

/**
 * The endpoints where switching models reaches a coordinate the current one misses.
 * `historical` and `forecast` belong here because each serves regional models — the
 * archive's Europe-only `cerra`, and forecast models such as `icon_d2` or `gfs_hrrr` —
 * that reach the coverage-gap shapes when every requested model misses the coordinate,
 * and switching models is the fix rather than a different coordinate.
 *
 * `flood` takes `models` too but stays out: every GloFAS model shares one grid, so a point
 * it misses (either pole, answered with the `nan` body) is missed by each of them, and only
 * a different coordinate helps.
 */
const MODEL_CAPABLE_OPERATIONS: ReadonlySet<OpenMeteoOperation> = new Set([
  'ensemble',
  'climate',
  'historical',
  'forecast',
]);

/** True for an endpoint where choosing a different model is a move the caller can make. */
export function isModelCapable(operation: OpenMeteoOperation): boolean {
  return MODEL_CAPABLE_OPERATIONS.has(operation);
}

/**
 * What a caller does about a coverage gap on `operation`. Where switching models reaches
 * the point, switching models; on every other endpoint "switch models" would name a
 * parameter the tool has no input for, or one that changes nothing (flood), so the honest
 * statement is that the dataset's grid does not reach the coordinate and only a different
 * coordinate will.
 */
export function coverageGapRecovery(operation: OpenMeteoOperation): string {
  return isModelCapable(operation)
    ? "Switch to a model whose domain includes this coordinate (any global model does), or omit models to use the tool's global default. Retrying returns the same response."
    : `The ${operation} dataset's grid does not cover this coordinate — request a point inside its coverage. Retrying returns the same response.`;
}
