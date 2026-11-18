/**
 * @fileoverview The `current_multi_model` guard shared by the forecast and marine tools,
 * tabled once here; each tool's own test proves only its wiring.
 * @module tests/tools/current-input.test
 */

import { describe, expect, it } from 'vitest';
import { currentMultiModelMessage } from '@/mcp-server/tools/current-input.js';

const TAIL =
  'Open-Meteo answers current conditions from a single model — the first listed one that covers the coordinate — in one unsuffixed block, so the values would not say which model produced them. Send current_variables with one model or none, and compare models through hourly_variables or daily_variables.';

describe('currentMultiModelMessage', () => {
  it.each([
    ['no current block', undefined, ['ecmwf_ifs025', 'ncep_gfs_seamless']],
    ['an empty current list', [], ['ecmwf_ifs025', 'ncep_gfs_seamless']],
    ['no models', ['temperature_2m'], undefined],
    ['an empty models list', ['temperature_2m'], []],
    ['one model', ['temperature_2m'], ['ecmwf_ifs025']],
    // One model named twice is still one model: its current block is attributable.
    ['one model named twice', ['wave_height'], ['ecmwf_wam', 'ecmwf_wam']],
  ] as const)('allows %s', (_label, current, models) => {
    expect(currentMultiModelMessage(current, models)).toBeUndefined();
  });

  it('counts and names each distinct model once', () => {
    expect(
      currentMultiModelMessage(['wave_height'], ['ecmwf_wam', 'ncep_gfswave016', 'ecmwf_wam']),
    ).toBe(
      `current_variables cannot be combined with 2 models (ecmwf_wam, ncep_gfswave016): ${TAIL}`,
    );
  });

  it('names the count and the models, in request order, for two', () => {
    expect(currentMultiModelMessage(['wave_height'], ['ecmwf_wam', 'ncep_gfswave016'])).toBe(
      `current_variables cannot be combined with 2 models (ecmwf_wam, ncep_gfswave016): ${TAIL}`,
    );
  });

  it('names every model for three', () => {
    expect(
      currentMultiModelMessage(
        ['temperature_2m', 'precipitation'],
        ['ncep_gfs_seamless', 'ecmwf_ifs025', 'dwd_icon_seamless'],
      ),
    ).toBe(
      `current_variables cannot be combined with 3 models (ncep_gfs_seamless, ecmwf_ifs025, dwd_icon_seamless): ${TAIL}`,
    );
  });
});
