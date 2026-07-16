/**
 * @fileoverview Tests for reshape utilities — columnar-to-per-timestamp reshape correctness.
 * @module tests/services/open-meteo-service.test
 */

import { describe, expect, it } from 'vitest';
import { formatRecord, formatUnits, reshapeColumnar } from '@/mcp-server/tools/reshape-utils.js';

describe('reshapeColumnar', () => {
  it('zips time and variable arrays into per-timestamp records', () => {
    const result = reshapeColumnar({
      time: ['2026-05-30T00:00', '2026-05-30T01:00'],
      temperature_2m: [10.1, 9.4],
      precipitation: [0.0, 0.5],
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      time: '2026-05-30T00:00',
      temperature_2m: 10.1,
      precipitation: 0.0,
    });
    expect(result[1]).toEqual({
      time: '2026-05-30T01:00',
      temperature_2m: 9.4,
      precipitation: 0.5,
    });
  });

  it('preserves null values in arrays (e.g. ocean_current_velocity inland)', () => {
    const result = reshapeColumnar({
      time: ['2026-05-30T00:00'],
      ocean_current_velocity: [null],
    });

    expect(result[0]).toEqual({ time: '2026-05-30T00:00', ocean_current_velocity: null });
  });

  it('handles a single-element block', () => {
    const result = reshapeColumnar({
      time: ['2026-05-30'],
      temperature_2m_max: [15.9],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ time: '2026-05-30', temperature_2m_max: 15.9 });
  });

  it('units are NOT included in records — they live in the units map', () => {
    const result = reshapeColumnar({
      time: ['2026-05-30T00:00'],
      temperature_2m: [10.1],
    });
    expect(result[0]).not.toHaveProperty('unit');
    expect(result[0]).not.toHaveProperty('temperature_2m_unit');
  });

  it('exact parallel alignment across four variables × three timestamps', () => {
    // The central correctness risk: variable[i] must map to time[i] for every variable.
    const result = reshapeColumnar({
      time: ['T0', 'T1', 'T2'],
      var_a: [100, 200, 300],
      var_b: [10, 20, 30],
      var_c: [1, 2, 3],
      var_d: [0.1, 0.2, 0.3],
    });

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ time: 'T0', var_a: 100, var_b: 10, var_c: 1, var_d: 0.1 });
    expect(result[1]).toEqual({ time: 'T1', var_a: 200, var_b: 20, var_c: 2, var_d: 0.2 });
    expect(result[2]).toEqual({ time: 'T2', var_a: 300, var_b: 30, var_c: 3, var_d: 0.3 });
  });

  it('null in the middle of an array aligns correctly with adjacent real values', () => {
    // A mid-array null for one variable should not shift subsequent values.
    const result = reshapeColumnar({
      time: ['T0', 'T1', 'T2'],
      wave_height: [1.0, null, 3.0],
      wave_period: [8.0, 8.5, 9.0],
    });

    expect(result[0]).toEqual({ time: 'T0', wave_height: 1.0, wave_period: 8.0 });
    expect(result[1]).toEqual({ time: 'T1', wave_height: null, wave_period: 8.5 });
    expect(result[2]).toEqual({ time: 'T2', wave_height: 3.0, wave_period: 9.0 });
  });

  it('all-null variable produces null at every position', () => {
    const result = reshapeColumnar({
      time: ['T0', 'T1'],
      ocean_current_velocity: [null, null],
      wave_height: [1.0, 2.0],
    });

    expect(result[0]?.ocean_current_velocity).toBeNull();
    expect(result[1]?.ocean_current_velocity).toBeNull();
    // The other variable is unaffected
    expect(result[0]?.wave_height).toBe(1.0);
    expect(result[1]?.wave_height).toBe(2.0);
  });

  it('time-only block (no variables) produces records with only the time field', () => {
    // Edge case: the API should never send this, but reshapeColumnar must not crash.
    const result = reshapeColumnar({ time: ['T0', 'T1'] });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ time: 'T0' });
    expect(result[1]).toEqual({ time: 'T1' });
  });
});

describe('formatUnits', () => {
  it('formats a units map as a readable string', () => {
    const out = formatUnits({ time: 'iso8601', temperature_2m: '°C', precipitation: 'mm' });
    expect(out).toBe('time: iso8601 | temperature_2m: °C | precipitation: mm');
  });

  it('returns empty string for undefined', () => {
    expect(formatUnits(undefined)).toBe('');
  });

  it('includes the time key in the formatted string (#24)', () => {
    // Upstream gives time a real unit (iso8601) and structuredContent.*_units keeps
    // it — dropping it here left content[] carrying an incomplete units map for
    // text-only clients.
    const out = formatUnits({ time: 'iso8601', pm2_5: 'μg/m³' });
    expect(out).toContain('time: iso8601');
    expect(out).toContain('pm2_5: μg/m³');
  });

  it('formats a map with no time entry unchanged', () => {
    expect(formatUnits({ river_discharge: 'm³/s' })).toBe('river_discharge: m³/s');
  });
});

describe('formatRecord', () => {
  it('renders time as the leading label and omits it from the variable list', () => {
    // formatRecord's time exclusion is unrelated to formatUnits' — a record's
    // timestamp is already its leading label, so repeating it in the per-variable
    // listing would be redundant. A units map has no such leading label, which is
    // why the two functions treat `time` differently.
    expect(formatRecord({ time: '2024-07-01T00:00', temperature_2m: 18, precipitation: 0 })).toBe(
      '**2024-07-01T00:00** — temperature_2m: 18 | precipitation: 0',
    );
  });

  it('renders null values explicitly rather than dropping them', () => {
    expect(formatRecord({ time: '2024-07-01', river_discharge: null })).toBe(
      '**2024-07-01** — river_discharge: null',
    );
  });
});
