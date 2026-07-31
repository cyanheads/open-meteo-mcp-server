/**
 * @fileoverview Documented model sets for the two tools that take a `models` input
 * (openmeteo_get_ensemble, openmeteo_get_climate), and the post-rejection isolation the
 * climate tool needs.
 *
 * These are NOT allowlists. Nothing here is checked before a request: a model name the
 * catalog does not carry still goes upstream untouched, so a model Open-Meteo adds after
 * this file was written keeps working. Open-Meteo stays the authority on which models
 * exist. The catalog does two things instead — it keeps the advertised list honest, and
 * it isolates the offender out of a rejected multi-model climate request.
 *
 * Why isolation is needed on climate and not on ensemble: the climate tool sends its
 * `models` array as one comma-joined value, and `URLSearchParams` percent-encodes the
 * commas, so upstream parses the list as a single value and its rejection echoes all of
 * it — `Cannot initialize MultiDomains from invalid String value MRI_AGCM3_2_S,BOGUS`,
 * naming a valid model as a suspect. The ensemble tool takes one model string, so its
 * rejection already names only the offender.
 *
 * Provenance: each set is the model list published on the matching Open-Meteo
 * documentation page, read on 2026-07-30:
 *   ensemble — https://open-meteo.com/en/docs/ensemble-api
 *   climate  — https://open-meteo.com/en/docs/climate-api
 * The ensemble names are the values that page emits in its own `models=` URL, plus
 * `bom_access_global_ensemble`, which the page lists in its model table (as ACCESS-GE)
 * without offering a selector for it — the value is served all the same. Older
 * unsuffixed spellings (`ecmwf_ifs025`, `gfs025`, `icon_seamless`, `gem_global`) still
 * resolve upstream, so a caller carrying one is not broken by advertising the published
 * names. Member counts include the control run, matching the documentation table; the
 * `member_count` a response reports is one lower, since it counts only the perturbed
 * `_memberNN` columns.
 *
 * @module mcp-server/tools/model-catalog
 */

import { extractInvalidValues } from './upstream-error.js';

/** One ensemble model as its documentation page publishes it. */
export interface EnsembleModel {
  /** Exact `models` API value. */
  readonly name: string;
  /** Members and coverage, for the advertised list. */
  readonly note: string;
}

/**
 * Documented ensemble models (19). A regional model queried outside its domain never
 * fails as a name error, but it does not fail uniformly either: the `meteoswiss_*` pair
 * returns `No data is available for this location`, while the rest answer HTTP 200 with
 * a body carrying no data blocks, which surfaces as a transient upstream failure.
 */
export const ENSEMBLE_MODELS: readonly EnsembleModel[] = [
  { name: 'ecmwf_ifs025_ensemble', note: '51 members, global 0.25°' },
  { name: 'ecmwf_aifs025_ensemble', note: '51, global 0.25°' },
  { name: 'ecmwf_ifs_europe_ensemble', note: '51, Europe 9 km' },
  { name: 'ecmwf_aifs_europe_ensemble', note: '51, Europe 31 km' },
  { name: 'google_weathernext2_ensemble', note: '64, global 0.25°' },
  { name: 'ncep_gefs_seamless', note: '31, global blend' },
  { name: 'ncep_gefs025', note: '31, global 0.25°' },
  { name: 'ncep_gefs05', note: '31, global 50 km, 35 days' },
  { name: 'ncep_aigefs025', note: '31, global 0.25°' },
  { name: 'icon_seamless_eps', note: '20–40, global/Europe blend' },
  { name: 'icon_global_eps', note: '40, global 26 km' },
  { name: 'icon_eu_eps', note: '40, Europe 13 km' },
  { name: 'icon_d2_eps', note: '20, Central Europe 2 km' },
  { name: 'gem_global_ensemble', note: '21, global 0.25°' },
  { name: 'bom_access_global_ensemble', note: '18, global 40 km' },
  { name: 'ukmo_global_ensemble_20km', note: '18, global 20 km' },
  { name: 'ukmo_uk_ensemble_2km', note: '3, UK 2 km' },
  { name: 'meteoswiss_icon_ch1_ensemble', note: '11, Central Europe 1 km' },
  { name: 'meteoswiss_icon_ch2_ensemble', note: '21, Central Europe 2 km' },
];

/** Documented CMIP6 climate models (7). */
export const CLIMATE_MODELS: readonly string[] = [
  'CMCC_CM2_VHR4',
  'FGOALS_f3_H',
  'HiRAM_SIT_HR',
  'MRI_AGCM3_2_S',
  'EC_Earth3P_HR',
  'MPI_ESM1_2_XR',
  'NICAM16_8S',
];

/** The advertised ensemble list — `name (members, coverage)`, comma-joined. */
export const ENSEMBLE_MODEL_LIST = ENSEMBLE_MODELS.map((m) => `${m.name} (${m.note})`).join(', ');

/** The advertised ensemble names alone, for a recovery hint with no room for notes. */
export const ENSEMBLE_MODEL_NAMES = ENSEMBLE_MODELS.map((m) => m.name).join(', ');

/** The advertised climate list, comma-joined. */
export const CLIMATE_MODEL_LIST = CLIMATE_MODELS.join(', ');

const CLIMATE_MODEL_SET = new Set(CLIMATE_MODELS);

/**
 * The requested climate models the documentation does not publish — the suspects behind
 * a rejection whose message echoed the whole `models` list.
 *
 * Returns nothing unless the echoed value is exactly the requested list in order, which
 * is what the percent-encoded join produces. That guard is what keeps a rejected
 * *variable* name from being blamed on a model: its message names the variable list, so
 * the comparison fails and the caller gets the generic framing instead.
 *
 * An empty result on a real models rejection means every requested model is documented —
 * the offender is something the catalog cannot see, and the generic framing is honest.
 */
export function isolateUnknownClimateModels(
  requested: readonly string[] | undefined,
  upstreamReason: string | undefined,
): string[] {
  if (!requested || requested.length === 0) return [];
  const echoed = extractInvalidValues(upstreamReason);
  if (echoed.length !== requested.length) return [];
  if (echoed.some((value, i) => value !== requested[i])) return [];
  return echoed.filter((name) => !CLIMATE_MODEL_SET.has(name));
}

/**
 * The surfaced message for a rejected climate request whose offending model(s)
 * {@link isolateUnknownClimateModels} identified — names only those, says why the raw
 * upstream text names more, and lists the documented set to correct against.
 */
export function describeUnknownClimateModels(
  unknown: readonly string[],
  upstreamReason: string | undefined,
): string {
  const plural = unknown.length > 1;
  return (
    `Unknown climate model name${plural ? 's' : ''}: ${unknown.join(', ')}. ` +
    `The upstream message below names every requested model, but only ${plural ? 'these are' : 'this one is'} ` +
    `outside the documented CMIP6 set — remove or correct ${plural ? 'them' : 'it'} and retry. ` +
    `Documented models: ${CLIMATE_MODEL_LIST}. (Upstream: ${(upstreamReason ?? '').trim()})`
  );
}
