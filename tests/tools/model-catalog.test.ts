/**
 * @fileoverview Tests for the documented model catalogs and the climate models
 * isolation. Upstream reason strings are the live shapes the endpoints return.
 * @module tests/tools/model-catalog.test
 */

import { describe, expect, it } from 'vitest';
import {
  CLIMATE_MODEL_LIST,
  CLIMATE_MODELS,
  describeUnknownClimateModels,
  ENSEMBLE_MODEL_LIST,
  ENSEMBLE_MODEL_NAMES,
  ENSEMBLE_MODELS,
  isolateUnknownClimateModels,
} from '@/mcp-server/tools/model-catalog.js';

/** The live rejection shape: the whole percent-encoded models list echoed as one value. */
const rejects = (value: string) =>
  `Data corrupted at path ''. Cannot initialize MultiDomains from invalid String value ${value}.`;

describe('isolateUnknownClimateModels', () => {
  it('names only the undocumented model out of a rejected list of valid ones (#31)', () => {
    const requested = ['MRI_AGCM3_2_S', 'BOGUS_MODEL', 'EC_Earth3P_HR'];
    expect(isolateUnknownClimateModels(requested, rejects(requested.join(',')))).toEqual([
      'BOGUS_MODEL',
    ]);
  });

  it('names a lone rejected model', () => {
    expect(isolateUnknownClimateModels(['BOGUS_MODEL'], rejects('BOGUS_MODEL'))).toEqual([
      'BOGUS_MODEL',
    ]);
  });

  it('names every undocumented model when a request carries more than one', () => {
    const requested = ['BOGUS_ONE', 'MRI_AGCM3_2_S', 'BOGUS_TWO'];
    expect(isolateUnknownClimateModels(requested, rejects(requested.join(',')))).toEqual([
      'BOGUS_ONE',
      'BOGUS_TWO',
    ]);
  });

  it('stays silent when the echoed value is a variable list, not the models list', () => {
    // The guard that keeps a rejected variable from being blamed on a model: the
    // echoed value must be exactly the requested models, in order.
    const reason =
      "Data corrupted at path ''. Cannot initialize ForecastVariableDaily from invalid String value bogus_var.";
    expect(isolateUnknownClimateModels(['MRI_AGCM3_2_S', 'UNDOCUMENTED'], reason)).toEqual([]);
  });

  it('stays silent when every requested model is documented', () => {
    // Upstream rejected for some other reason — naming a documented model would be a
    // guess, so the caller gets the generic framing instead.
    const requested = ['MRI_AGCM3_2_S', 'EC_Earth3P_HR'];
    expect(isolateUnknownClimateModels(requested, rejects(requested.join(',')))).toEqual([]);
  });

  it('stays silent when no models were requested, or the message has another shape', () => {
    expect(isolateUnknownClimateModels(undefined, rejects('anything'))).toEqual([]);
    expect(isolateUnknownClimateModels([], rejects('anything'))).toEqual([]);
    expect(isolateUnknownClimateModels(['MRI_AGCM3_2_S'], 'Invalid date')).toEqual([]);
    expect(isolateUnknownClimateModels(['MRI_AGCM3_2_S'], undefined)).toEqual([]);
  });
});

describe('describeUnknownClimateModels', () => {
  it('names the offender, the documented set, and the raw upstream text', () => {
    const raw = rejects('MRI_AGCM3_2_S,BOGUS_MODEL');
    const message = describeUnknownClimateModels(['BOGUS_MODEL'], raw);

    expect(message).toMatch(/^Unknown climate model name: BOGUS_MODEL\./);
    expect(message).toContain('this one is');
    expect(message).toContain(CLIMATE_MODEL_LIST);
    expect(message).toContain(`(Upstream: ${raw})`);
  });

  it('pluralizes for more than one offender', () => {
    const message = describeUnknownClimateModels(['BOGUS_ONE', 'BOGUS_TWO'], rejects('x'));

    expect(message).toMatch(/^Unknown climate model names: BOGUS_ONE, BOGUS_TWO\./);
    expect(message).toContain('these are');
  });
});

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
