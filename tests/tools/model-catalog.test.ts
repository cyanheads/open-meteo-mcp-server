/**
 * @fileoverview Tests for the documented model catalogs.
 * @module tests/tools/model-catalog.test
 */

import { describe, expect, it } from 'vitest';
import {
  CLIMATE_MODEL_LIST,
  CLIMATE_MODELS,
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

  it('renders the advertised lists the tool descriptions splice in', () => {
    expect(ENSEMBLE_MODEL_LIST).toContain('ecmwf_ifs025_ensemble (51 members, global 0.25°)');
    expect(ENSEMBLE_MODEL_NAMES).toContain('gem_global_ensemble');
    expect(ENSEMBLE_MODEL_NAMES).not.toContain('(');
    expect(CLIMATE_MODEL_LIST.split(', ')).toEqual([...CLIMATE_MODELS]);
  });
});
