/**
 * @fileoverview Per-tool wiring for `cell_selection` on the four tools whose endpoints
 * answer from a land cell by default: forecast, historical, ensemble, and climate. Each
 * call runs through `runToolContract` over the real service with only `fetch` stubbed, so
 * the input schema, the handler pass-through, and the URL builder are under test
 * together. The parameter itself is tabled in tests/services/open-meteo-service.test.ts.
 * @module tests/tools/cell-selection.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as definitions from '@/mcp-server/tools/definitions/index.js';
import { initOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';
import type { WireError } from '../helpers/wire-error.js';

const fetchMock = vi.fn();

/** The requested URLs, in call order. */
const requestedUrls = (): string[] => fetchMock.mock.calls.map(([url]) => String(url));

/** Off Half Moon Bay, where the land and sea cells answer different winds. */
const point = { latitude: 37.49, longitude: -122.5 };

const envelope = {
  latitude: 37.5,
  longitude: -122.25,
  elevation: 0,
  timezone: 'GMT',
  utc_offset_seconds: 0,
};

/**
 * One call per tool that takes `cell_selection`, the body its endpoint answers with, and
 * the exact URL that call sends with `cell_selection` omitted.
 */
const CALLS = [
  {
    tool: definitions.openmeteoGetForecastTool,
    input: { ...point, hourly_variables: ['wind_speed_10m'] },
    body: {
      ...envelope,
      hourly_units: { time: 'iso8601', wind_speed_10m: 'km/h' },
      hourly: { time: ['2026-11-10T00:00'], wind_speed_10m: [14.2] },
    },
    omittedUrl:
      'https://api.open-meteo.com/v1/forecast?latitude=37.49&longitude=-122.5&hourly=wind_speed_10m&forecast_days=7&past_days=0&temperature_unit=celsius&wind_speed_unit=kmh&precipitation_unit=mm&timezone=auto',
  },
  {
    tool: definitions.openmeteoGetHistoricalTool,
    input: {
      ...point,
      start_date: '2024-01-10',
      end_date: '2024-01-10',
      hourly_variables: ['wind_speed_10m'],
      models: ['era5'],
    },
    body: {
      ...envelope,
      hourly_units: { time: 'iso8601', wind_speed_10m: 'km/h' },
      hourly: { time: ['2024-01-10T00:00'], wind_speed_10m: [14.2] },
    },
    omittedUrl:
      'https://archive-api.open-meteo.com/v1/archive?latitude=37.49&longitude=-122.5&hourly=wind_speed_10m&models=era5&start_date=2024-01-10&end_date=2024-01-10&temperature_unit=celsius&wind_speed_unit=kmh&precipitation_unit=mm&timezone=auto',
  },
  {
    tool: definitions.openmeteoGetEnsembleTool,
    input: { ...point, hourly_variables: ['wind_speed_10m'] },
    body: {
      ...envelope,
      hourly_units: { time: 'iso8601', wind_speed_10m: 'km/h', wind_speed_10m_member01: 'km/h' },
      hourly: {
        time: ['2026-11-10T00:00'],
        wind_speed_10m: [14.2],
        wind_speed_10m_member01: [15.1],
      },
    },
    omittedUrl:
      'https://ensemble-api.open-meteo.com/v1/ensemble?latitude=37.49&longitude=-122.5&hourly=wind_speed_10m&models=ecmwf_ifs025_ensemble&forecast_days=7&past_days=0&temperature_unit=celsius&wind_speed_unit=kmh&precipitation_unit=mm&timezone=auto',
  },
  {
    tool: definitions.openmeteoGetClimateTool,
    input: {
      ...point,
      start_date: '2024-01-10',
      end_date: '2024-01-10',
      daily_variables: ['wind_speed_10m_mean'],
    },
    body: {
      ...envelope,
      daily_units: { time: 'iso8601', wind_speed_10m_mean: 'km/h' },
      daily: { time: ['2024-01-10'], wind_speed_10m_mean: [5.1] },
    },
    omittedUrl:
      'https://climate-api.open-meteo.com/v1/climate?latitude=37.49&longitude=-122.5&start_date=2024-01-10&end_date=2024-01-10&daily=wind_speed_10m_mean&temperature_unit=celsius&wind_speed_unit=kmh&precipitation_unit=mm&timezone=auto',
  },
] as const;

/** The three tools whose endpoints already default to the cell their data needs. */
const WITHOUT_CELL_SELECTION = [
  {
    tool: definitions.openmeteoGetMarineTool,
    input: { ...point, hourly_variables: ['wave_height'] },
  },
  {
    tool: definitions.openmeteoGetAirQualityTool,
    input: { ...point, hourly_variables: ['pm2_5'] },
  },
  {
    tool: definitions.openmeteoGetFloodTool,
    input: { ...point, daily_variables: ['river_discharge'] },
  },
] as const;

type AnyDefinition = Parameters<typeof runToolContract>[0];

/** Runs `tool` with `input` through the production-shaped pipeline. */
const call = (tool: AnyDefinition, input: Record<string, unknown>) =>
  runToolContract(tool, input as Parameters<typeof runToolContract>[1]);

describe('cell_selection wiring (#93)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    initOpenMeteoService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(CALLS)(
    '$tool.name sends the request it sends today when cell_selection is omitted',
    async ({ tool, input, body, omittedUrl }) => {
      fetchMock.mockImplementation(() => Promise.resolve(Response.json(body)));

      const result = await call(tool, input);

      expect(result.isError).toBeFalsy();
      expect(requestedUrls()).toEqual([omittedUrl]);
    },
  );

  it.each(
    CALLS.flatMap((toolCall) =>
      (['land', 'sea', 'nearest'] as const).map((cell) => ({ ...toolCall, cell })),
    ),
  )(
    '$tool.name sends cell_selection=$cell once, beside an otherwise unchanged request',
    async ({ tool, input, body, omittedUrl, cell }) => {
      fetchMock.mockImplementation(() => Promise.resolve(Response.json(body)));

      const result = await call(tool, { ...input, cell_selection: cell });

      expect(result.isError).toBeFalsy();
      expect(requestedUrls()).toEqual([
        omittedUrl.replace('&timezone=auto', `&cell_selection=${cell}&timezone=auto`),
      ]);
    },
  );

  it.each(CALLS)(
    '$tool.name rejects a cell_selection outside land, sea, and nearest before any request',
    async ({ tool, input }) => {
      const result = await call(tool, { ...input, cell_selection: 'ocean' });

      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: WireError }).error;
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.message).toContain('cell_selection');
      expect(error.message).not.toContain('Unrecognized key');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    definitions.openmeteoGetForecastTool,
    definitions.openmeteoGetHistoricalTool,
    definitions.openmeteoGetEnsembleTool,
  ])('$name describes its output coordinate as the cell that answered', (tool) => {
    expect(tool.output.shape.latitude.description).toMatch(
      /^Latitude of the grid cell that answered, picked by cell_selection \(a land cell when omitted\)/,
    );
    expect(tool.output.shape.longitude.description).toMatch(
      /^Longitude of the grid cell that answered/,
    );
  });

  it.each(WITHOUT_CELL_SELECTION)(
    '$tool.name rejects cell_selection by name and sends nothing',
    async ({ tool, input }) => {
      const result = await call(tool, { ...input, cell_selection: 'sea' });

      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: WireError }).error;
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.message).toContain('Unrecognized key: "cell_selection"');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
