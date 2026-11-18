/**
 * @fileoverview The recovery half of the Open-Meteo coverage-gap rejection, per
 * endpoint and, on marine, per call. The service writes it into the rejection's message,
 * and the tools that reach the gap declare the sentence for a call that sent no models
 * as their `coverage_gap` recovery, so `content[]` states it once. A leaf of its own
 * because the tool suites mock `open-meteo-service.ts` wholesale, which a contract built
 * from it at module load would not survive.
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
 *
 * `marine` stays out of the set and qualifies per call (see {@link isModelCapable}).
 */
const MODEL_CAPABLE_OPERATIONS: ReadonlySet<OpenMeteoOperation> = new Set([
  'ensemble',
  'climate',
  'historical',
  'forecast',
]);

/**
 * True when choosing a different model is a move the caller can make on `operation`,
 * given the `models` the call sent — which decides how the service describes a `nan` body.
 *
 * `marine` qualifies only when the call sent `models` without `best_match`, its default
 * blend: a gap there is every listed model missing the point (`ewam` outside Europe). A
 * gap on a call that read the blend, by omitting `models` or by naming it, is the blend's.
 * Neither says another model reaches the point: at −90, 0 the blend is a coverage gap and
 * every global wave model answers with all-null columns.
 */
export function isModelCapable(operation: OpenMeteoOperation, models?: readonly string[]): boolean {
  return (
    MODEL_CAPABLE_OPERATIONS.has(operation) ||
    (operation === 'marine' && (models?.length ?? 0) > 0 && !models?.includes('best_match'))
  );
}

/**
 * Where no marine model has wave data, so no `models` value reaches the point. Leads the
 * marine remedy for a call that sent no models — land is the likelier cause there — and
 * closes the others, and the marine notice for an all-null column no requested model served.
 */
export const MARINE_NO_WAVE_DATA =
  'A point on land or under sea ice has no wave data from any model, so there the remedy is a coordinate in open water.';

/**
 * The marine remedy, after {@link MARINE_NO_WAVE_DATA}, for a call that read the default
 * blend without naming it: a single model, since the blend has gaps one fills — at −60, 0
 * it returns all-null wave columns where ecmwf_wam returns values. Shared by the
 * coverage-gap recovery and the marine all-null notice.
 */
export const MARINE_NAME_A_MODEL =
  'For a point in open water, name a model in models: the default blend has gaps a single wave model can fill.';

/**
 * The marine move a coverage-gap call that sent `models` can make. Nothing is known to
 * cover the point, so each names a change to the request and none claims it reaches the
 * coordinate: the blend after the named models missed, and other models when the blend
 * was among those that missed, since omitting `models` reads it again.
 */
function marineRemedy(models: readonly string[]): string {
  return models.includes('best_match')
    ? 'Name other models: best_match, the default blend, missed this coordinate too, so omitting models will not reach it.'
    : 'Name another model, or omit models to read the default blend.';
}

/**
 * What a caller does about a coverage gap on `operation`, for a call that sent `models`
 * or none. Where switching models reaches the point, switching models; where "switch
 * models" would name a parameter the tool has no input for, or one that changes nothing
 * (flood), the honest statement is that the dataset's grid does not reach the coordinate
 * and only a different coordinate will. Marine is worded per call: with no models,
 * {@link MARINE_NO_WAVE_DATA} then {@link MARINE_NAME_A_MODEL}; with models, the move
 * {@link marineRemedy} names, then {@link MARINE_NO_WAVE_DATA}.
 *
 * Omitting `models` changes the request where it is offered: the gap fires only when
 * every sent model misses, so a call that reached the gap did not send its default. On
 * forecast, historical, ensemble, and climate that default is a global model.
 */
export function coverageGapRecovery(
  operation: OpenMeteoOperation,
  models?: readonly string[],
): string {
  if (operation === 'marine') {
    const remedy = models?.length
      ? `${marineRemedy(models)} ${MARINE_NO_WAVE_DATA}`
      : `${MARINE_NO_WAVE_DATA} ${MARINE_NAME_A_MODEL}`;
    return `${remedy} Retrying returns the same response.`;
  }
  return isModelCapable(operation, models)
    ? "Switch to a model whose domain includes this coordinate (any global model does), or omit models to use the tool's global default. Retrying returns the same response."
    : `The ${operation} dataset's grid does not cover this coordinate — request a point inside its coverage. Retrying returns the same response.`;
}
