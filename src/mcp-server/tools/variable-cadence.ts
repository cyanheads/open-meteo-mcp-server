/**
 * @fileoverview Cadence-aware validation for Open-Meteo variable inputs, and the
 * post-call tell that catches what it cannot know in advance.
 *
 * Open-Meteo keeps a separate variable set per cadence: `cloud_cover` is hourly,
 * `temperature_2m_max` is daily. A name placed in the opposite bucket fails in one of
 * two ways, both reproduced against the live endpoints. Either the request is rejected
 * with a 400 whose message echoes the whole encoded variable list, so the offender is
 * never isolated and the caller cannot converge; or — on the forecast, archive, and
 * air-quality endpoints — it returns HTTP 200 with an all-null column and the unit
 * string "undefined", indistinguishable from a genuine data gap.
 *
 * The catalogs below are NOT an allowlist. A name is rejected only when it is known to
 * belong to the bucket OPPOSITE the one it arrived in. A name in neither set is unknown,
 * not invalid, and goes upstream untouched — so a variable Open-Meteo adds after this
 * file was written keeps working, which is the constraint that kept client-side
 * allowlists out of scope in the first place.
 *
 * Provenance: each set is the variable list published on the matching Open-Meteo
 * documentation page, read on 2026-07-30:
 *   forecast   — https://open-meteo.com/en/docs
 *   historical — https://open-meteo.com/en/docs/historical-weather-api
 *   marine     — https://open-meteo.com/en/docs/marine-weather-api
 *   ensemble   — https://open-meteo.com/en/docs/ensemble-api
 * The sets are per endpoint rather than shared because the endpoints genuinely differ:
 * the ensemble API publishes `temperature_2m_max` as an hourly aggregation, where the
 * forecast API publishes it under daily only. A shared catalog would reject a valid
 * ensemble request. Pressure-level and model-specific variables are not listed on these
 * pages as cadence-tagged entries and therefore fall through as unknown, which is the
 * intended behaviour.
 *
 * @module mcp-server/tools/variable-cadence
 */

/** The input field a variable arrived in, and the one it may belong in. */
export type VariableField = 'hourly_variables' | 'daily_variables';

/** The two documented variable sets of one Open-Meteo endpoint. */
export interface CadenceCatalog {
  readonly daily: ReadonlySet<string>;
  readonly hourly: ReadonlySet<string>;
}

/** A variable documented in the bucket opposite the one it was passed in. */
export interface CadenceMismatch {
  /**
   * Same-subject names available in `passedIn`, so a caller who wanted this cadence
   * can stay in it (`cloud_cover` in daily_variables → `cloud_cover_max`, `_mean`,
   * `_min`). Empty when the endpoint publishes no counterpart.
   */
  readonly alternatives: readonly string[];
  readonly belongsIn: VariableField;
  readonly passedIn: VariableField;
  readonly variable: string;
}

/** Documented hourly variables of the forecast endpoint (65). */
const FORECAST_HOURLY = new Set([
  'apparent_temperature',
  'boundary_layer_height',
  'cape',
  'cloud_cover',
  'cloud_cover_high',
  'cloud_cover_low',
  'cloud_cover_mid',
  'convective_inhibition',
  'dew_point_2m',
  'diffuse_radiation',
  'diffuse_radiation_instant',
  'direct_normal_irradiance',
  'direct_normal_irradiance_instant',
  'direct_radiation',
  'direct_radiation_instant',
  'et0_fao_evapotranspiration',
  'evapotranspiration',
  'freezing_level_height',
  'global_tilted_irradiance',
  'global_tilted_irradiance_instant',
  'is_day',
  'lifted_index',
  'precipitation',
  'precipitation_probability',
  'pressure_msl',
  'rain',
  'relative_humidity_2m',
  'shortwave_radiation',
  'shortwave_radiation_instant',
  'showers',
  'snow_depth',
  'snowfall',
  'soil_moisture_0_to_1cm',
  'soil_moisture_1_to_3cm',
  'soil_moisture_27_to_81cm',
  'soil_moisture_3_to_9cm',
  'soil_moisture_9_to_27cm',
  'soil_temperature_0cm',
  'soil_temperature_18cm',
  'soil_temperature_54cm',
  'soil_temperature_6cm',
  'sunshine_duration',
  'surface_pressure',
  'temperature_120m',
  'temperature_180m',
  'temperature_2m',
  'temperature_80m',
  'terrestrial_radiation',
  'terrestrial_radiation_instant',
  'total_column_integrated_water_vapour',
  'uv_index',
  'uv_index_clear_sky',
  'vapour_pressure_deficit',
  'visibility',
  'weather_code',
  'wet_bulb_temperature_2m',
  'wind_direction_10m',
  'wind_direction_120m',
  'wind_direction_180m',
  'wind_direction_80m',
  'wind_gusts_10m',
  'wind_speed_10m',
  'wind_speed_120m',
  'wind_speed_180m',
  'wind_speed_80m',
]);

/** Documented daily variables of the forecast endpoint (60). */
const FORECAST_DAILY = new Set([
  'apparent_temperature_max',
  'apparent_temperature_mean',
  'apparent_temperature_min',
  'cape_max',
  'cape_mean',
  'cape_min',
  'cloud_cover_max',
  'cloud_cover_mean',
  'cloud_cover_min',
  'daylight_duration',
  'dew_point_2m_max',
  'dew_point_2m_mean',
  'dew_point_2m_min',
  'et0_fao_evapotranspiration',
  'et0_fao_evapotranspiration_sum',
  'growing_degree_days_base_0_limit_50',
  'leaf_wetness_probability_mean',
  'precipitation_hours',
  'precipitation_probability_max',
  'precipitation_probability_mean',
  'precipitation_probability_min',
  'precipitation_sum',
  'pressure_msl_max',
  'pressure_msl_mean',
  'pressure_msl_min',
  'rain_sum',
  'relative_humidity_2m_max',
  'relative_humidity_2m_mean',
  'relative_humidity_2m_min',
  'shortwave_radiation_sum',
  'showers_sum',
  'snowfall_sum',
  'snowfall_water_equivalent_sum',
  'sunrise',
  'sunset',
  'sunshine_duration',
  'surface_pressure_max',
  'surface_pressure_mean',
  'surface_pressure_min',
  'temperature_2m_max',
  'temperature_2m_mean',
  'temperature_2m_min',
  'updraft_max',
  'uv_index_clear_sky_max',
  'uv_index_max',
  'vapour_pressure_deficit_max',
  'visibility_max',
  'visibility_mean',
  'visibility_min',
  'weather_code',
  'wet_bulb_temperature_2m_max',
  'wet_bulb_temperature_2m_mean',
  'wet_bulb_temperature_2m_min',
  'wind_direction_10m_dominant',
  'wind_gusts_10m_max',
  'wind_gusts_10m_mean',
  'wind_gusts_10m_min',
  'wind_speed_10m_max',
  'wind_speed_10m_mean',
  'wind_speed_10m_min',
]);

/** Cadence catalog for the forecast endpoint. */
export const FORECAST_CADENCE: CadenceCatalog = { hourly: FORECAST_HOURLY, daily: FORECAST_DAILY };

/** Documented hourly variables of the historical endpoint (72). */
const HISTORICAL_HOURLY = new Set([
  'albedo',
  'apparent_temperature',
  'boundary_layer_height',
  'cloud_cover',
  'cloud_cover_high',
  'cloud_cover_high_spread',
  'cloud_cover_low',
  'cloud_cover_low_spread',
  'cloud_cover_mid',
  'cloud_cover_mid_spread',
  'dew_point_2m',
  'dew_point_2m_spread',
  'diffuse_radiation',
  'diffuse_radiation_instant',
  'direct_normal_irradiance',
  'direct_normal_irradiance_instant',
  'direct_radiation',
  'direct_radiation_instant',
  'direct_radiation_spread',
  'et0_fao_evapotranspiration',
  'global_tilted_irradiance',
  'global_tilted_irradiance_instant',
  'is_day',
  'precipitation',
  'precipitation_spread',
  'pressure_msl',
  'pressure_msl_spread',
  'rain',
  'relative_humidity_2m',
  'shortwave_radiation',
  'shortwave_radiation_instant',
  'shortwave_radiation_spread',
  'snow_depth',
  'snow_depth_water_equivalent',
  'snowfall',
  'snowfall_spread',
  'soil_moisture_0_to_7cm',
  'soil_moisture_0_to_7cm_spread',
  'soil_moisture_100_to_255cm',
  'soil_moisture_100_to_255cm_spread',
  'soil_moisture_28_to_100cm',
  'soil_moisture_28_to_100cm_spread',
  'soil_moisture_7_to_28cm',
  'soil_moisture_7_to_28cm_spread',
  'soil_temperature_0_to_7cm',
  'soil_temperature_0_to_7cm_spread',
  'soil_temperature_100_to_255cm',
  'soil_temperature_100_to_255cm_spread',
  'soil_temperature_28_to_100cm',
  'soil_temperature_28_to_100cm_spread',
  'soil_temperature_7_to_28cm',
  'soil_temperature_7_to_28cm_spread',
  'sunshine_duration',
  'surface_pressure',
  'temperature_2m',
  'temperature_2m_spread',
  'terrestrial_radiation',
  'terrestrial_radiation_instant',
  'total_column_integrated_water_vapour',
  'vapour_pressure_deficit',
  'weather_code',
  'wet_bulb_temperature_2m',
  'wind_direction_100m',
  'wind_direction_100m_spread',
  'wind_direction_10m',
  'wind_direction_10m_spread',
  'wind_gusts_10m',
  'wind_gusts_10m_spread',
  'wind_speed_100m',
  'wind_speed_100m_spread',
  'wind_speed_10m',
  'wind_speed_10m_spread',
]);

/** Documented daily variables of the historical endpoint (54). */
const HISTORICAL_DAILY = new Set([
  'apparent_temperature_max',
  'apparent_temperature_mean',
  'apparent_temperature_min',
  'cloud_cover_max',
  'cloud_cover_mean',
  'cloud_cover_min',
  'daylight_duration',
  'dew_point_2m_max',
  'dew_point_2m_mean',
  'dew_point_2m_min',
  'et0_fao_evapotranspiration',
  'et0_fao_evapotranspiration_sum',
  'precipitation_hours',
  'precipitation_sum',
  'pressure_msl_max',
  'pressure_msl_mean',
  'pressure_msl_min',
  'rain_sum',
  'relative_humidity_2m_max',
  'relative_humidity_2m_mean',
  'relative_humidity_2m_min',
  'shortwave_radiation_sum',
  'snowfall_sum',
  'snowfall_water_equivalent_sum',
  'soil_moisture_0_to_100cm_mean',
  'soil_moisture_0_to_7cm_mean',
  'soil_moisture_28_to_100cm_mean',
  'soil_moisture_7_to_28cm_mean',
  'soil_temperature_0_to_100cm_mean',
  'soil_temperature_0_to_7cm_mean',
  'soil_temperature_28_to_100cm_mean',
  'soil_temperature_7_to_28cm_mean',
  'sunrise',
  'sunset',
  'sunshine_duration',
  'surface_pressure_max',
  'surface_pressure_mean',
  'surface_pressure_min',
  'temperature_2m_max',
  'temperature_2m_mean',
  'temperature_2m_min',
  'vapour_pressure_deficit_max',
  'weather_code',
  'wet_bulb_temperature_2m_max',
  'wet_bulb_temperature_2m_mean',
  'wet_bulb_temperature_2m_min',
  'wind_direction_10m_dominant',
  'wind_gusts_10m_max',
  'wind_gusts_10m_mean',
  'wind_gusts_10m_min',
  'wind_speed_10m_max',
  'wind_speed_10m_mean',
  'wind_speed_10m_min',
  'winddirection_10m_dominant',
]);

/** Cadence catalog for the historical endpoint. */
export const HISTORICAL_CADENCE: CadenceCatalog = {
  hourly: HISTORICAL_HOURLY,
  daily: HISTORICAL_DAILY,
};

/** Documented hourly variables of the marine endpoint (23). */
const MARINE_HOURLY = new Set([
  'invert_barometer_height',
  'ocean_current_direction',
  'ocean_current_velocity',
  'sea_level_height_msl',
  'sea_surface_temperature',
  'secondary_swell_wave_direction',
  'secondary_swell_wave_height',
  'secondary_swell_wave_period',
  'swell_wave_direction',
  'swell_wave_height',
  'swell_wave_peak_period',
  'swell_wave_period',
  'tertiary_swell_wave_direction',
  'tertiary_swell_wave_height',
  'tertiary_swell_wave_period',
  'wave_direction',
  'wave_height',
  'wave_peak_period',
  'wave_period',
  'wind_wave_direction',
  'wind_wave_height',
  'wind_wave_peak_period',
  'wind_wave_period',
]);

/** Documented daily variables of the marine endpoint (11). */
const MARINE_DAILY = new Set([
  'swell_wave_direction_dominant',
  'swell_wave_height_max',
  'swell_wave_peak_period_max',
  'swell_wave_period_max',
  'wave_direction_dominant',
  'wave_height_max',
  'wave_period_max',
  'wind_wave_direction_dominant',
  'wind_wave_height_max',
  'wind_wave_peak_period_max',
  'wind_wave_period_max',
]);

/** Cadence catalog for the marine endpoint. */
export const MARINE_CADENCE: CadenceCatalog = { hourly: MARINE_HOURLY, daily: MARINE_DAILY };

/** Documented hourly variables of the ensemble endpoint (69). */
const ENSEMBLE_HOURLY = new Set([
  'apparent_temperature',
  'cape',
  'cloud_cover',
  'cloud_cover_high',
  'cloud_cover_low',
  'cloud_cover_mid',
  'convective_inhibition',
  'dew_point_2m',
  'diffuse_radiation',
  'diffuse_radiation_instant',
  'direct_normal_irradiance',
  'direct_normal_irradiance_instant',
  'direct_radiation',
  'direct_radiation_instant',
  'et0_fao_evapotranspiration',
  'freezing_level_height',
  'global_tilted_irradiance',
  'global_tilted_irradiance_instant',
  'is_day',
  'precipitation',
  'pressure_msl',
  'rain',
  'relative_humidity_2m',
  'shortwave_radiation',
  'shortwave_radiation_instant',
  'snow_depth',
  'snow_depth_water_equivalent',
  'snowfall',
  'snowfall_height',
  'snowfall_water_equivalent',
  'soil_moisture_0_to_10cm',
  'soil_moisture_0_to_7cm',
  'soil_moisture_100_to_200cm',
  'soil_moisture_100_to_255cm',
  'soil_moisture_10_to_40cm',
  'soil_moisture_28_to_100cm',
  'soil_moisture_40_to_100cm',
  'soil_moisture_7_to_28cm',
  'soil_temperature_0_to_10cm',
  'soil_temperature_0_to_7cm',
  'soil_temperature_100_to_200cm',
  'soil_temperature_100_to_255cm',
  'soil_temperature_10_to_40cm',
  'soil_temperature_28_to_100cm',
  'soil_temperature_40_to_100cm',
  'soil_temperature_7_to_28cm',
  'sunshine_duration',
  'surface_pressure',
  'surface_temperature',
  'temperature_120m',
  'temperature_2m',
  'temperature_2m_max',
  'temperature_2m_min',
  'temperature_80m',
  'uv_index',
  'uv_index_clear_sky',
  'vapour_pressure_deficit',
  'visibility',
  'weather_code',
  'wet_bulb_temperature_2m',
  'wind_direction_100m',
  'wind_direction_10m',
  'wind_direction_120m',
  'wind_direction_80m',
  'wind_gusts_10m',
  'wind_speed_100m',
  'wind_speed_10m',
  'wind_speed_120m',
  'wind_speed_80m',
]);

/** Documented daily variables of the ensemble endpoint (41). */
const ENSEMBLE_DAILY = new Set([
  'apparent_temperature_max',
  'apparent_temperature_mean',
  'apparent_temperature_min',
  'cape_max',
  'cape_mean',
  'cape_min',
  'cloud_cover_max',
  'cloud_cover_mean',
  'cloud_cover_min',
  'dew_point_2m_max',
  'dew_point_2m_mean',
  'dew_point_2m_min',
  'et0_fao_evapotranspiration',
  'precipitation_hours',
  'precipitation_sum',
  'pressure_msl_max',
  'pressure_msl_mean',
  'pressure_msl_min',
  'rain_sum',
  'relative_humidity_2m_max',
  'relative_humidity_2m_mean',
  'relative_humidity_2m_min',
  'shortwave_radiation_sum',
  'snowfall_sum',
  'surface_pressure_max',
  'surface_pressure_mean',
  'surface_pressure_min',
  'temperature_2m_max',
  'temperature_2m_mean',
  'temperature_2m_min',
  'wind_direction_100m_dominant',
  'wind_direction_10m_dominant',
  'wind_gusts_10m_max',
  'wind_gusts_10m_mean',
  'wind_gusts_10m_min',
  'wind_speed_100m_max',
  'wind_speed_100m_mean',
  'wind_speed_100m_min',
  'wind_speed_10m_max',
  'wind_speed_10m_mean',
  'wind_speed_10m_min',
]);

/** Cadence catalog for the ensemble endpoint. */
export const ENSEMBLE_CADENCE: CadenceCatalog = { hourly: ENSEMBLE_HOURLY, daily: ENSEMBLE_DAILY };

/** Cap on the same-subject names named in one message — enough to act on, short enough to read. */
const MAX_ALTERNATIVES = 3;

/**
 * Names in `bucket` sharing a subject with `variable` — an aggregate of it
 * (`cloud_cover` → `cloud_cover_max`) or the base it aggregates
 * (`temperature_2m_max` → `temperature_2m`).
 */
function sameSubject(bucket: ReadonlySet<string>, variable: string): string[] {
  return [...bucket]
    .filter((name) => name.startsWith(`${variable}_`) || variable.startsWith(`${name}_`))
    .sort()
    .slice(0, MAX_ALTERNATIVES);
}

function collect(
  names: readonly string[] | undefined,
  passedIn: VariableField,
  belongsIn: VariableField,
  own: ReadonlySet<string>,
  other: ReadonlySet<string>,
): CadenceMismatch[] {
  return (names ?? [])
    .filter((variable) => !own.has(variable) && other.has(variable))
    .map((variable) => ({
      variable,
      passedIn,
      belongsIn,
      alternatives: sameSubject(own, variable),
    }));
}

/**
 * Every requested variable that is documented in the opposite cadence bucket, in the
 * order the caller listed them (hourly field first). A name valid in the bucket it was
 * passed in is never reported, so a variable both sets publish — `weather_code`, or
 * the ensemble endpoint's `temperature_2m_max` — passes either way.
 */
export function findCadenceMismatches(
  catalog: CadenceCatalog,
  hourly: readonly string[] | undefined,
  daily: readonly string[] | undefined,
): CadenceMismatch[] {
  return [
    ...collect(hourly, 'hourly_variables', 'daily_variables', catalog.hourly, catalog.daily),
    ...collect(daily, 'daily_variables', 'hourly_variables', catalog.daily, catalog.hourly),
  ];
}

/**
 * The surfaced message: one sentence per offender naming the value, the field it
 * arrived in, the field it belongs in, and the same-cadence counterparts when the
 * endpoint publishes them.
 */
export function describeCadenceMismatches(mismatches: readonly CadenceMismatch[]): string {
  return mismatches
    .map(({ variable, passedIn, belongsIn, alternatives }) => {
      const cadence = belongsIn === 'daily_variables' ? 'a daily' : 'an hourly';
      const move = `${variable} is not valid in ${passedIn} — Open-Meteo publishes it as ${cadence} variable. Move it to ${belongsIn}`;
      return alternatives.length > 0
        ? `${move}, or stay in ${passedIn} with ${alternatives.join(', ')}.`
        : `${move} or remove it.`;
    })
    .join(' ');
}

/**
 * Variable columns upstream returned with the unit string `"undefined"` — the tell for
 * a name the endpoint's parser accepted but carries no data for, delivered as HTTP 200
 * with an all-null column. Genuinely dimensionless variables come back with an empty
 * unit string rather than `"undefined"`, so `is_day` and `uv_index` do not trip this.
 *
 * This is the backstop for the names the catalogs deliberately do not know: an unknown
 * variable is passed upstream unchecked, and this is what keeps that pass-through from
 * re-opening the silent all-null failure. Takes one units map per cadence and reports
 * them in argument order, so a tool with both buckets names hourly offenders first.
 */
export function undefinedUnitColumns(
  ...unitMaps: (Record<string, string> | undefined)[]
): string[] {
  return unitMaps.flatMap((units) =>
    Object.entries(units ?? {})
      .filter(([, unit]) => unit === 'undefined')
      .map(([name]) => name),
  );
}
