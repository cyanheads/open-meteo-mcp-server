/**
 * @fileoverview Tests for the composed response notice and the temporal
 * coverage-gap analysis behind it. Fixtures mirror shapes verified against the live
 * endpoints: a CAMS archive range that opens before the product begins, and an
 * ncep_gefs025 window that runs past the model's horizon. The model-attribution
 * fixtures mirror multi-model forecast and archive responses: per-model suffixed
 * columns, a model upstream dropped, and the plain names left when only one survives.
 * @module tests/tools/response-notice.test
 */

import { describe, expect, it, vi } from 'vitest';
import {
  byEnsembleVariable,
  type CoverageGap,
  columnModel,
  composeNotice,
  describeCoverageGaps,
  describeCurrentGaps,
  describeDroppedModels,
  describeModelUnserved,
  findCoverageGaps,
  findCurrentGaps,
  renderNotice,
} from '@/mcp-server/tools/response-notice.js';
import type { ColumnarBlock } from '@/services/open-meteo/types.js';
import { renderedText } from '../helpers/commonmark.js';
import { cpuMicrosPerCall } from '../helpers/cpu-time.js';

/** `count` consecutive hourly ISO timestamps from `from`. */
const hourlyTimes = (count: number, from = '2022-08-01T00:00'): string[] => {
  const start = new Date(`${from}:00Z`).getTime();
  return Array.from({ length: count }, (_, i) =>
    new Date(start + i * 3_600_000).toISOString().slice(0, 16),
  );
};

/** A sink that records every write, so last-write-wins is observable. */
const recordingSink = () => {
  const writes: string[] = [];
  return { writes, ctx: { enrich: { notice: (text: string) => writes.push(text) } } };
};

describe('composeNotice', () => {
  it('writes the whole composed string on every part, so nothing is dropped', () => {
    // ctx.enrich.notice is last-write-wins on a single key. Rewriting the full string
    // each time is what makes the final write carry every source.
    const { writes, ctx } = recordingSink();
    const notice = composeNotice(ctx);

    notice.add('pm2_5 returned no data.');
    notice.add('Partial hourly coverage for us_aqi.');
    notice.add('Staged 2592 rows.');

    expect(writes).toHaveLength(3);
    expect(writes.at(-1)).toBe(
      'pm2_5 returned no data. Partial hourly coverage for us_aqi. Staged 2592 rows.',
    );
  });

  it('ignores absent and blank parts so a source can call it unconditionally', () => {
    const { writes, ctx } = recordingSink();
    const notice = composeNotice(ctx);

    notice.add(undefined);
    notice.add('');
    expect(writes).toHaveLength(0);

    notice.add('Only this.');
    expect(writes).toEqual(['Only this.']);
  });

  it('never writes when no source has anything to say', () => {
    const notice = vi.fn();
    composeNotice({ enrich: { notice } }).add(undefined);
    expect(notice).not.toHaveBeenCalled();
  });

  it('composes to one line, so the notice reads as one paragraph', () => {
    const { writes, ctx } = recordingSink();
    const notice = composeNotice(ctx);
    notice.add('First.');
    notice.add('Second.');
    expect(writes.at(-1)).not.toContain('\n');
  });
});

describe('findCoverageGaps', () => {
  it('reports a variable with no values anywhere in the window', () => {
    // Live at 47.6062,-122.3321 for 2022-01-01…02: us_aqi reports the real unit USAQI
    // and 48 nulls, because the CAMS global archive does not start until August 2022.
    const time = hourlyTimes(48, '2022-01-01T00:00');
    const block: ColumnarBlock = { time, us_aqi: time.map(() => null) };

    const [gap] = findCoverageGaps('hourly', block, { time: 'iso8601', us_aqi: 'USAQI' });

    expect(gap).toMatchObject({
      cadence: 'hourly',
      kind: 'all-null',
      nullRows: 48,
      totalRows: 48,
      variables: ['us_aqi'],
    });
    expect(gap?.first).toBeUndefined();
    expect(gap?.last).toBeUndefined();
  });

  it('reports where a partially covered variable actually starts and stops', () => {
    // Live for 2022-08-01…03: pm2_5 is null until 2022-08-03T17:00 and carries values
    // from there to the end of the range.
    const time = hourlyTimes(72);
    const block: ColumnarBlock = {
      time,
      pm2_5: time.map((_, row) => (row < 65 ? null : 4.1)),
    };

    const [gap] = findCoverageGaps('hourly', block, { time: 'iso8601', pm2_5: 'μg/m³' });

    expect(gap).toMatchObject({
      kind: 'partial',
      first: time[65],
      last: time[71],
      nullRows: 65,
      totalRows: 72,
      variables: ['pm2_5'],
    });
  });

  it('reports a trailing run the same way as a leading one', () => {
    // ncep_gefs025 over 16 days: daily carries 16 rows and the last 6 are null.
    const time = Array.from({ length: 16 }, (_, i) => `2026-09-${String(9 + i).padStart(2, '0')}`);
    const block: ColumnarBlock = {
      time,
      temperature_2m_max: time.map((_, row) => (row < 10 ? 20.5 : null)),
    };

    const [gap] = findCoverageGaps('daily', block, { time: 'iso8601', temperature_2m_max: '°C' });

    expect(gap).toMatchObject({ kind: 'partial', first: time[0], last: time[9], nullRows: 6 });
  });

  it('names variables that ran out together in one gap', () => {
    const time = hourlyTimes(24);
    const block: ColumnarBlock = {
      time,
      pm2_5: time.map((_, row) => (row < 10 ? 4.1 : null)),
      pm10: time.map((_, row) => (row < 10 ? 8.2 : null)),
      ozone: time.map((_, row) => (row < 10 ? 60 : null)),
    };

    const gaps = findCoverageGaps('hourly', block, {
      pm2_5: 'μg/m³',
      pm10: 'μg/m³',
      ozone: 'μg/m³',
    });

    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.variables).toEqual(['pm2_5', 'pm10', 'ozone']);
  });

  it('separates variables whose gaps differ', () => {
    const time = hourlyTimes(24);
    const block: ColumnarBlock = {
      time,
      pm2_5: time.map((_, row) => (row < 10 ? 4.1 : null)),
      us_aqi: time.map(() => null),
    };

    const gaps = findCoverageGaps('hourly', block, { pm2_5: 'μg/m³', us_aqi: 'USAQI' });

    expect(gaps.map((g) => g.kind)).toEqual(['partial', 'all-null']);
    expect(gaps.map((g) => g.variables)).toEqual([['pm2_5'], ['us_aqi']]);
  });

  it('collapses an ensemble member fan-out to the variable that was requested', () => {
    // A 31-member model would otherwise report the same gap 31 times.
    const time = Array.from({ length: 16 }, (_, i) => `2026-09-${String(9 + i).padStart(2, '0')}`);
    const block: ColumnarBlock = { time };
    const units: Record<string, string> = { time: 'iso8601' };
    for (let m = 1; m <= 31; m++) {
      const column = `temperature_2m_max_member${String(m).padStart(2, '0')}`;
      block[column] = time.map((_, row) => (row < 10 ? 20 + m / 10 : null));
      units[column] = '°C';
    }

    const gaps = findCoverageGaps('daily', block, units, byEnsembleVariable);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.variables).toEqual(['temperature_2m_max']);
    expect(gaps[0]?.nullRows).toBe(6);
  });

  it('treats a member group as covered for any row one member carries', () => {
    const time = hourlyTimes(4);
    const block: ColumnarBlock = {
      time,
      temperature_2m_member01: [1, null, null, null],
      temperature_2m_member02: [null, 2, 3, null],
    };

    const [gap] = findCoverageGaps('hourly', block, undefined, byEnsembleVariable);

    expect(gap).toMatchObject({ kind: 'partial', first: time[0], last: time[2], nullRows: 1 });
  });

  it('skips a column upstream marked with the unit "undefined"', () => {
    // That is an unserved name, already named by its own notice — reporting it here
    // would say the same thing twice in different words.
    const time = hourlyTimes(4);
    const block: ColumnarBlock = {
      time,
      pm2_5: [4.1, 4.2, 4.3, 4.4],
      temperature_2m_max: [null, null, null, null],
    };

    const gaps = findCoverageGaps('hourly', block, {
      pm2_5: 'μg/m³',
      temperature_2m_max: 'undefined',
    });

    expect(gaps).toEqual([]);
  });

  it('reports nothing when every column carries data in every row', () => {
    const time = hourlyTimes(4);
    expect(findCoverageGaps('hourly', { time, pm2_5: [1, 2, 3, 4] }, { pm2_5: 'μg/m³' })).toEqual(
      [],
    );
  });

  it('treats zero and the empty string as data rather than a gap', () => {
    // A dry window is `precipitation: [0, 0, …]` and `is_day` is served as 0/1, not
    // nulls. Testing falsiness instead of nullness would report every rainless
    // forecast and every night hour as a coverage gap.
    const time = hourlyTimes(3);
    const block: ColumnarBlock = {
      time,
      precipitation: [0, 0, 0],
      is_day: [0, 0, 0],
      weather_text: ['', '', ''],
    };

    expect(findCoverageGaps('hourly', block, undefined)).toEqual([]);
  });

  it('reports nothing for an absent or empty block', () => {
    expect(findCoverageGaps('daily', undefined, undefined)).toEqual([]);
    expect(findCoverageGaps('daily', { time: [] }, undefined)).toEqual([]);
  });

  it('ignores the time column itself', () => {
    // `time` is never null and is not a requested variable — it must not become a gap.
    const time = hourlyTimes(4);
    const gaps = findCoverageGaps('hourly', { time, pm2_5: [null, 1, 2, 3] }, undefined);
    expect(gaps.flatMap((g) => g.variables)).toEqual(['pm2_5']);
  });

  it('records the null rows before the first and after the last row carrying data (#91)', () => {
    // Interior nulls between the two edges count toward nullRows only.
    const time = hourlyTimes(12);
    const block: ColumnarBlock = {
      time,
      pm2_5: [null, null, 1, 2, null, null, null, 3, 4, 5, null, null],
    };

    const [gap] = findCoverageGaps('hourly', block, { pm2_5: 'μg/m³' });

    expect(gap).toMatchObject({
      kind: 'partial',
      first: time[2],
      last: time[9],
      nullRows: 7,
      leadingNullRows: 2,
      trailingNullRows: 2,
    });
  });

  it('counts a member group’s edge rows on its combined values, not one member’s (#91)', () => {
    // member01 runs out after row 1 and member02 after row 2: the group carries data
    // through row 2, so only rows 3 and 4 are trailing nulls.
    const time = hourlyTimes(5);
    const block: ColumnarBlock = {
      time,
      temperature_2m_member01: [1, 2, null, null, null],
      temperature_2m_member02: [null, 3, 4, null, null],
    };

    const [gap] = findCoverageGaps('hourly', block, undefined, byEnsembleVariable);

    expect(gap).toMatchObject({
      kind: 'partial',
      first: time[0],
      last: time[2],
      nullRows: 2,
      leadingNullRows: 0,
      trailingNullRows: 2,
    });
  });

  it('records no edge counts on an all-null gap (#91)', () => {
    const time = hourlyTimes(3);
    const [gap] = findCoverageGaps('hourly', { time, us_aqi: [null, null, null] }, undefined);

    expect(gap?.kind).toBe('all-null');
    expect(gap).not.toHaveProperty('leadingNullRows');
    expect(gap).not.toHaveProperty('trailingNullRows');
  });
});

describe('findCoverageGaps under a model selection (#90)', () => {
  const week = Array.from({ length: 7 }, (_, i) => `2020-06-0${i + 1}`);
  const values = week.map((_, row) => row + 0.5);
  const empty = week.map(() => null);

  it('attributes an empty column to its model when another selected model served the variable', () => {
    // Live: era5_land carries no precipitation; era5 does, at the same point and window.
    const block: ColumnarBlock = {
      time: week,
      precipitation_sum_era5_land: empty,
      et0_fao_evapotranspiration_era5_land: empty,
      precipitation_sum_era5: values,
      et0_fao_evapotranspiration_era5: values,
    };
    const selection = {
      models: ['era5_land', 'era5'],
      variables: ['precipitation_sum', 'et0_fao_evapotranspiration'],
    };

    const gaps = findCoverageGaps('daily', block, undefined, undefined, selection);

    expect(gaps).toEqual([
      {
        cadence: 'daily',
        kind: 'all-null',
        nullRows: 7,
        totalRows: 7,
        variables: ['precipitation_sum_era5_land', 'et0_fao_evapotranspiration_era5_land'],
        attribution: { kind: 'model', model: 'era5_land', servedBy: ['era5'] },
      },
    ]);
  });

  it('names the one selected model as the only candidate, with nothing served beside it', () => {
    const block: ColumnarBlock = {
      time: week,
      temperature_2m_max: values,
      precipitation_sum: empty,
    };
    const selection = {
      models: ['era5_land'],
      variables: ['temperature_2m_max', 'precipitation_sum'],
    };

    const [gap] = findCoverageGaps('daily', block, undefined, undefined, selection);

    expect(gap).toMatchObject({
      kind: 'all-null',
      variables: ['precipitation_sum'],
      attribution: { kind: 'undetermined', models: ['era5_land'] },
    });
  });

  it('does not read a sibling variable with values from the same model as coverage', () => {
    // Live: era5_land before its record still returns daylight_duration (astronomical)
    // and precipitation_hours of 0, so neither proves the window is covered.
    const block: ColumnarBlock = {
      time: week,
      precipitation_sum_era5_land: empty,
      daylight_duration_era5_land: values,
      precipitation_sum_ecmwf_ifs: empty,
      daylight_duration_ecmwf_ifs: values,
    };
    const selection = {
      models: ['era5_land', 'ecmwf_ifs'],
      variables: ['precipitation_sum', 'daylight_duration'],
    };

    const gaps = findCoverageGaps('daily', block, undefined, undefined, selection);

    expect(gaps).toEqual([
      expect.objectContaining({
        variables: ['precipitation_sum_era5_land', 'precipitation_sum_ecmwf_ifs'],
        attribution: { kind: 'undetermined', models: ['era5_land', 'ecmwf_ifs'] },
      }),
    ]);
  });

  it('splits each model’s empty columns by which models served them, past two models', () => {
    // CMCC is empty for rain_sum (MRI and HiRAM serve it) and shortwave (only MRI does);
    // HiRAM is empty for shortwave (MRI serves it) and wind (CMCC and MRI do); every
    // model is empty for soil moisture, which therefore names all three.
    const block: ColumnarBlock = {
      time: week,
      rain_sum_CMCC_CM2_VHR4: empty,
      shortwave_radiation_sum_CMCC_CM2_VHR4: empty,
      wind_speed_10m_max_CMCC_CM2_VHR4: values,
      soil_moisture_0_to_10cm_mean_CMCC_CM2_VHR4: empty,
      rain_sum_MRI_AGCM3_2_S: values,
      shortwave_radiation_sum_MRI_AGCM3_2_S: values,
      wind_speed_10m_max_MRI_AGCM3_2_S: values,
      soil_moisture_0_to_10cm_mean_MRI_AGCM3_2_S: empty,
      rain_sum_HiRAM_SIT_HR: values,
      shortwave_radiation_sum_HiRAM_SIT_HR: empty,
      wind_speed_10m_max_HiRAM_SIT_HR: empty,
      soil_moisture_0_to_10cm_mean_HiRAM_SIT_HR: empty,
    };
    const selection = {
      models: ['CMCC_CM2_VHR4', 'MRI_AGCM3_2_S', 'HiRAM_SIT_HR'],
      variables: [
        'rain_sum',
        'shortwave_radiation_sum',
        'wind_speed_10m_max',
        'soil_moisture_0_to_10cm_mean',
      ],
    };

    const gaps = findCoverageGaps('daily', block, undefined, undefined, selection);

    expect(gaps.map((gap) => [gap.variables, gap.attribution])).toEqual([
      [
        ['rain_sum_CMCC_CM2_VHR4'],
        { kind: 'model', model: 'CMCC_CM2_VHR4', servedBy: ['MRI_AGCM3_2_S', 'HiRAM_SIT_HR'] },
      ],
      [
        ['shortwave_radiation_sum_CMCC_CM2_VHR4'],
        { kind: 'model', model: 'CMCC_CM2_VHR4', servedBy: ['MRI_AGCM3_2_S'] },
      ],
      [
        [
          'soil_moisture_0_to_10cm_mean_CMCC_CM2_VHR4',
          'soil_moisture_0_to_10cm_mean_MRI_AGCM3_2_S',
          'soil_moisture_0_to_10cm_mean_HiRAM_SIT_HR',
        ],
        { kind: 'undetermined', models: ['CMCC_CM2_VHR4', 'MRI_AGCM3_2_S', 'HiRAM_SIT_HR'] },
      ],
      [
        ['shortwave_radiation_sum_HiRAM_SIT_HR'],
        { kind: 'model', model: 'HiRAM_SIT_HR', servedBy: ['MRI_AGCM3_2_S'] },
      ],
      [
        ['wind_speed_10m_max_HiRAM_SIT_HR'],
        { kind: 'model', model: 'HiRAM_SIT_HR', servedBy: ['CMCC_CM2_VHR4', 'MRI_AGCM3_2_S'] },
      ],
    ]);
  });

  it('counts a column under the unit "undefined" as serving nothing', () => {
    // That column is an unserved name with its own sentence; it never proves the
    // variable is servable here.
    const block: ColumnarBlock = { time: week, snow_depth_era5: empty, snow_depth_cerra: empty };
    const selection = { models: ['era5', 'cerra'], variables: ['snow_depth'] };

    const gaps = findCoverageGaps(
      'daily',
      block,
      { snow_depth_era5: 'm', snow_depth_cerra: 'undefined' },
      undefined,
      selection,
    );

    expect(gaps).toEqual([
      expect.objectContaining({
        variables: ['snow_depth_era5'],
        attribution: { kind: 'undetermined', models: ['era5'] },
      }),
    ]);
  });

  it('reads the archive’s _archive_best_match columns as best_match serving the variable', () => {
    const block: ColumnarBlock = {
      time: week,
      precipitation_sum_archive_best_match: values,
      precipitation_sum_era5_land: empty,
    };
    const selection = { models: ['best_match', 'era5_land'], variables: ['precipitation_sum'] };

    const [gap] = findCoverageGaps('daily', block, undefined, undefined, selection);

    expect(gap?.attribution).toEqual({
      kind: 'model',
      model: 'era5_land',
      servedBy: ['best_match'],
    });
  });

  it('names every selected model for an all-null column it cannot attribute', () => {
    // A multi-model request that kept one model answers with plain names; which model
    // produced them is not in the response.
    const block: ColumnarBlock = { time: week, temperature_2m: values, precipitation: empty };
    const selection = { models: ['era5', 'cerra'], variables: ['temperature_2m', 'precipitation'] };

    const [gap] = findCoverageGaps('daily', block, undefined, undefined, selection);

    expect(gap?.attribution).toEqual({ kind: 'undetermined', models: ['era5', 'cerra'] });
  });

  it('leaves partial gaps unattributed, and every gap when no models were sent', () => {
    const block: ColumnarBlock = {
      time: week,
      precipitation_sum_era5_land: [1, 2, 3, null, null, null, null],
      precipitation_sum_era5: values,
    };
    const selection = { models: ['era5_land', 'era5'], variables: ['precipitation_sum'] };
    const [partialGap] = findCoverageGaps('daily', block, undefined, undefined, selection);
    expect(partialGap?.kind).toBe('partial');
    expect(partialGap).not.toHaveProperty('attribution');

    const bare: ColumnarBlock = { time: week, precipitation_sum: empty };
    for (const models of [undefined, []]) {
      const [gap] = findCoverageGaps('daily', bare, undefined, undefined, {
        models,
        variables: ['precipitation_sum'],
      });
      expect(gap?.kind).toBe('all-null');
      expect(gap).not.toHaveProperty('attribution');
    }
    expect(findCoverageGaps('daily', bare, undefined)[0]).not.toHaveProperty('attribution');
  });
});

describe('describeCoverageGaps under a model selection (#90)', () => {
  const allNull = (over: Partial<CoverageGap> = {}): CoverageGap => ({
    cadence: 'daily',
    kind: 'all-null',
    nullRows: 30,
    totalRows: 30,
    variables: ['precipitation_sum_era5_land', 'et0_fao_evapotranspiration_era5_land'],
    ...over,
  });

  it('blames the empty model and names the one that served the variables', () => {
    expect(
      describeCoverageGaps([
        allNull({ attribution: { kind: 'model', model: 'era5_land', servedBy: ['era5'] } }),
      ]),
    ).toBe(
      'era5_land returned no daily data for precipitation_sum_era5_land, ' +
        'et0_fao_evapotranspiration_era5_land — all 30 values are null, while era5 returned values ' +
        'for the same variables. Read them from era5.',
    );
  });

  it('agrees in number and offers each serving model when several served one variable', () => {
    expect(
      describeCoverageGaps([
        allNull({
          cadence: 'hourly',
          totalRows: 48,
          variables: ['visibility_dwd_icon_seamless'],
          attribution: {
            kind: 'model',
            model: 'dwd_icon_seamless',
            servedBy: ['ncep_hrrr_conus', 'gfs_seamless'],
          },
        }),
      ]),
    ).toBe(
      'dwd_icon_seamless returned no hourly data for visibility_dwd_icon_seamless — all 48 values ' +
        'are null, while ncep_hrrr_conus, gfs_seamless returned values for the same variable. ' +
        'Read it from one of ncep_hrrr_conus, gfs_seamless.',
    );
  });

  it('caps the serving models it lists and counts the rest', () => {
    const text = describeCoverageGaps([
      allNull({
        variables: ['rain_sum_CMCC_CM2_VHR4'],
        attribution: {
          kind: 'model',
          model: 'CMCC_CM2_VHR4',
          servedBy: ['a', 'b', 'c', 'd', 'e', 'f'],
        },
      }),
    ]);
    expect(text).toContain('while a, b, c, d, and 2 more returned values');
    expect(text).toContain('Read it from one of a, b, c, d, and 2 more.');
  });

  it('names the only selected model as a possible cause beside location and window', () => {
    // Live: era5_land, 2020-06 at 42.03,-93.62 — nothing in a one-model response
    // separates a model lacking the variable from a window or point outside its record.
    expect(
      describeCoverageGaps([
        allNull({
          variables: ['precipitation_sum', 'et0_fao_evapotranspiration'],
          attribution: { kind: 'undetermined', models: ['era5_land'] },
        }),
      ]),
    ).toBe(
      'No daily data for precipitation_sum, et0_fao_evapotranspiration anywhere in the requested ' +
        'window — all 30 values are null even though the units are real, so this location or the ' +
        'requested window falls outside this dataset’s coverage, or era5_land does not carry ' +
        'them. Try another model, or omit models to use the default.',
    );
  });

  it('names every empty model when no selected model served the variable', () => {
    expect(
      describeCoverageGaps([
        allNull({
          variables: ['snow_depth_ecmwf_ifs', 'snow_depth_era5'],
          attribution: { kind: 'undetermined', models: ['ecmwf_ifs', 'era5'] },
        }),
      ]),
    ).toContain('or ecmwf_ifs, era5 do not carry them. Try another model, or omit models');
    expect(
      describeCoverageGaps([
        allNull({
          variables: ['precipitation_sum'],
          attribution: { kind: 'undetermined', models: ['era5_land'] },
        }),
      ]),
    ).toContain('or era5_land does not carry it.');
  });

  it('still names the window for an archive range before the model’s record (#90)', () => {
    // Live: era5_land for 1945-07-01..07 — the window predates the dataset, yet
    // precipitation_hours (zero-filled) and daylight_duration (astronomical) carry values.
    const time = Array.from({ length: 7 }, (_, i) => `1945-07-0${i + 1}`);
    const block: ColumnarBlock = {
      time,
      temperature_2m_max: time.map(() => null),
      precipitation_sum: time.map(() => null),
      precipitation_hours: time.map(() => 0),
      daylight_duration: time.map(() => 54_641.78),
    };
    const selection = {
      models: ['era5_land'],
      variables: [
        'temperature_2m_max',
        'precipitation_sum',
        'precipitation_hours',
        'daylight_duration',
      ],
    };

    const text = describeCoverageGaps(
      findCoverageGaps('daily', block, undefined, undefined, selection),
    );

    expect(text).toContain('No daily data for temperature_2m_max, precipitation_sum anywhere');
    expect(text).toContain('this location or the requested window falls outside');
    expect(text).toContain('or era5_land does not carry them');
  });
});

describe('describeCoverageGaps', () => {
  const gap = (over: Partial<CoverageGap> = {}): CoverageGap => ({
    cadence: 'hourly',
    kind: 'all-null',
    nullRows: 48,
    totalRows: 48,
    variables: ['us_aqi'],
    ...over,
  });

  it('says the window is empty, and why that is not an unserved name', () => {
    const text = describeCoverageGaps([gap()]);

    expect(text).toContain('No hourly data for us_aqi');
    expect(text).toContain('all 48 values are null');
    expect(text).toContain('units are real');
  });

  it('names the location or the window as the cause of an all-null gap, not the window alone (#63)', () => {
    // Live: hourly grass_pollen at 46.6021,-120.5059 (pollen is modeled for Europe only)
    // and marine wave_height_max at that land point both come back all null under a
    // real unit — the window is fine; the location is what is outside coverage.
    const text = describeCoverageGaps([gap({ variables: ['grass_pollen'] })]);

    expect(text).toContain('this location or the requested window falls outside');
    expect(text).not.toContain('so the window falls outside');
  });

  it('gives the first and last timestamp with data for a partial run', () => {
    const text = describeCoverageGaps([
      gap({
        kind: 'partial',
        cadence: 'daily',
        variables: ['temperature_2m_max'],
        first: '2026-09-09',
        last: '2026-09-18',
        nullRows: 6,
        totalRows: 16,
      }),
    ]);

    expect(text).toContain('Partial daily coverage for temperature_2m_max');
    expect(text).toContain('data runs 2026-09-09 to 2026-09-18');
    expect(text).toContain('6 of 16 rows are null');
  });

  it('joins both cadences into one line', () => {
    const text = describeCoverageGaps(
      [gap({ cadence: 'hourly' })],
      [gap({ cadence: 'daily', variables: ['temperature_2m_max'] })],
    );

    expect(text).toContain('No hourly data for us_aqi');
    expect(text).toContain('No daily data for temperature_2m_max');
    expect(text).not.toContain('\n');
  });

  it('caps the names it lists and counts the rest', () => {
    const text = describeCoverageGaps([gap({ variables: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })]);

    expect(text).toContain('a, b, c, d, and 3 more');
    expect(text).not.toContain(', e,');
  });

  it('returns undefined when there is nothing to report', () => {
    expect(describeCoverageGaps([])).toBeUndefined();
    expect(describeCoverageGaps([], [])).toBeUndefined();
  });

  it('words an all-null gap with no model selection exactly as before (#90)', () => {
    // Live: era5_land, 2020-06 at 42.03,-93.62 — the sentence a call without models gets.
    expect(
      describeCoverageGaps([
        gap({
          cadence: 'daily',
          nullRows: 30,
          totalRows: 30,
          variables: ['precipitation_sum', 'et0_fao_evapotranspiration'],
        }),
      ]),
    ).toBe(
      'No daily data for precipitation_sum, et0_fao_evapotranspiration anywhere in the requested ' +
        'window — all 30 values are null even though the units are real, so this location or the ' +
        'requested window falls outside this dataset’s coverage rather than the names being unserved.',
    );
  });

  it('words a partial gap exactly as before (#91)', () => {
    expect(
      describeCoverageGaps([
        gap({
          kind: 'partial',
          cadence: 'daily',
          variables: ['temperature_2m_max'],
          first: '2026-08-01',
          last: '2026-11-03',
          nullRows: 6,
          totalRows: 101,
        }),
      ]),
    ).toBe(
      'Partial daily coverage for temperature_2m_max: data runs 2026-08-01 to 2026-11-03, and 6 of ' +
        '101 rows are null.',
    );
  });

  // --- negligible partial gaps (#52) -----------------------------------------

  const partial = (over: Partial<CoverageGap> = {}): CoverageGap => ({
    cadence: 'daily',
    kind: 'partial',
    first: '1950-01-01',
    last: '2050-12-30',
    nullRows: 1,
    totalRows: 36_890,
    variables: ['temperature_2m_max'],
    ...over,
  });

  it.each([
    ['leading', { first: '1950-01-02', last: '2050-12-31' }],
    ['interior', { first: '1950-01-01', last: '2050-12-31' }],
    ['trailing', { first: '1950-01-01', last: '2050-12-30' }],
  ])('says nothing about a single %s null in an otherwise full series (#52)', (_where, edges) => {
    // Live: a climate pull returns one null row of 36,890 and used to get the same
    // sentence a model-horizon gap gets, so a caller skimming the notice could not
    // tell a stray null from a real gap.
    expect(describeCoverageGaps([partial(edges)])).toBeUndefined();
  });

  it('keeps an interior run under the floor quiet and reports a short edge run (#52, #91)', () => {
    // An interior run of 5 of 16 is a stray hole; 6 meets the floor. A trailing run of
    // 1 of 16 is a model's horizon on a short window, which the caller acts on.
    expect(describeCoverageGaps([partial({ nullRows: 5, totalRows: 16 })])).toBeUndefined();
    expect(describeCoverageGaps([partial({ nullRows: 6, totalRows: 16 })])).toContain(
      '6 of 16 rows are null',
    );
    expect(
      describeCoverageGaps([partial({ nullRows: 1, totalRows: 16, trailingNullRows: 1 })]),
    ).toContain('1 of 16 rows is null');
  });

  it.each([
    // [case, reported, nullRows, leadingNullRows, trailingNullRows, totalRows]
    ['interior 5 of 16', false, 5, 0, 0, 16],
    ['interior 6 of 16', true, 6, 0, 0, 16],
    ['trailing 1 of 16', true, 1, 0, 1, 16],
    ['ensemble ncep_gefs05: trailing 1 of 35', true, 1, 0, 1, 35],
    ['forecast ncep_hrrr_conus daily: trailing 1 of 3', true, 1, 0, 1, 3],
    ['archive ERA5 lag: trailing 5 of 100', true, 5, 0, 5, 100],
    ['era5_land before its record: leading 4 of 10', true, 4, 4, 0, 10],
    ['flood consolidated_v4 before its record: leading 3 of 5', true, 3, 3, 0, 5],
    ['1% is under one row: trailing 1 of 99', true, 1, 0, 1, 99],
    ['edge rows exactly 1%: trailing 2 of 200', true, 2, 0, 2, 200],
    ['edge rows one under 1%: trailing 1 of 200', false, 1, 0, 1, 200],
    ['exactly 1% of 500: 2 leading + 3 trailing', true, 5, 2, 3, 500],
    ['one under 1% of 500: 4 trailing', false, 4, 0, 4, 500],
    ['under both bounds: 1 leading + 4 interior of 300', false, 5, 1, 0, 300],
    ['a single trailing null of 36,890 (#52)', false, 1, 0, 1, 36_890],
  ] as const)(
    '%s → reported: %s (#91)',
    (_case, reported, nullRows, leadingNullRows, trailingNullRows, totalRows) => {
      const text = describeCoverageGaps([
        partial({ nullRows, totalRows, leadingNullRows, trailingNullRows }),
      ]);
      if (reported) expect(text).toContain(`${nullRows} of ${totalRows} rows`);
      else expect(text).toBeUndefined();
    },
  );

  it.each([
    // Measured short-window shapes, run through findCoverageGaps so the edge counts it
    // records are the ones the floor reads.
    ['ensemble ncep_gefs05, 35 days', 35, (row: number) => row < 34, '1 of 35 rows is null'],
    ['archive era5 lag, 100 days', 100, (row: number) => row < 95, '5 of 100 rows are null'],
    ['era5_land 1949-12-27..1950-01-05', 10, (row: number) => row >= 4, '4 of 10 rows are null'],
    [
      'flood consolidated_v4 1996-12-29..1997-01-02',
      5,
      (row: number) => row >= 3,
      '3 of 5 rows are null',
    ],
  ])('reports %s end to end (#91)', (_case, rows, carries, expected) => {
    const time = Array.from({ length: rows }, (_, i) => `t${String(i).padStart(3, '0')}`);
    const block: ColumnarBlock = {
      time,
      temperature_2m_max: time.map((_, row) => (carries(row) ? 20 : null)),
    };

    const gaps = findCoverageGaps('daily', block, { temperature_2m_max: '°C' });

    expect(describeCoverageGaps(gaps)).toContain(expected);
  });

  it('reports a large gap and drops a negligible one in the same response (#52)', () => {
    const text = describeCoverageGaps([
      partial({ variables: ['precipitation_sum'], nullRows: 2 }),
      partial({ variables: ['temperature_2m_max'], nullRows: 65, totalRows: 72 }),
    ]);

    expect(text).toContain('temperature_2m_max');
    expect(text).not.toContain('precipitation_sum');
  });

  it('never suppresses an all-null gap, however few rows it has (#52)', () => {
    // Absent data is not a small gap: one null row out of one is the whole answer.
    const text = describeCoverageGaps([
      gap({ kind: 'all-null', nullRows: 1, totalRows: 1, variables: ['river_discharge'] }),
    ]);

    expect(text).toContain('No hourly data for river_discharge');
  });

  it('leaves the gap analysis itself intact for a negligible gap (#52)', () => {
    // The floor governs prominence in the message, not detection or grouping —
    // findCoverageGaps still merges and reports the gap it found.
    const time = hourlyTimes(48);
    const block: ColumnarBlock = {
      time,
      pm2_5: time.map((_, row) => (row === 20 ? null : 4.1)),
      pm10: time.map((_, row) => (row === 20 ? null : 8.2)),
    };

    const gaps = findCoverageGaps('hourly', block, { pm2_5: 'μg/m³', pm10: 'μg/m³' });

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: 'partial', nullRows: 1, variables: ['pm2_5', 'pm10'] });
    expect(describeCoverageGaps(gaps)).toBeUndefined();
  });
});

describe('findCurrentGaps (#63)', () => {
  const units = {
    time: 'iso8601',
    interval: 'seconds',
    grass_pollen: 'grains/m³',
    pm2_5: 'μg/m³',
  };

  it('returns each requested variable that is null under a real unit', () => {
    // Live at 46.6021,-120.5059: grass_pollen null (grains/m³) beside a real pm2_5.
    const current = { time: '2026-10-12T10:00', interval: 3600, grass_pollen: null, pm2_5: 3.9 };
    expect(findCurrentGaps(current, units)).toEqual(['grass_pollen']);
  });

  it('never names time or interval, even when null', () => {
    const current = { time: null, interval: null, pm2_5: 3.9 };
    expect(findCurrentGaps(current, units)).toEqual([]);
  });

  it('skips a key whose unit is "undefined" — its own notice already names it', () => {
    const current = { time: 't', interval: 900, temperature_2m: 8.6, temperature_2m_max: null };
    expect(
      findCurrentGaps(current, {
        time: 'iso8601',
        interval: 'seconds',
        temperature_2m: '°C',
        temperature_2m_max: 'undefined',
      }),
    ).toEqual([]);
  });

  it('treats zero as data and reports nothing for a fully populated block', () => {
    const current = { time: 't', interval: 3600, grass_pollen: 0, pm2_5: 3.9 };
    expect(findCurrentGaps(current, units)).toEqual([]);
  });

  it('reports nothing when no current block was returned', () => {
    expect(findCurrentGaps(undefined, undefined)).toEqual([]);
  });

  it('keeps upstream key order across several null variables', () => {
    const current = {
      time: 't',
      interval: 900,
      lightning_potential: null,
      cape: 1,
      freezing_level_height: null,
    };
    expect(findCurrentGaps(current, undefined)).toEqual([
      'lightning_potential',
      'freezing_level_height',
    ]);
  });
});

describe('describeCurrentGaps (#63)', () => {
  it('names a single variable and says the null is a coverage gap, not an unserved name', () => {
    const text = describeCurrentGaps(['lightning_potential']);
    expect(text).toBe(
      'No current value for lightning_potential — the value is null even though the unit is ' +
        'real, so it has no coverage at this location and time rather than the name being unserved.',
    );
  });

  it('agrees in number when several variables are null', () => {
    const text = describeCurrentGaps(['grass_pollen', 'birch_pollen']);
    expect(text).toContain('No current value for grass_pollen, birch_pollen');
    expect(text).toContain('the values are null even though the units are real');
    expect(text).toContain('they have no coverage');
    expect(text).toContain('rather than the names being unserved');
  });

  it('caps the names it lists and counts the rest', () => {
    const text = describeCurrentGaps(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(text).toContain('a, b, c, d, and 2 more');
    expect(text).not.toContain(', e');
  });

  it('returns undefined when there is nothing to report', () => {
    expect(describeCurrentGaps([])).toBeUndefined();
  });
});

describe('columnModel (#80, #83)', () => {
  // `seamless` leads, so a bare suffix match would claim the `gfs_seamless` columns for it.
  const selection = {
    models: ['seamless', 'era5', 'era5_land', 'gfs_seamless'],
    variables: ['temperature_2m', 'temperature_2m_max'],
  };

  it('attributes a `<variable>_<model>` column to its requested model', () => {
    expect(columnModel('temperature_2m_era5', selection)).toBe('era5');
    expect(columnModel('temperature_2m_max_era5_land', selection)).toBe('era5_land');
  });

  it('keys on the exact variable–model pair, not a bare name suffix', () => {
    // `seamless` is a suffix of `gfs_seamless`, but `temperature_2m_gfs` is no requested variable.
    expect(columnModel('temperature_2m_gfs_seamless', selection)).toBe('gfs_seamless');
    expect(columnModel('temperature_2m_max_gfs_seamless', selection)).toBe('gfs_seamless');
    expect(columnModel('temperature_2m_seamless', selection)).toBe('seamless');
  });

  it('attributes nothing to a bare column, an unknown pair, or a single-model selection', () => {
    expect(columnModel('temperature_2m', selection)).toBeUndefined();
    expect(columnModel('wind_speed_10m_era5', selection)).toBeUndefined();
    expect(columnModel('temperature_2m_era5', { ...selection, models: ['era5'] })).toBeUndefined();
    expect(columnModel('temperature_2m_era5', { ...selection, models: undefined })).toBeUndefined();
  });

  it('attributes the archive’s _archive_best_match suffix to best_match (#90)', () => {
    // Live: beside another model the archive names Best Match's columns
    // `<variable>_archive_best_match`; the forecast endpoint uses `<variable>_best_match`.
    const archive = { models: ['best_match', 'era5'], variables: ['temperature_2m_max'] };
    expect(columnModel('temperature_2m_max_archive_best_match', archive)).toBe('best_match');
    expect(columnModel('temperature_2m_max_best_match', archive)).toBe('best_match');
    expect(columnModel('temperature_2m_max_era5', archive)).toBe('era5');
    expect(
      columnModel('temperature_2m_max_archive_best_match', {
        ...archive,
        models: ['era5', 'cerra'],
      }),
    ).toBeUndefined();
  });
});

describe('describeDroppedModels (#80, #83)', () => {
  const variables = ['temperature_2m'];
  const block = (...columns: string[]): ColumnarBlock => ({
    time: ['2026-10-24T00:00'],
    ...Object.fromEntries(columns.map((c) => [c, [1]])),
  });

  it('says nothing when every requested model has a column', () => {
    const selection = { models: ['gfs_seamless', 'ecmwf_ifs025'], variables };
    expect(
      describeDroppedModels(
        selection,
        block('temperature_2m_gfs_seamless', 'temperature_2m_ecmwf_ifs025'),
      ),
    ).toBeUndefined();
  });

  it('names each model with no suffixed column and the models the response does compare', () => {
    const selection = { models: ['gfs_seamless', 'icon_d2', 'ecmwf_ifs025', 'arome'], variables };
    expect(
      describeDroppedModels(
        selection,
        block('temperature_2m_gfs_seamless', 'temperature_2m_ecmwf_ifs025'),
      ),
    ).toBe(
      'Open-Meteo returned no columns for icon_d2, arome — it leaves a requested model out of the ' +
        'response when it has no data at this coordinate (typically a regional model outside its ' +
        'domain), so this response compares only gfs_seamless, ecmwf_ifs025.',
    );
  });

  it('finds a model across both cadences, so a column in either block counts', () => {
    const selection = { models: ['a', 'b'], variables: ['temperature_2m', 'precipitation_sum'] };
    expect(
      describeDroppedModels(selection, block('temperature_2m_a'), block('precipitation_sum_b')),
    ).toBeUndefined();
  });

  it('calls unsuffixed columns from a multi-model request unattributable, naming every candidate', () => {
    const selection = { models: ['era5', 'cerra'], variables: ['temperature_2m', 'precipitation'] };
    expect(describeDroppedModels(selection, block('temperature_2m', 'precipitation'))).toBe(
      'temperature_2m, precipitation came back without a model suffix although 2 models were ' +
        'requested (era5, cerra) — Open-Meteo leaves out a requested model that has no data at this ' +
        'coordinate (typically a regional model outside its domain), and the columns of the one left ' +
        'carry plain names, so these values are unattributable: they come from one of era5, cerra, ' +
        'and the response does not say which. Request one model at a time to attribute them.',
    );
  });

  it('counts the archive’s _archive_best_match columns as best_match being present (#90)', () => {
    const selection = { models: ['best_match', 'era5'], variables };
    expect(
      describeDroppedModels(
        selection,
        block('temperature_2m_archive_best_match', 'temperature_2m_era5'),
      ),
    ).toBeUndefined();
  });

  it('counts a model requested twice once', () => {
    const selection = { models: ['era5', 'era5', 'cerra'], variables };
    expect(describeDroppedModels(selection, block('temperature_2m'))).toContain(
      'although 2 models were requested (era5, cerra)',
    );
  });

  it('says nothing for fewer than two models, or when no requested column came back', () => {
    expect(
      describeDroppedModels({ models: ['era5'], variables }, block('temperature_2m')),
    ).toBeUndefined();
    expect(
      describeDroppedModels({ models: undefined, variables }, block('temperature_2m')),
    ).toBeUndefined();
    expect(
      describeDroppedModels({ models: ['a', 'b'], variables }, undefined, block()),
    ).toBeUndefined();
  });
});

describe('describeModelUnserved (#80)', () => {
  const selection = {
    models: ['gfs_hrrr', 'icon_seamless', 'gem_seamless'],
    variables: ['lightning_potential', 'cape'],
  };

  it('names the model that does not serve each "undefined"-unit suffixed column', () => {
    expect(
      describeModelUnserved(
        ['lightning_potential_gfs_hrrr', 'lightning_potential_gem_seamless', 'cape_gfs_hrrr'],
        selection,
      ),
    ).toBe(
      'lightning_potential_gfs_hrrr, lightning_potential_gem_seamless, cape_gfs_hrrr returned no ' +
        'data — Open-Meteo reported the unit as "undefined", which on a model-suffixed column means ' +
        'that model does not serve the variable: gfs_hrrr does not serve lightning_potential, cape; ' +
        'gem_seamless does not serve lightning_potential. Read those variables from a model that serves them.',
    );
  });

  it('leaves bare columns to the caller and says nothing without an attributable column', () => {
    expect(describeModelUnserved(['lightning_potential'], selection)).toBeUndefined();
    expect(describeModelUnserved([], selection)).toBeUndefined();
  });

  it('names the variable behind an _archive_best_match column (#90)', () => {
    expect(
      describeModelUnserved(['uv_index_archive_best_match'], {
        models: ['best_match', 'era5'],
        variables: ['uv_index'],
      }),
    ).toContain('best_match does not serve uv_index.');
  });
});

describe('renderNotice', () => {
  /**
   * Notice text whose Markdown-active characters a bare `> ${notice}` would render as
   * syntax. Canvas IDs are 10 characters of [A-Za-z0-9_-]; variable and model names
   * are caller-typed and echoed back.
   */
  it.each([
    [
      'a canvas ID with edge underscores',
      'Staged 9 rows to table "spilled_ab" on canvas _a4RmGLw5_ — use it.',
    ],
    ['emphasis', 'x returned no data: *x* and _y_ and __z__.'],
    ['code and strikethrough', 'a `b` c ~~d~~ e'],
    ['a link and an image', 'see [a](https://x.io) and ![b](c)'],
    ['raw HTML and an autolink', 'x <b>bold</b> <https://x.io> <a@b.io>'],
    ['an entity and a numeric reference', 'AT&amp;T &copy; &#123;'],
    ['a table pipe', 'a | b | c'],
    ['backslashes', 'C:\\Users\\x\\ and a\\*b'],
    ['a heading marker', '# not a heading'],
    ['a list marker', '- not a list'],
    ['an ordered list marker', '1. not a list'],
    ['a nested quote marker', '> not a quote'],
    ['a trailing hash run', 'ends with #'],
    ['edge whitespace', '  padded  '],
    ['a line break', 'first line\nsecond line'],
    ['a blank line between paragraphs', 'first\n\n_second_'],
  ])('reads back exactly through a CommonMark parse: %s', (_case, notice) => {
    const rendered = renderNotice(notice);

    expect(renderedText(rendered)).toBe(notice);
    // A block quote, every line of it, so no part of the notice escapes the quote.
    for (const line of rendered.split('\n')) expect(line.startsWith('> ')).toBe(true);
  });

  it('leaves a notice with nothing Markdown-active as a plain quote', () => {
    const notice =
      'Partial daily coverage for temperature_2m_max: data runs 2026-08-01 to 2026-11-03, and 5 of 100 rows are null. ' +
      'Staged 9125 rows to table "spilled_hi44" on canvas cnv-a4RmGLw5 — use openmeteo_dataframe_describe.';
    expect(renderNotice(notice)).toBe(`> ${notice}`);
  });

  /** Thread CPU time per render of `text`, so the bound reads the escaper's own work. */
  const renderMicros = (text: string, calls: number): number =>
    cpuMicrosPerCall(() => renderNotice(text), calls);

  /** `unit` repeated to at least `chars` characters. */
  const repeatTo = (unit: string, chars: number) => unit.repeat(Math.ceil(chars / unit.length));

  /**
   * Grows each shape by doubling from 5k and checks the bound at every size before the
   * next, so a super-linear regression fails at the size where it appears.
   */
  it.each([
    // The digit run grows to 320k, the full 64× span; every other shape grows to 80k.
    ['a long digit run', (n: number) => `${'1'.repeat(n)}.`, 320_000],
    ['repeated openers with no closer', (n: number) => repeatTo('<a[*_`', n), 80_000],
    ['overlapping entity prefixes', (n: number) => repeatTo('&amp', n), 80_000],
    ['a whitespace run inside one line', (n: number) => `a${' '.repeat(n)}b`, 80_000],
    ['one long line ending in a break', (n: number) => `${repeatTo('§1 x', n)}\ny`, 80_000],
    ['breaks throughout', (n: number) => repeatTo('  \r\n', n), 80_000],
  ])('renders %s in time linear in its length', (_shape, make, largest) => {
    const base = 5_000;
    const baseMicros = renderMicros(make(base), 20);
    for (let size = base * 2; size <= largest; size *= 2) {
      const micros = renderMicros(make(size), size >= 80_000 ? 2 : 5);
      // Linear growth doubles per step; quadratic quadruples. 256 over the whole span
      // sits between 64× (linear) and 4096× (quadratic).
      expect(micros / baseMicros).toBeLessThan(256 * (size / (base * 64)));
      // An absolute ceiling, in thread CPU time: 200 ms for 320k characters.
      expect(micros).toBeLessThan(200_000 * (size / 320_000) + 20_000);
    }
  });
});
