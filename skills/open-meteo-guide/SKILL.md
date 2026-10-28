---
name: open-meteo-guide
description: Tool choice, gates, and workflows for the openmeteo_* weather tools, covering threshold odds from the ensemble, frost, anomalies against a normal, 2050 projections, surf spots, river flood outlooks, and air quality for a set hour. Use before answering a weather, climate, marine, river, or air-quality question from openmeteo_* output, above all a probability, a comparison to normal or to the past, or a question about one beach or river.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

Modeled, gridded data from Open-Meteo, keyless: deterministic and ensemble forecasts, the reanalysis archive, marine waves, CAMS air quality, GloFAS river discharge, CMIP6 climate projections, terrain elevation, and a populated-place geocoder. Not here: official watches and warnings, station observations, and weather forecasts past the ensemble's 35-day ceiling. For next month's or next season's weather, say no tool covers it; never substitute a climate projection.

| The question | Tool | Not |
|:--|:--|:--|
| What will it do (one expected value) | `openmeteo_get_forecast` | — |
| How likely is X, or above a threshold | `openmeteo_get_ensemble` | `precipitation_probability` on the forecast |
| What happened, or how it compares to normal | `openmeteo_get_historical`, one pinned model | `openmeteo_get_climate` |
| How the climate shifts by the 2040s | `openmeteo_get_climate`, several models | the archive as the baseline |
| Waves and swell; wind for them | `openmeteo_get_marine`; `openmeteo_get_forecast` | — |
| River flow and flood odds | `openmeteo_get_flood` | — |
| Pollutants, AQI, pollen (Europe only; null elsewhere, with a coverage notice) | `openmeteo_get_air_quality` | — |

## Identifiers

- **Coordinates** come from `openmeteo_search_locations`, which indexes populated places only: a surf break ("Banzai Pipeline") returns `no_results`. Geocode the nearest town, then move the coordinate onto the water or the river channel (Gates 5 and 6).
- **The served cell.** Each weather response's `latitude`/`longitude` is the grid cell that answered, not the input, and it can sit kilometres away: `era5` (0.25° grid) answered Seattle from 47.5, −122.25. Once a marine or flood cell is chosen, send that served coordinate on every follow-up call so all the numbers come from one cell.
- **`canvas_id` and `table_name`** come only from a response with `truncated: true`. A window small enough to return inline is not staged.

## Gates

1. **Odds come from the ensemble.** `precipitation_probability` is the chance of more than 0.1 mm in the preceding hour, and daily `precipitation_probability_max` is the highest hourly value of the day. Neither answers "more than 20 mm" or "a wet day". For a threshold, count ensemble values over it (Workflows). In one probe the default forecast gave 21.8 mm and a 74 % maximum hourly probability for a day on which 5 of 51 ensemble values passed 20 mm.
2. **Frost is a surface question.** `temperature_2m_min` is air at 2 m. Request hourly `soil_temperature_0cm` (the surface temperature on land) beside it before saying "no frost": one probe returned daily minima of 0.6 °C and 1.0 °C while the surface fell to −0.7 °C and −1.8 °C. For the odds of an air frost, count ensemble `temperature_2m_min` members below 0.
3. **A projection is not a forecast.** `openmeteo_get_climate` returns a plausible value for any date to 2050 (it answered 2027-07-01 with no warning), and its models disagree by several degrees on a single day (5.1 to 12.7 °C at one point on 2041-01-01). Never read a date, a month, or a season from it. Compare multi-year windows only, take each model's change against its own baseline window, and report the range across models.
4. **One model across a comparison.** The archive's default blend changes source by date, and sources differ by more than a degree on the same day (`era5` 20.5 °C, `ecmwf_ifs` 18.8 °C). Pin one archive model for the baseline and the period you compare to it. An ERA5-family pin leaves the last week or so null; on 2026-10-28, `era5` ended at 2026-10-21. End the comparison at the date the notice names; never splice in another model or forecast `past_days`. Not every archive model reaches 1940: `era5_land` returned nulls for July 1945 where `era5` had values.
5. **Check the marine cell.** A coastal land point does not come back null. It is answered from a nearby sea cell: an inland point in Anaheim (33.80, −117.85) returned real waves from 33.708, −117.958. Only points far inland return nulls. Close to shore, neighbouring cells differ: two cells about 8 km apart off Huntington Beach gave swell of 10.3 s from 224° and 7.4 s from 274°. Place the coordinate just offshore of the break, confirm the served cell is the one you meant, and compare one neighbouring offshore cell before you commit.
6. **Check the river's magnitude.** GloFAS cells sit on a 0.05° grid (snapped values such as 50.925, 6.975), and the cell that answers is not reliably the biggest river nearby. Downtown Cologne (50.94, 6.96) is answered by a cell carrying a few m³/s, while the cell 0.05° west carries over 1,000 m³/s, the Rhine. If the discharge is orders of magnitude below what the named river carries, try neighbouring cells in 0.05° steps across the channel and keep the one that fits.
7. **The AQI looks backward.** `us_aqi` and the `us_aqi_*` sub-indices average over preceding hours: 24 h for particulates, and for ozone the higher of the hourly and 8 h values. In one probe `us_aqi_pm2_5` fell from 30 to 22 while hourly `pm2_5` rose from 1.4 to 2.6 μg/m³. For conditions at a given hour, read the hourly concentrations (`pm2_5`, `ozone`) for that hour alongside the index. The scales also differ: `us_aqi` 0–50 is good, while `european_aqi` 20–40 is only "fair".

## Workflows

### Exceedance odds ("chance of more than 20 mm on Saturday", "will it freeze")

Call `openmeteo_get_ensemble` with only the daily variable you need (`precipitation_sum`, `temperature_2m_min`) and `forecast_days` that reach the day. Each row carries the unsuffixed control column plus `_member01` and up: the default `ecmwf_ifs025_ensemble` gives 51 values per row, and `member_count` reports 50 because it leaves out the control. Probability = values past the threshold ÷ non-null values in that row. A small pull returns inline, so count it yourself. For a staged table, the `sql` parameter of `openmeteo_dataframe_query` describes a member-count pattern; it matches `_member` columns only, so its denominator leaves out the control (50 where this count uses 51).

### Anomaly against a normal ("how does this October compare")

1. Baseline: `openmeteo_get_historical` with one pinned model, one or two daily variables, and the full normal window (1991–2020). That spills: 10,958 daily rows went to the canvas in one call.
2. Target: the same model, coordinate, and variable for the period in question. This returns inline.
3. Match the days. Average the baseline over the same calendar days the target actually covers. In one probe, 2026-10-01 to 10-21 averaged 12.69 °C against a 12.2 °C normal for October 1–21 and 11.46 °C for all of October; the whole-month normal would have reported +1.2 °C instead of +0.5 °C.

### Climate shift ("summer heat around Seattle by the 2040s")

Run `openmeteo_get_climate` twice with the same models and variables: once for a future window and once for a baseline window. When the first call spills, pass its `canvas_id` to the second so both tables sit on one canvas. Compute per-model statistics for each window, then report the per-model deltas as a range. In one probe the summer mean daily maximum rose 0.6 to 3.2 °C depending on the model. A model can end before 2050 (`EC_Earth3P_HR` stopped at 2049-12-31), so read the coverage notice before averaging.

### River flood outlook ("flood risk next month")

1. Find the cell (Gate 6), then reuse its served coordinate.
2. Climatology: a date range with `models: ["consolidated_v4"]`. It spills; take quantiles in SQL (`quantile_cont(river_discharge, 0.9)`), or the median of annual maxima.
3. Outlook: `forecast_days`, with `river_discharge_p75` and `river_discharge_max` beside `river_discharge`. `river_discharge` is one value, not the ensemble centre, and it can fall below `river_discharge_p25`. Judge the risk from the upper statistics against the cell's own quantiles, and report how many days ahead the exceedance appears.

### Surf session at a named beach

Geocode the town, then move the coordinate offshore of the break (Gate 5). Read the marine hourly `swell_wave_height`, `swell_wave_period`, and `swell_wave_direction`, and the forecast's `wind_speed_10m` and `wind_direction_10m` at the same point for onshore or offshore wind. Wave and wind directions both give where they come from: at one open-ocean point, wind waves from 70° sat under wind from 66°.

### Conventions

- Daily rows aggregate the local calendar day in the response `timezone` (the default `auto` is the location's zone). Daily sums match the hourly rows carrying that date, so "Saturday" means the location's Saturday; daily minima and maxima can differ from the hourly extremes by a few tenths of a degree.
- Daily `weather_code` is the most severe condition of the day, not its prevailing weather. Codes: [references/weather-codes.md](references/weather-codes.md).

### DataCanvas

Results too large to return inline are staged as a DataCanvas table, and the response carries a `canvas_id`. Call `openmeteo_dataframe_describe` with it for the staged table and column names before writing SQL, then `openmeteo_dataframe_query` with a read-only query. Pass the same `canvas_id` back to stage further results beside the first; the tables expire with the canvas.

For per-model columns, stack two windows and turn the model suffix into a value:

```sql
WITH u AS (SELECT 'base' AS period, * FROM <baseline_table>
           UNION ALL BY NAME SELECT 'future' AS period, * FROM <future_table>),
l AS (UNPIVOT u ON COLUMNS('^temperature_2m_max_') INTO NAME model VALUE tmax)
SELECT model, period, avg(tmax) AS mean_tmax, count(*) FILTER (WHERE tmax > 30) AS hot_days
FROM l WHERE substr(time, 6, 2) IN ('06', '07', '08') GROUP BY ALL ORDER BY model, period
```

Integer aggregates such as `count(*)` come back as strings (`"64"`). Averages come back as numbers.

## References

- [references/weather-codes.md](references/weather-codes.md): WMO weather interpretation codes returned by `weather_code`.
