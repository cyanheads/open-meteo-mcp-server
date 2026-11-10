/**
 * @fileoverview Wire-level wiring of `isDateOutOfRangeReason()` in the five tools that
 * send a date range upstream. Each runs through `runToolContract` over the real service
 * with only `fetch` stubbed, answering HTTP 400 with an Open-Meteo error envelope, so
 * the service's envelope pass-through, the handler's branch order, and the boundary's
 * fill of the declared recovery are all under test. One date rejection and one
 * unknown-name rejection per tool; the predicate's full value table lives in
 * `upstream-error.test.ts`.
 * @module tests/tools/date-rejection.test
 */

import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as definitions from '@/mcp-server/tools/definitions/index.js';
import { initOpenMeteoService } from '@/services/open-meteo/open-meteo-service.js';
import { firstText } from '../helpers/content.js';
import type { WireError } from '../helpers/wire-error.js';

vi.mock('@/config/server-config.js', () => import('../helpers/marker-config.js'));

const fetchMock = vi.fn();

type AnyDefinition = Parameters<typeof runToolContract>[0];
type AnyInput = Parameters<typeof runToolContract>[1];

const envelope = (reason: string) =>
  new Response(JSON.stringify({ error: true, reason }), { status: 400 });

function dateEntry(tool: AnyDefinition): ErrorContract | undefined {
  return ((tool.errors ?? []) as readonly ErrorContract[]).find(
    (entry) => entry.reason === 'date_out_of_range',
  );
}

/** Calls `tool` against one upstream 400 envelope; returns its error envelope and content text. */
async function rejectedWith(tool: AnyDefinition, input: AnyInput, reason: string) {
  fetchMock.mockImplementation(() => Promise.resolve(envelope(reason)));
  const result = await runToolContract(tool, input);
  expect(result.isError).toBe(true);
  return {
    error: (result.structuredContent as { error: WireError }).error,
    text: firstText(result.content),
  };
}

const point = { latitude: 42.03, longitude: -93.62 };

/** A date rejection per tool, each the wording that endpoint sends for that input. */
const DATE_CASES = [
  {
    tool: definitions.openmeteoGetHistoricalTool,
    input: {
      ...point,
      start_date: '2026-11-01',
      end_date: '2027-01-01',
      daily_variables: ['temperature_2m_max'],
    },
    reason: "Parameter 'end_date' is out of allowed range from 1940-01-01 to 2026-11-10",
  },
  {
    tool: definitions.openmeteoGetClimateTool,
    input: {
      ...point,
      start_date: '2049-01-01',
      end_date: '2049-01-05',
      daily_variables: ['temperature_2m_max'],
    },
    reason: 'Invalid date',
  },
  {
    tool: definitions.openmeteoGetFloodTool,
    input: {
      latitude: 48.425,
      longitude: -122.375,
      start_date: '2026-11-01',
      end_date: '2028-01-01',
      daily_variables: ['river_discharge'],
    },
    reason: "Parameter 'end_date' is out of allowed range from 1984-01-01 to 2027-11-10",
  },
  {
    tool: definitions.openmeteoGetMarineTool,
    input: {
      latitude: 33.6,
      longitude: -118.2,
      start_date: '1900-01-01',
      end_date: '1900-01-02',
      hourly_variables: ['wave_height'],
    },
    reason: "Parameter 'start_date' is out of allowed range from 1940-01-01 to 2026-11-25",
  },
  {
    tool: definitions.openmeteoGetAirQualityTool,
    input: {
      latitude: 47.6,
      longitude: -122.33,
      start_date: '2026-11-01',
      end_date: '2028-01-01',
      hourly_variables: ['pm2_5'],
    },
    reason: "Parameter 'end_date' is out of allowed range from 2013-01-01 to 2026-11-16",
  },
] as const;

/**
 * An unknown-name rejection per tool whose quoted name contains "range" or "date". The
 * historical, climate, and flood reasons are verbatim; marine and air quality use the
 * same unknown-name shape with their own offender.
 */
const NAME_CASES = [
  {
    tool: definitions.openmeteoGetHistoricalTool,
    input: {
      ...point,
      start_date: '2020-06-01',
      end_date: '2020-06-02',
      daily_variables: ['temperature_2m_range'],
    },
    reason:
      'Invalid value: Cannot initialize ForecastVariableDaily from invalid String value temperature_2m_range',
    message: /^Unknown variable or model name: temperature_2m_range\./,
  },
  {
    tool: definitions.openmeteoGetHistoricalTool,
    input: {
      ...point,
      start_date: '2020-06-01',
      end_date: '2020-06-02',
      daily_variables: ['precipitation_sum'],
      models: ['era5_update'],
    },
    reason: 'Invalid value: Cannot initialize MultiDomains from invalid String value era5_update',
    message: /^Unknown variable or model name: era5_update\./,
  },
  {
    tool: definitions.openmeteoGetClimateTool,
    input: {
      ...point,
      start_date: '2020-06-01',
      end_date: '2020-06-02',
      daily_variables: ['temperature_2m_max'],
      models: ['mri_update'],
    },
    reason: 'Invalid value: Cannot initialize MultiDomains from invalid String value mri_update',
    message: /^Unknown variable or model name: mri_update\./,
  },
  {
    tool: definitions.openmeteoGetFloodTool,
    input: {
      latitude: 48.425,
      longitude: -122.375,
      forecast_days: 3,
      daily_variables: ['river_discharge_range'],
    },
    reason:
      'Invalid value: Cannot initialize ForecastVariableDaily from invalid String value river_discharge_range',
    message: /^Unknown discharge variable name: river_discharge_range\./,
  },
  {
    tool: definitions.openmeteoGetMarineTool,
    input: { latitude: 33.6, longitude: -118.2, hourly_variables: ['wave_height_range'] },
    reason:
      'Invalid value: Cannot initialize MarineVariable from invalid String value wave_height_range',
    message: /^Unknown variable name: wave_height_range\./,
  },
  {
    tool: definitions.openmeteoGetAirQualityTool,
    input: { latitude: 47.6, longitude: -122.33, hourly_variables: ['pm2_5_update'] },
    reason:
      'Invalid value: Cannot initialize AirQualityVariable from invalid String value pm2_5_update',
    message: /^Unknown variable name: pm2_5_update\./,
  },
] as const;

describe('upstream date rejections (#89)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    initOpenMeteoService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(DATE_CASES)(
    '$tool.name declares date_out_of_range as a handler-thrown, non-retryable ValidationError',
    ({ tool }) => {
      const entry = dateEntry(tool as AnyDefinition);
      expect(entry).toMatchObject({ code: JsonRpcErrorCode.ValidationError, retryable: false });
      expect(entry).not.toHaveProperty('thrownBy');
    },
  );

  it.each(DATE_CASES)(
    "$tool.name's date_out_of_range recovery names both ends of the range",
    ({ tool }) => {
      const recovery = dateEntry(tool as AnyDefinition)?.recovery ?? '';
      expect(recovery).toContain('start_date');
      expect(recovery).toContain('end_date');
    },
  );

  it.each(DATE_CASES)(
    '$tool.name answers an upstream date rejection as date_out_of_range, in upstream’s words',
    async ({ tool, input, reason }) => {
      const { error, text } = await rejectedWith(tool as AnyDefinition, input as AnyInput, reason);
      const recovery = dateEntry(tool as AnyDefinition)?.recovery;

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toBe(reason);
      expect(error.data).toEqual({
        reason: 'date_out_of_range',
        retryable: false,
        recovery: { hint: recovery },
      });
      expect(text).toContain(`Recovery: ${recovery}`);
      expect(text).toContain('reason date_out_of_range · not retryable');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(NAME_CASES)(
    '$tool.name answers an unknown name quoting "range" or "date" as invalid_variable',
    async ({ tool, input, reason, message }) => {
      const { error, text } = await rejectedWith(tool as AnyDefinition, input as AnyInput, reason);

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data?.reason).toBe('invalid_variable');
      expect(error.message).toMatch(message);
      expect(error.message.endsWith(`(Upstream: ${reason})`)).toBe(true);
      expect(text).toContain('reason invalid_variable');
      expect(text).not.toContain('date_out_of_range');
    },
  );
});
