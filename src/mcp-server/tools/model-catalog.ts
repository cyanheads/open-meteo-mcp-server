/**
 * @fileoverview Documented model sets for the tools that take a `models` input
 * (openmeteo_get_forecast, openmeteo_get_ensemble, openmeteo_get_climate,
 * openmeteo_get_historical, openmeteo_get_flood).
 *
 * These are NOT allowlists. Nothing here is checked, before a request or after: a model
 * name the catalog does not carry goes upstream untouched, so a model Open-Meteo adds
 * after this file was written keeps working, and a rejection is reported in the terms
 * upstream used. Open-Meteo stays the authority on which models exist. The catalog's main
 * job is keeping the advertised lists honest — the tool description, the `models` field
 * description, and the `invalid_variable` recovery hint all render from here, so they
 * cannot drift apart. The ensemble member counts also rank the lighter models the
 * ensemble tool's narrowing hint offers, and `DEFAULT_ENSEMBLE_MODEL` is the model an
 * omitted ensemble `models` selects.
 *
 * The climate tool also used to reconstruct the offending model locally, because a
 * percent-encoded comma made upstream echo the whole requested list. The service now
 * sends list parameters with a literal comma and upstream isolates the offender itself,
 * which is the authority this catalog was standing in for.
 *
 * Provenance: each set is the model list published on the matching Open-Meteo
 * documentation page:
 *   forecast — https://open-meteo.com/en/docs (read 2026-10-24)
 *   ensemble — https://open-meteo.com/en/docs/ensemble-api (read 2026-07-30)
 *   climate  — https://open-meteo.com/en/docs/climate-api (read 2026-07-30)
 *   archive  — https://open-meteo.com/en/docs/historical-weather-api (read 2026-09-09)
 *   flood    — https://open-meteo.com/en/docs/flood-api (read 2026-10-24; spans measured live)
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

/** One model as its documentation page publishes it. */
export interface CatalogModel {
  /** Exact `models` API value. */
  readonly name: string;
  /** Coverage, resolution, or member count — the parenthetical in the advertised list. */
  readonly note: string;
}

/** One ensemble model, with the member count and coverage the narrowing hint ranks by. */
export interface EnsembleModel extends CatalogModel {
  /**
   * Members including the control run, as the note states it. A blend whose count varies
   * by region (`icon_seamless_eps`, 20–40) carries its upper bound — the most it can return.
   */
  readonly members: number;
  /** Covers a region only, so it is never offered as a lighter alternative. */
  readonly regional?: true;
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
  { name: 'ecmwf_ifs025_ensemble', members: 51, note: '51 members, global 0.25°' },
  { name: 'ecmwf_aifs025_ensemble', members: 51, note: '51, global 0.25°' },
  { name: 'ecmwf_ifs_europe_ensemble', members: 51, regional: true, note: '51, Europe 9 km' },
  { name: 'ecmwf_aifs_europe_ensemble', members: 51, regional: true, note: '51, Europe 31 km' },
  { name: 'google_weathernext2_ensemble', members: 64, note: '64, global 0.25°' },
  { name: 'ncep_gefs_seamless', members: 31, note: '31, global blend' },
  { name: 'ncep_gefs025', members: 31, note: '31, global 0.25°' },
  { name: 'ncep_gefs05', members: 31, note: '31, global 50 km, 35 days' },
  { name: 'ncep_aigefs025', members: 31, note: '31, global 0.25°' },
  { name: 'icon_seamless_eps', members: 40, note: '20–40, global/Europe blend' },
  { name: 'icon_global_eps', members: 40, note: '40, global 26 km' },
  { name: 'icon_eu_eps', members: 40, regional: true, note: '40, Europe 13 km' },
  { name: 'icon_d2_eps', members: 20, regional: true, note: '20, Central Europe 2 km' },
  { name: 'gem_global_ensemble', members: 21, note: '21, global 0.25°' },
  { name: 'bom_access_global_ensemble', members: 18, note: '18, global 40 km' },
  { name: 'ukmo_global_ensemble_20km', members: 18, note: '18, global 20 km' },
  { name: 'ukmo_uk_ensemble_2km', members: 3, regional: true, note: '3, UK 2 km' },
  {
    name: 'meteoswiss_icon_ch1_ensemble',
    members: 11,
    regional: true,
    note: '11, Central Europe 1 km',
  },
  {
    name: 'meteoswiss_icon_ch2_ensemble',
    members: 21,
    regional: true,
    note: '21, Central Europe 2 km',
  },
];

/**
 * Documented historical-archive models (8), each with the coverage and update cadence its
 * documentation table publishes.
 *
 * `best_match` is the value an omitted `models` selects: a blend of IFS HRES, ERA5, and
 * ERA5-Land, whose components update on different schedules — which is why no single lag
 * figure describes the default response. `cerra` is the one regional entry; requested
 * outside Europe it reaches the same coverage-gap rejection a regional ensemble model does.
 */
export const ARCHIVE_MODELS: readonly CatalogModel[] = [
  { name: 'best_match', note: 'default, blends IFS HRES + ERA5 + ERA5-Land' },
  { name: 'ecmwf_ifs', note: 'global 9 km, updated every 6 hours, no delay' },
  { name: 'ecmwf_ifs_analysis_long_window', note: 'global 9 km, daily, 2 days delay' },
  { name: 'era5_seamless', note: 'ERA5 and ERA5-Land combined' },
  { name: 'era5', note: 'global 0.25° (~25 km), daily, 5 days delay' },
  { name: 'era5_land', note: 'global 0.1° (~11 km), daily, 5 days delay' },
  { name: 'era5_ensemble', note: 'global 0.5° (~55 km), daily, 5 days delay' },
  { name: 'cerra', note: 'Europe only, 5 km, no real-time updates' },
];

/** The advertised archive list — `name (coverage, cadence)`, comma-joined. */
export const ARCHIVE_MODEL_LIST = ARCHIVE_MODELS.map((m) => `${m.name} (${m.note})`).join(', ');

/** The advertised archive names alone, for a recovery hint with no room for notes. */
export const ARCHIVE_MODEL_NAMES = ARCHIVE_MODELS.map((m) => m.name).join(', ');

/**
 * Documented deterministic forecast models (57), in the order the forecast documentation
 * page groups them by provider. `best_match` is the value an omitted `models` selects.
 *
 * These are the provider-prefixed spellings the page now publishes (`ncep_gfs_seamless`,
 * `dwd_icon_seamless`, `cmc_gem_seamless`). The older short spellings (`gfs_seamless`,
 * `icon_seamless`, `icon_d2`, `gfs_hrrr`) still resolve upstream and suffix columns with
 * the name as sent, so a caller carrying one is not broken by advertising these.
 *
 * Global and regional models share one list: a regional model outside its domain is
 * either dropped from a multi-model response or, when every requested model misses the
 * coordinate, rejected as a coverage gap — upstream decides, not this list.
 */
export const FORECAST_MODELS: readonly string[] = [
  'best_match',
  'ecmwf_ifs',
  'ecmwf_ifs025',
  'ecmwf_aifs025_single',
  'cma_grapes_global',
  'bom_access_global',
  'ncep_gfs_seamless',
  'ncep_gfs_global',
  'ncep_hrrr_conus',
  'ncep_nbm_conus',
  'ncep_nam_conus',
  'ncep_aigfs025',
  'ncep_hgefs025_ensemble_mean',
  'jma_seamless',
  'jma_msm',
  'jma_gsm',
  'kma_seamless',
  'kma_ldps',
  'kma_gdps',
  'dwd_icon_seamless',
  'dwd_icon_global',
  'dwd_icon_global_native',
  'dwd_aicon_global_native',
  'dwd_icon_eu',
  'dwd_icon_eu_native',
  'dwd_icon_d2',
  'dwd_icon_d2_native',
  'dwd_icon_d2_ruc_native',
  'cmc_gem_seamless',
  'cmc_gem_gdps',
  'cmc_gem_rdps',
  'cmc_gem_hrdps',
  'cmc_gem_hrdps_west',
  'meteofrance_seamless',
  'meteofrance_arpege_world',
  'meteofrance_arpege_europe',
  'meteofrance_arome_france',
  'meteofrance_arome_france_hd',
  'italia_meteo_arpae_icon_2i',
  'metno_seamless',
  'metno_nordic',
  'knmi_seamless',
  'knmi_harmonie_arome_europe',
  'knmi_harmonie_arome_netherlands',
  'dmi_seamless',
  'dmi_harmonie_arome_europe',
  'ukmo_seamless',
  'ukmo_global_deterministic_10km',
  'ukmo_uk_deterministic_2km',
  'meteoswiss_icon_seamless',
  'meteoswiss_icon_ch1',
  'meteoswiss_icon_ch2',
  'geosphere_seamless',
  'geosphere_arome_austria',
  'chmi_aladin_seamless',
  'chmi_aladin_central_europe_2km',
  'chmi_aladin_cz_1km',
];

/** The advertised forecast names, comma-joined — the input description and recovery hint. */
export const FORECAST_MODEL_NAMES = FORECAST_MODELS.join(', ');

/**
 * First day the default `seamless_v4` serves `forecast_v4` run data instead of
 * `consolidated_v4` reanalysis, as a GMT model date (a timezone east of GMT labels it a
 * day later). Measured live 2026-10-24 at two points: identical to `consolidated_v4`
 * through 2023-08-04, identical to `forecast_v4` from here on.
 */
export const FLOOD_SEAMLESS_SWITCH_DATE = '2023-08-05';

/**
 * Last day `consolidated_v4` carries reanalysis; it answers later dates with HTTP 200 and
 * null rows. Measured live 2026-10-24 — the docs page's source table still says "1984 –
 * July 2022", which is stale.
 */
export const FLOOD_CONSOLIDATED_END_DATE = '2025-05-31';

/**
 * The GloFAS model an omitted `models` selects — upstream's own default, so the tool sends
 * nothing and names this model and its two spans when the caller sent none.
 */
export const DEFAULT_FLOOD_MODEL: CatalogModel = {
  name: 'seamless_v4',
  note: `default — consolidated_v4 reanalysis before ${FLOOD_SEAMLESS_SWITCH_DATE}, forecast_v4 runs from ${FLOOD_SEAMLESS_SWITCH_DATE} into the live forecast`,
};

/**
 * Documented GloFAS version 4 models (3): {@link DEFAULT_FLOOD_MODEL} first, then the two
 * sources it stitches together, each with the span it serves.
 *
 * The page also lists the `_v3` trio. It is left out on purpose: a frozen 0.1° dataset
 * that resolves a coordinate to a different river reach than v4 and serves no recent or
 * forecast days, so advertising it invites a silent wrong-reach comparison. The names
 * still pass through upstream for a caller who asks for them.
 */
export const FLOOD_MODELS: readonly CatalogModel[] = [
  DEFAULT_FLOOD_MODEL,
  {
    name: 'consolidated_v4',
    note: `reanalysis from 1984 through ${FLOOD_CONSOLIDATED_END_DATE}; null after it and on every forecast_days call`,
  },
  {
    name: 'forecast_v4',
    note: 'forecast runs from 2023-06-01 into the live forecast; null before',
  },
];

/** The advertised flood list — `name (span)`, comma-joined. */
export const FLOOD_MODEL_LIST = FLOOD_MODELS.map((m) => `${m.name} (${m.note})`).join(', ');

/** The advertised flood names alone, for a recovery hint with no room for notes. */
export const FLOOD_MODEL_NAMES = FLOOD_MODELS.map((m) => m.name).join(', ');

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

/**
 * The model an omitted or blank `models` selects on openmeteo_get_ensemble. The Ensemble
 * API has no default of its own: a request without `models` is rejected with HTTP 400
 * ("Model 'best_match' is not supported by the Ensemble API"), so the tool always sends one.
 */
export const DEFAULT_ENSEMBLE_MODEL = 'ecmwf_ifs025_ensemble';

/** The advertised ensemble list — `name (members, coverage)`, comma-joined. */
export const ENSEMBLE_MODEL_LIST = ENSEMBLE_MODELS.map((m) => `${m.name} (${m.note})`).join(', ');

/** The advertised ensemble names alone, for a recovery hint with no room for notes. */
export const ENSEMBLE_MODEL_NAMES = ENSEMBLE_MODELS.map((m) => m.name).join(', ');

/** The advertised climate list, comma-joined. */
export const CLIMATE_MODEL_LIST = CLIMATE_MODELS.join(', ');
