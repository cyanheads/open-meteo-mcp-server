/**
 * @fileoverview Stand-in for the Open-Meteo service module in which every weather method
 * is one shared spy, so a test can tell whether a tool call got past argument handling
 * and read the params the handler built. Install it with
 * `vi.mock('@/services/open-meteo/open-meteo-service.js', () => import('../helpers/upstream-spy.js'))`.
 * @module tests/helpers/upstream-spy
 */

import { type Mock, vi } from 'vitest';

/** The one spy behind every service method — any call at all means the handler went upstream. */
export const upstream: Mock = vi.fn();

const METHODS = [
  'getForecast',
  'getHistorical',
  'getMarine',
  'getAirQuality',
  'getEnsemble',
  'getFlood',
  'getClimate',
];

export const getOpenMeteoService = (): Record<string, Mock> =>
  Object.fromEntries(METHODS.map((method) => [method, upstream]));
