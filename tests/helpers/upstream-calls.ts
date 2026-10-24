/**
 * @fileoverview One minimal valid call per tool that calls Open-Meteo, shared by the
 * wire-level contract suites that drive every upstream-calling tool through the real
 * service with only `fetch` stubbed.
 * @module tests/helpers/upstream-calls
 */

import * as definitions from '@/mcp-server/tools/definitions/index.js';

const point = { latitude: 47.6, longitude: -122.3 };

/** A minimal valid call per upstream-calling tool — each reaches the service unchanged. */
export const UPSTREAM_CALLS = [
  { tool: definitions.openmeteoSearchLocationsTool, input: { name: 'Seattle' } },
  {
    tool: definitions.openmeteoGetForecastTool,
    input: { ...point, hourly_variables: ['temperature_2m'] },
  },
  {
    tool: definitions.openmeteoGetHistoricalTool,
    input: {
      ...point,
      start_date: '2024-07-01',
      end_date: '2024-07-02',
      daily_variables: ['temperature_2m_max'],
    },
  },
  {
    tool: definitions.openmeteoGetMarineTool,
    input: { latitude: 47.8, longitude: -122.5, hourly_variables: ['wave_height'] },
  },
  {
    tool: definitions.openmeteoGetAirQualityTool,
    input: { ...point, hourly_variables: ['pm2_5'] },
  },
  {
    tool: definitions.openmeteoGetElevationTool,
    input: { latitudes: [47.6], longitudes: [-122.3] },
  },
  {
    tool: definitions.openmeteoGetEnsembleTool,
    input: { ...point, hourly_variables: ['temperature_2m'] },
  },
  {
    tool: definitions.openmeteoGetFloodTool,
    input: { ...point, daily_variables: ['river_discharge'] },
  },
  {
    tool: definitions.openmeteoGetClimateTool,
    input: {
      ...point,
      start_date: '2049-01-01',
      end_date: '2049-01-05',
      daily_variables: ['temperature_2m_max'],
    },
  },
] as const;
