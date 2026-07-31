/**
 * @fileoverview Documented model sets for the two tools that take a `models` input
 * (openmeteo_get_ensemble, openmeteo_get_climate).
 *
 * These are NOT allowlists. Nothing here is checked, before a request or after: a model
 * name the catalog does not carry goes upstream untouched, so a model Open-Meteo adds
 * after this file was written keeps working, and a rejection is reported in the terms
 * upstream used. Open-Meteo stays the authority on which models exist. The catalog's one
 * job is keeping the advertised lists honest — the tool description, the `models` field
 * description, and the `invalid_variable` recovery hint all render from here, so they
 * cannot drift apart.
 *
 * The climate tool also used to reconstruct the offending model locally, because a
 * percent-encoded comma made upstream echo the whole requested list. The service now
 * sends list parameters with a literal comma and upstream isolates the offender itself,
 * which is the authority this catalog was standing in for.
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

/** One ensemble model as its documentation page publishes it. */
export interface EnsembleModel {
  /** Exact `models` API value. */
  readonly name: string;
  /** Members and coverage, for the advertised list. */
  readonly note: string;
}

/**
 * Documented ensemble models (19). A regional model queried outside its domain never
 * fails as a name error, and upstream does not report it uniformly either: the
 * `meteoswiss_*` pair returns `No data is available for this location`, while the rest
 * answer HTTP 200 with a body carrying `nan` coordinates and no data blocks. The service
 * matches both shapes and throws the same non-retryable coverage-gap rejection for each —
 * see its `NO_DATA_REASON` and `NAN_COORDINATE_BODY`.
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
