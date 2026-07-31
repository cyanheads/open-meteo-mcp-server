/**
 * @fileoverview Tests for the cadence catalogs and the "undefined" unit tell.
 * @module tests/tools/variable-cadence.test
 */

import { describe, expect, it } from 'vitest';
import {
  describeCadenceMismatches,
  ENSEMBLE_CADENCE,
  FORECAST_CADENCE,
  findCadenceMismatches,
  HISTORICAL_CADENCE,
  MARINE_CADENCE,
  undefinedUnitColumns,
} from '@/mcp-server/tools/variable-cadence.js';

describe('findCadenceMismatches', () => {
  it('isolates the single offender out of a list of valid daily siblings (#26)', () => {
    const mismatches = findCadenceMismatches(FORECAST_CADENCE, undefined, [
      'sunrise',
      'sunset',
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_sum',
      'cloud_cover',
      'weather_code',
      'uv_index_max',
    ]);

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      variable: 'cloud_cover',
      passedIn: 'daily_variables',
      belongsIn: 'hourly_variables',
    });
  });

  it('catches the silent direction — a daily variable in hourly_variables (#26)', () => {
    const mismatches = findCadenceMismatches(FORECAST_CADENCE, ['temperature_2m_max'], undefined);

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      variable: 'temperature_2m_max',
      passedIn: 'hourly_variables',
      belongsIn: 'daily_variables',
    });
  });

  it('passes an unknown name through — the catalogs are not an allowlist (#7)', () => {
    expect(
      findCadenceMismatches(
        FORECAST_CADENCE,
        ['temperature_2m', 'a_variable_open_meteo_added_later'],
        ['temperature_2m_max', 'another_new_daily_variable'],
      ),
    ).toEqual([]);
  });

  it('never reports a name the endpoint publishes under both cadences', () => {
    // weather_code and sunshine_duration are documented as hourly AND daily.
    expect(
      findCadenceMismatches(
        FORECAST_CADENCE,
        ['weather_code', 'sunshine_duration'],
        ['weather_code', 'sunshine_duration'],
      ),
    ).toEqual([]);
  });

  it('reports every offender in one pass so the caller converges in a single retry', () => {
    const mismatches = findCadenceMismatches(
      FORECAST_CADENCE,
      ['precipitation_sum'],
      ['cloud_cover'],
    );

    expect(mismatches.map((m) => m.variable)).toEqual(['precipitation_sum', 'cloud_cover']);
  });

  it('uses a per-endpoint catalog: temperature_2m_max is hourly on the ensemble API', () => {
    // The ensemble endpoint publishes it as a 3-hourly aggregation; the forecast
    // endpoint publishes it under daily only. A shared catalog would reject a valid
    // ensemble request.
    expect(findCadenceMismatches(ENSEMBLE_CADENCE, ['temperature_2m_max'], undefined)).toEqual([]);
    expect(findCadenceMismatches(FORECAST_CADENCE, ['temperature_2m_max'], undefined)).toHaveLength(
      1,
    );
  });

  it('covers the marine and archive catalogs in both directions', () => {
    expect(
      findCadenceMismatches(MARINE_CADENCE, ['wave_height_max'], ['wave_height']).map(
        (m) => m.variable,
      ),
    ).toEqual(['wave_height_max', 'wave_height']);
    expect(
      findCadenceMismatches(HISTORICAL_CADENCE, ['temperature_2m_max'], ['temperature_2m']).map(
        (m) => m.variable,
      ),
    ).toEqual(['temperature_2m_max', 'temperature_2m']);
  });

  it('returns nothing when both fields are omitted', () => {
    expect(findCadenceMismatches(FORECAST_CADENCE, undefined, undefined)).toEqual([]);
  });
});

describe('describeCadenceMismatches', () => {
  it('names the value, the field it arrived in, and the field it belongs in', () => {
    const text = describeCadenceMismatches(
      findCadenceMismatches(FORECAST_CADENCE, undefined, ['cloud_cover']),
    );

    expect(text).toContain('cloud_cover is not valid in daily_variables');
    expect(text).toContain('Move it to hourly_variables');
  });

  it('offers the same-cadence aggregates so a caller who wanted daily can stay daily', () => {
    const text = describeCadenceMismatches(
      findCadenceMismatches(FORECAST_CADENCE, undefined, ['cloud_cover']),
    );

    expect(text).toContain('cloud_cover_max');
    expect(text).toContain('cloud_cover_mean');
    expect(text).toContain('cloud_cover_min');
  });

  it('offers the base variable for a misplaced aggregate', () => {
    const text = describeCadenceMismatches(
      findCadenceMismatches(FORECAST_CADENCE, ['temperature_2m_max'], undefined),
    );

    expect(text).toContain('temperature_2m_max is not valid in hourly_variables');
    expect(text).toContain('Move it to daily_variables');
    expect(text).toContain('temperature_2m');
  });

  it('falls back to "or remove it" when the endpoint publishes no counterpart', () => {
    const text = describeCadenceMismatches(
      findCadenceMismatches(FORECAST_CADENCE, ['sunrise'], undefined),
    );

    expect(text).toBe(
      'sunrise is not valid in hourly_variables — Open-Meteo publishes it as a daily variable. Move it to daily_variables or remove it.',
    );
  });
});

describe('undefinedUnitColumns', () => {
  it('flags a column whose unit came back as the literal string "undefined"', () => {
    expect(
      undefinedUnitColumns({
        time: 'iso8601',
        temperature_2m: '°C',
        temperature_2m_max: 'undefined',
      }),
    ).toEqual(['temperature_2m_max']);
  });

  it('does not flag dimensionless variables, which carry an empty unit', () => {
    expect(undefinedUnitColumns({ time: 'iso8601', is_day: '', uv_index: '' })).toEqual([]);
  });

  it('handles an absent units map', () => {
    expect(undefinedUnitColumns(undefined)).toEqual([]);
  });

  it('reports across both cadence maps in argument order', () => {
    expect(
      undefinedUnitColumns(
        { time: 'iso8601', temperature_2m: '°C', pm2_5: 'undefined' },
        { time: 'iso8601', wave_height_max: 'undefined' },
      ),
    ).toEqual(['pm2_5', 'wave_height_max']);
  });
});
