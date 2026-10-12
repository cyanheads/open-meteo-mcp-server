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
  });
});
