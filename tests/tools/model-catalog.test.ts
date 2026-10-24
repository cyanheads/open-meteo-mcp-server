/**
 * @fileoverview Tests for the documented model catalogs.
 * @module tests/tools/model-catalog.test
 */

import { describe, expect, it } from 'vitest';
import {
  CLIMATE_MODEL_LIST,
  CLIMATE_MODELS,
  DEFAULT_ENSEMBLE_MODEL,
  ENSEMBLE_MODEL_LIST,
  ENSEMBLE_MODEL_NAMES,
  ENSEMBLE_MODELS,
  FLOOD_MODEL_LIST,
  FLOOD_MODEL_NAMES,
  FLOOD_MODELS,
  FORECAST_MODEL_NAMES,
  FORECAST_MODELS,
} from '@/mcp-server/tools/model-catalog.js';

describe('catalog contents', () => {
  it('publishes the seven documented CMIP6 models', () => {
    expect(CLIMATE_MODELS).toHaveLength(7);
    expect(CLIMATE_MODELS).toContain('MRI_AGCM3_2_S');
    expect(CLIMATE_MODELS).toContain('NICAM16_8S');
  });

  it('publishes the ensemble models the docs page emits, not the retired short names', () => {
    const names = ENSEMBLE_MODELS.map((m) => m.name);
    expect(names).toContain('ecmwf_ifs025_ensemble');
    expect(names).toContain('ecmwf_aifs025_ensemble');
    expect(names).toContain('ukmo_global_ensemble_20km');
    expect(names).toContain('google_weathernext2_ensemble');
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps each ensemble member count and coverage flag in step with its advertised note (#74)', () => {
    for (const model of ENSEMBLE_MODELS) {
      // The note leads with the count, or a range whose upper bound is the count.
      const [, low, high] = /^(\d+)(?:–(\d+))?/.exec(model.note) ?? [];
      expect(Number(high ?? low), model.name).toBe(model.members);
      expect(model.regional === true, model.name).toBe(!model.note.includes('global'));
    }
  });

  it('defaults the ensemble tool to a documented global model (#73)', () => {
    const model = ENSEMBLE_MODELS.find((m) => m.name === DEFAULT_ENSEMBLE_MODEL);
    expect(model).toMatchObject({ name: 'ecmwf_ifs025_ensemble', members: 51 });
    expect(model?.regional).toBeUndefined();
  });

  it('renders the advertised lists the tool descriptions splice in', () => {
    expect(ENSEMBLE_MODEL_LIST).toContain('ecmwf_ifs025_ensemble (51 members, global 0.25°)');
    expect(ENSEMBLE_MODEL_NAMES).toContain('gem_global_ensemble');
    expect(ENSEMBLE_MODEL_NAMES).not.toContain('(');
    expect(CLIMATE_MODEL_LIST.split(', ')).toEqual([...CLIMATE_MODELS]);
    expect(FORECAST_MODEL_NAMES.split(', ')).toEqual([...FORECAST_MODELS]);
  });

  it('publishes the 57 deterministic models the forecast docs page emits (#80)', () => {
    expect(FORECAST_MODELS).toHaveLength(57);
    expect(new Set(FORECAST_MODELS).size).toBe(FORECAST_MODELS.length);
    expect(FORECAST_MODELS[0]).toBe('best_match');
    // The published, provider-prefixed spellings — the older short ones still resolve upstream.
    for (const name of [
      'ncep_gfs_seamless',
      'dwd_icon_seamless',
      'cmc_gem_seamless',
      'ecmwf_ifs025',
    ]) {
      expect(FORECAST_MODELS).toContain(name);
    }
    expect(FORECAST_MODELS).not.toContain('gfs_seamless');
  });

  it('publishes the three GloFAS v4 models with their spans, seamless_v4 first as the default (#79)', () => {
    expect(FLOOD_MODELS.map((m) => m.name)).toEqual([
      'seamless_v4',
      'consolidated_v4',
      'forecast_v4',
    ]);
    // The frozen v3 dataset passes through upstream but is not advertised.
    expect(FLOOD_MODEL_NAMES).toBe('seamless_v4, consolidated_v4, forecast_v4');
    expect(FLOOD_MODEL_LIST).toContain(
      'seamless_v4 (default — consolidated_v4 reanalysis before 2023-08-05, forecast_v4 runs from 2023-08-05 into the live forecast)',
    );
    expect(FLOOD_MODEL_LIST).toContain('consolidated_v4 (reanalysis from 1984 through 2025-05-31');
    expect(FLOOD_MODEL_LIST).toContain('forecast_v4 (forecast runs from 2023-06-01');
  });
});
