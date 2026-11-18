/**
 * @fileoverview Tests for the coverage-gap recovery sentence, per endpoint and, on marine,
 * per the models a call sent.
 * @module tests/services/coverage-gap.test
 */

import { describe, expect, it } from 'vitest';
import {
  coverageGapRecovery,
  MARINE_NO_WAVE_DATA,
  type OpenMeteoOperation,
} from '@/services/open-meteo/coverage-gap.js';

const SWITCH_MODELS =
  "Switch to a model whose domain includes this coordinate (any global model does), or omit models to use the tool's global default. Retrying returns the same response.";
const grid = (dataset: string) =>
  `The ${dataset} dataset's grid does not cover this coordinate — request a point inside its coverage. Retrying returns the same response.`;

describe('coverageGapRecovery', () => {
  it.each([
    ['forecast', undefined, SWITCH_MODELS],
    ['forecast', ['icon_d2'], SWITCH_MODELS],
    ['historical', ['cerra'], SWITCH_MODELS],
    ['ensemble', undefined, SWITCH_MODELS],
    ['climate', undefined, SWITCH_MODELS],
    ['flood', ['seamless_v4'], grid('flood')],
    ['air-quality', undefined, grid('air-quality')],
  ] as const)('words %s with models %j as before', (operation, models, expected) => {
    expect(coverageGapRecovery(operation as OpenMeteoOperation, models)).toBe(expected);
  });

  /*
   * Live at −90, 0: models=ewam is a coverage gap, every global wave model returns
   * all-null columns, and omitting models is a coverage gap too. At −60, 0 the default
   * blend returns all nulls where ecmwf_wam returns values. So no marine sentence claims a
   * global model or the default blend reaches the point.
   */
  it('words marine with models omitted by the likelier cause first: land or sea ice, then the blend', () => {
    const recovery = coverageGapRecovery('marine');
    expect(recovery).toBe(
      'A point on land or under sea ice has no wave data from any model, so there the remedy is a coordinate in open water. For a point in open water, name a model in models: the default blend has gaps a single wave model can fill. Retrying returns the same response.',
    );
    expect(coverageGapRecovery('marine', [])).toBe(recovery);
  });

  it.each([
    [
      'without the default blend',
      ['ewam'],
      'Name another model, or omit models to read the default blend.',
    ],
    [
      'naming the default blend',
      ['best_match'],
      'Name other models: best_match, the default blend, missed this coordinate too, so omitting models will not reach it.',
    ],
    [
      'naming the default blend beside another model',
      ['best_match', 'ewam'],
      'Name other models: best_match, the default blend, missed this coordinate too, so omitting models will not reach it.',
    ],
  ])('words marine with models %s by the move that call can make', (_, models, remedy) => {
    const recovery = coverageGapRecovery('marine', models);
    expect(recovery).toBe(`${remedy} ${MARINE_NO_WAVE_DATA} Retrying returns the same response.`);
    expect(recovery).not.toMatch(/global|grid does not cover/);
  });

  it('sends a point no wave model covers to open water', () => {
    expect(MARINE_NO_WAVE_DATA).toBe(
      'A point on land or under sea ice has no wave data from any model, so there the remedy is a coordinate in open water.',
    );
  });
});
