/**
 * @fileoverview The `current_variables` guard shared by the two tools that take both
 * `current_variables` and a `models` list: forecast and marine. Each declares its own
 * `current_multi_model` contract entry and throws with the message built here, so the
 * check and its wording live in one place.
 * @module mcp-server/tools/current-input
 */

/**
 * The `current_multi_model` message when `current_variables` is combined with two or
 * more distinct models, or `undefined` when the current block can be attributed to one
 * model — a model named twice included, since its block is still that model's.
 *
 * Upstream answers `current` with one unsuffixed block taken from the first listed model
 * that covers the coordinate, however many models were sent — on the marine endpoint
 * 6.84 m for ecmwf_wam,ncep_gfswave016 at 45, −30 and 6.54 m with the order reversed —
 * so beside a comparison it reads as everyone's current conditions while being one
 * model's. Per-model current blocks are not something one request can produce. Pass the
 * cleaned lists: an empty or absent `current` asks for no current block.
 */
export function currentMultiModelMessage(
  current: readonly string[] | undefined,
  models: readonly string[] | undefined,
): string | undefined {
  const distinct = [...new Set(models)];
  if (!current?.length || distinct.length < 2) return;
  return `current_variables cannot be combined with ${distinct.length} models (${distinct.join(', ')}): Open-Meteo answers current conditions from a single model — the first listed one that covers the coordinate — in one unsuffixed block, so the values would not say which model produced them. Send current_variables with one model or none, and compare models through hourly_variables or daily_variables.`;
}
