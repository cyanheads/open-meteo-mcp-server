/**
 * @fileoverview Per-tool wiring of the name-list inputs (#96): each weather tool's
 * Open-Meteo key aliases (`hourly`, `daily`, `current`) reach their canonical
 * `*_variables` field, the comma split reaches every list field it wraps, and the
 * fields it does not wrap keep their own behavior. The split's full value table lives in
 * `name-input.test.ts`; this file holds one case per side of each wiring branch, and the
 * one table of a comma inside an array element across every list field: the same
 * request, echo, notices, and guards as the names sent as separate elements.
 * @module tests/tools/name-list-input.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openmeteoGetAirQualityTool,
  openmeteoGetClimateTool,
  openmeteoGetEnsembleTool,
  openmeteoGetFloodTool,
  openmeteoGetForecastTool,
  openmeteoGetHistoricalTool,
  openmeteoGetMarineTool,
} from '@/mcp-server/tools/definitions/index.js';
import { upstream } from '../helpers/upstream-spy.js';
import { wireError } from '../helpers/wire-error.js';

vi.mock('@/services/canvas-accessor.js', () => ({ getCanvas: () => undefined }));
vi.mock('@/services/open-meteo/open-meteo-service.js', () => import('../helpers/upstream-spy.js'));

const SEATTLE = { latitude: 47.6, longitude: -122.3 };
const HISTORICAL = { ...SEATTLE, start_date: '2024-07-01', end_date: '2024-07-02' };
const CLIMATE = { ...SEATTLE, start_date: '2049-01-01', end_date: '2049-01-02' };

type AnyTool =
  | typeof openmeteoGetForecastTool
  | typeof openmeteoGetHistoricalTool
  | typeof openmeteoGetMarineTool
  | typeof openmeteoGetAirQualityTool
  | typeof openmeteoGetEnsembleTool
  | typeof openmeteoGetFloodTool
  | typeof openmeteoGetClimateTool;

type Alias = 'current' | 'hourly' | 'daily';

/**
 * Every variable field: its tool, the rest of a valid call, and two names the tool's
 * catalog files under that field's cadence. The field's alias is its Open-Meteo
 * parameter name, which is also the key the service receives.
 */
const FIELDS: {
  tool: AnyTool;
  rest: Record<string, unknown>;
  alias: Alias;
  pair: [string, string];
}[] = [
  {
    tool: openmeteoGetForecastTool,
    rest: SEATTLE,
    alias: 'current',
    pair: ['temperature_2m', 'wind_speed_10m'],
  },
  {
    tool: openmeteoGetForecastTool,
    rest: SEATTLE,
    alias: 'hourly',
    pair: ['temperature_2m', 'precipitation'],
  },
  {
    tool: openmeteoGetForecastTool,
    rest: SEATTLE,
    alias: 'daily',
    pair: ['temperature_2m_max', 'precipitation_sum'],
  },
  {
    tool: openmeteoGetHistoricalTool,
    rest: HISTORICAL,
    alias: 'hourly',
    pair: ['temperature_2m', 'precipitation'],
  },
  {
    tool: openmeteoGetHistoricalTool,
    rest: HISTORICAL,
    alias: 'daily',
    pair: ['temperature_2m_max', 'precipitation_sum'],
  },
  {
    tool: openmeteoGetMarineTool,
    rest: SEATTLE,
    alias: 'current',
    pair: ['wave_height', 'wave_period'],
  },
  {
    tool: openmeteoGetMarineTool,
    rest: SEATTLE,
    alias: 'hourly',
    pair: ['wave_height', 'wave_period'],
  },
  {
    tool: openmeteoGetMarineTool,
    rest: SEATTLE,
    alias: 'daily',
    pair: ['wave_height_max', 'wave_period_max'],
  },
  { tool: openmeteoGetAirQualityTool, rest: SEATTLE, alias: 'current', pair: ['pm2_5', 'pm10'] },
  { tool: openmeteoGetAirQualityTool, rest: SEATTLE, alias: 'hourly', pair: ['pm2_5', 'pm10'] },
  {
    tool: openmeteoGetEnsembleTool,
    rest: SEATTLE,
    alias: 'hourly',
    pair: ['temperature_2m', 'precipitation'],
  },
  {
    tool: openmeteoGetEnsembleTool,
    rest: SEATTLE,
    alias: 'daily',
    pair: ['temperature_2m_max', 'precipitation_sum'],
  },
  {
    tool: openmeteoGetFloodTool,
    rest: SEATTLE,
    alias: 'daily',
    pair: ['river_discharge', 'river_discharge_max'],
  },
  {
    tool: openmeteoGetClimateTool,
    rest: CLIMATE,
    alias: 'daily',
    pair: ['temperature_2m_max', 'precipitation_sum'],
  },
];

/** The cadences a tool has no field for: each alias stays an unknown key there. */
const UNDECLARED: {
  tool: AnyTool;
  rest: Record<string, unknown>;
  alias: Alias;
  field: string;
  name: string;
}[] = [
  {
    tool: openmeteoGetHistoricalTool,
    rest: HISTORICAL,
    alias: 'current',
    field: 'daily_variables',
    name: 'temperature_2m_max',
  },
  {
    tool: openmeteoGetAirQualityTool,
    rest: SEATTLE,
    alias: 'daily',
    field: 'hourly_variables',
    name: 'pm2_5',
  },
  {
    tool: openmeteoGetEnsembleTool,
    rest: SEATTLE,
    alias: 'current',
    field: 'daily_variables',
    name: 'temperature_2m_max',
  },
  {
    tool: openmeteoGetFloodTool,
    rest: SEATTLE,
    alias: 'hourly',
    field: 'daily_variables',
    name: 'river_discharge',
  },
  {
    tool: openmeteoGetFloodTool,
    rest: SEATTLE,
    alias: 'current',
    field: 'daily_variables',
    name: 'river_discharge',
  },
  {
    tool: openmeteoGetClimateTool,
    rest: CLIMATE,
    alias: 'hourly',
    field: 'daily_variables',
    name: 'temperature_2m_max',
  },
  {
    tool: openmeteoGetClimateTool,
    rest: CLIMATE,
    alias: 'current',
    field: 'daily_variables',
    name: 'temperature_2m_max',
  },
];

/** The array `models` fields: a valid call around them, and two names from the tool's catalog. */
const MODEL_FIELDS: {
  tool: AnyTool;
  rest: Record<string, unknown>;
  pair: [string, string];
  /** The models the tool sends when the caller's models is omitted or blank; absent when none. */
  omitted?: string[];
}[] = [
  {
    tool: openmeteoGetForecastTool,
    rest: { ...SEATTLE, hourly_variables: ['temperature_2m'] },
    pair: ['ecmwf_ifs025', 'ncep_gfs_seamless'],
  },
  {
    tool: openmeteoGetHistoricalTool,
    rest: { ...HISTORICAL, daily_variables: ['temperature_2m_max'] },
    pair: ['era5', 'era5_land'],
  },
  {
    tool: openmeteoGetMarineTool,
    rest: { ...SEATTLE, hourly_variables: ['wave_height'] },
    pair: ['ecmwf_wam', 'ncep_gfswave016'],
  },
  {
    tool: openmeteoGetFloodTool,
    rest: { ...SEATTLE, daily_variables: ['river_discharge'] },
    pair: ['seamless_v4', 'consolidated_v4'],
  },
  {
    tool: openmeteoGetClimateTool,
    rest: { ...CLIMATE, daily_variables: ['temperature_2m_max'] },
    pair: ['MRI_AGCM3_2_S', 'EC_Earth3P_HR'],
    omitted: ['MRI_AGCM3_2_S'],
  },
];

/** The params object the handler handed to the service on its one upstream call. */
const sentParams = (): Record<string, unknown> =>
  upstream.mock.calls[0]?.[2] as Record<string, unknown>;

/** Runs `tool` with the upstream spy rejecting, so the call stops once the request is built. */
async function callTool(tool: AnyTool, args: Record<string, unknown>) {
  upstream.mockRejectedValue(new Error('stop after the request is built'));
  return await runToolContract(tool, args as never);
}

beforeEach(() => {
  upstream.mockReset();
});

describe('Open-Meteo key aliases', () => {
  it.each(FIELDS)(
    '$tool.name accepts $alias for its _variables field',
    async ({ tool, rest, alias, pair }) => {
      await callTool(tool, { ...rest, [alias]: pair });

      expect(upstream).toHaveBeenCalledTimes(1);
      expect(sentParams()[alias]).toEqual(pair);
    },
  );

  it.each(UNDECLARED)(
    '$tool.name keeps $alias an unknown key',
    async ({ tool, rest, alias, field, name }) => {
      const error = await wireError(tool, { ...rest, [field]: [name], [alias]: [name] } as never);

      expect(error.code).toBe(-32602);
      expect(error.message).toContain(`Unrecognized key: "${alias}"`);
      // Not the alias-of-a-field rejection, which carries the same code and message.
      expect(error.data?.recovery?.hint).toMatch(
        new RegExp(`^Unknown key ${alias}\\. This tool accepts: `),
      );
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it.each(FIELDS)(
    '$tool.name rejects $alias sent beside its _variables field as an alias of it',
    async ({ tool, rest, alias, pair }) => {
      const error = await wireError(tool, {
        ...rest,
        [alias]: [pair[0]],
        [`${alias}_variables`]: [pair[1]],
      } as never);

      expect(error.code).toBe(-32602);
      expect(error.data?.recovery?.hint).toBe(
        `${alias} is an alias of ${alias}_variables; send one of them, not both.`,
      );
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it('rejects current: true as a list of the wrong type, naming the field it validated', async () => {
    const error = await wireError(openmeteoGetForecastTool, { ...SEATTLE, current: true } as never);

    expect(error.code).toBe(-32602);
    expect(error.message).toBe(
      'Input validation error: Invalid arguments for tool openmeteo_get_forecast: current_variables: Send an array of names, not a boolean.',
    );
    expect(error.data?.recovery?.hint).toBe(
      'current_variables: Send an array of names, not a boolean. Validated current as current_variables.',
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it('sends a comma-joined alias exactly as the canonical array', async () => {
    await callTool(openmeteoGetForecastTool, {
      latitude: 47.61,
      longitude: -122.33,
      daily: 'temperature_2m_max,precipitation_sum',
    });
    const viaAlias = upstream.mock.calls[0];

    upstream.mockReset();
    await callTool(openmeteoGetForecastTool, {
      latitude: 47.61,
      longitude: -122.33,
      daily_variables: ['temperature_2m_max', 'precipitation_sum'],
    });

    expect(viaAlias?.slice(0, 3)).toEqual(upstream.mock.calls[0]?.slice(0, 3));
    expect(viaAlias?.[2]).toMatchObject({ daily: ['temperature_2m_max', 'precipitation_sum'] });
  });
});

describe('comma-joined lists on every wrapped field', () => {
  it.each(FIELDS)(
    '$tool.name splits the $alias _variables field',
    async ({ tool, rest, alias, pair }) => {
      await callTool(tool, { ...rest, [`${alias}_variables`]: `${pair[0]},${pair[1]}` });

      expect(sentParams()[alias]).toEqual(pair);
    },
  );

  it.each(MODEL_FIELDS)('$tool.name splits models', async ({ tool, rest, pair }) => {
    await callTool(tool, { ...rest, models: `${pair[0]},${pair[1]}` });

    expect(sentParams().models).toEqual(pair);
  });

  it('splits the ensemble models string into trimmed names (#98)', async () => {
    await callTool(openmeteoGetEnsembleTool, {
      ...SEATTLE,
      hourly_variables: ['temperature_2m'],
      models: ' ecmwf_ifs025_ensemble , ncep_gefs025, ',
    });

    expect(sentParams().models).toEqual(['ecmwf_ifs025_ensemble', 'ncep_gefs025']);
  });
});

describe('a comma inside a list element', () => {
  /**
   * A canned answer carrying `columns` in the `alias` block — the first column partly
   * null and the rest all null — so a call reaches its echo and its coverage notices.
   */
  function answer(alias: Alias, columns: readonly string[]): Record<string, unknown> {
    const envelope = {
      latitude: 47.6,
      longitude: -122.3,
      elevation: 50,
      generationtime_ms: 0.1,
      timezone: 'GMT',
      timezone_abbreviation: 'GMT',
      utc_offset_seconds: 0,
    };
    const units = Object.fromEntries(columns.map((column) => [column, 'm']));
    if (alias === 'current') {
      const values = columns.map((column, i) => [column, i === 0 ? 1.5 : null]);
      return {
        ...envelope,
        current_units: { time: 'iso8601', interval: 'seconds', ...units },
        current: { time: '2024-07-01T00:00', interval: 900, ...Object.fromEntries(values) },
      };
    }
    const time =
      alias === 'hourly' ? ['2024-07-01T00:00', '2024-07-01T01:00'] : ['2024-07-01', '2024-07-02'];
    const values = columns.map((column, i) => [column, i === 0 ? [1.5, null] : [null, null]]);
    return {
      ...envelope,
      [`${alias}_units`]: { time: 'iso8601', ...units },
      [alias]: { time, ...Object.fromEntries(values) },
    };
  }

  /** Calls `tool` against `response`: what the service received, and what the caller got. */
  async function answered(
    tool: AnyTool,
    args: Record<string, unknown>,
    response: Record<string, unknown>,
  ) {
    upstream.mockReset();
    upstream.mockResolvedValue(response);
    const result = await runToolContract(tool, args as never);
    return { sent: upstream.mock.calls.map((call) => call.slice(0, 3)), result };
  }

  /** The text of every content block, joined. */
  const contentText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

  it.each(FIELDS)(
    '$tool.name sends and answers ["a,b"] in its $alias field exactly as ["a", "b"]',
    async ({ tool, rest, alias, pair }) => {
      const field = `${alias}_variables`;
      const response = answer(alias, pair);
      const joined = await answered(tool, { ...rest, [field]: [pair.join(',')] }, response);
      const separate = await answered(tool, { ...rest, [field]: pair }, response);

      expect(separate.result.isError).toBeFalsy();
      expect(separate.sent[0]?.[2]).toMatchObject({ [alias]: pair });
      expect(joined.sent).toEqual(separate.sent);
      expect(joined.result).toEqual(separate.result);
    },
  );

  it.each(MODEL_FIELDS)(
    '$tool.name sends and answers models ["a,b"] exactly as ["a", "b"]',
    async ({ tool, rest, pair }) => {
      const [field, names] = Object.entries(rest).find(([key]) => key.endsWith('_variables')) as [
        string,
        string[],
      ];
      const response = answer(field.replace('_variables', '') as Alias, names);
      const joined = await answered(tool, { ...rest, models: [pair.join(',')] }, response);
      const separate = await answered(tool, { ...rest, models: pair }, response);

      expect(separate.result.isError).toBeFalsy();
      expect(separate.sent[0]?.[2]).toMatchObject({ models: pair });
      expect(joined.sent).toEqual(separate.sent);
      expect(joined.result).toEqual(separate.result);
    },
  );

  it.each(FIELDS)(
    '$tool.name trims padded segments and drops blank ones in its $alias field',
    async ({ tool, rest, alias, pair }) => {
      await callTool(tool, {
        ...rest,
        [`${alias}_variables`]: [` ${pair[0]} , ,`, `,${pair[1]}\t`],
      });

      expect(sentParams()[alias]).toEqual(pair);
    },
  );

  it.each(FIELDS)(
    '$tool.name reads [","] in its $alias field as not provided, before any request',
    async ({ tool, rest, alias }) => {
      const error = await wireError(tool, { ...rest, [`${alias}_variables`]: [','] } as never);

      expect(error.data?.reason).toBe('no_variables_requested');
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it.each(MODEL_FIELDS)(
    '$tool.name reads models [" , "] as omitted',
    async ({ tool, rest, omitted }) => {
      await callTool(tool, { ...rest, models: [' , '] });

      expect(upstream).toHaveBeenCalledTimes(1);
      expect(sentParams().models).toEqual(omitted);
    },
  );

  /** Each cadence-checked field, a name filed under its cadence, and one filed under the other. */
  const CADENCE_CHECKED: {
    tool: AnyTool;
    rest: Record<string, unknown>;
    field: string;
    valid: string;
    misplaced: string;
  }[] = [
    {
      tool: openmeteoGetForecastTool,
      rest: SEATTLE,
      field: 'hourly_variables',
      valid: 'temperature_2m',
      misplaced: 'precipitation_sum',
    },
    {
      tool: openmeteoGetForecastTool,
      rest: SEATTLE,
      field: 'daily_variables',
      valid: 'temperature_2m_max',
      misplaced: 'cloud_cover',
    },
    {
      tool: openmeteoGetHistoricalTool,
      rest: HISTORICAL,
      field: 'hourly_variables',
      valid: 'temperature_2m',
      misplaced: 'precipitation_sum',
    },
    {
      tool: openmeteoGetHistoricalTool,
      rest: HISTORICAL,
      field: 'daily_variables',
      valid: 'temperature_2m_max',
      misplaced: 'cloud_cover',
    },
    {
      tool: openmeteoGetMarineTool,
      rest: SEATTLE,
      field: 'current_variables',
      valid: 'wave_height',
      misplaced: 'wave_height_max',
    },
    {
      tool: openmeteoGetMarineTool,
      rest: SEATTLE,
      field: 'hourly_variables',
      valid: 'wave_height',
      misplaced: 'wave_height_max',
    },
    {
      tool: openmeteoGetMarineTool,
      rest: SEATTLE,
      field: 'daily_variables',
      valid: 'wave_height_max',
      misplaced: 'wave_height',
    },
    {
      tool: openmeteoGetEnsembleTool,
      rest: SEATTLE,
      field: 'hourly_variables',
      valid: 'temperature_2m',
      misplaced: 'precipitation_sum',
    },
    {
      tool: openmeteoGetEnsembleTool,
      rest: SEATTLE,
      field: 'daily_variables',
      valid: 'temperature_2m_max',
      misplaced: 'precipitation',
    },
  ];

  it.each(CADENCE_CHECKED)(
    '$tool.name names only the misplaced half of a $field element, before any request',
    async ({ tool, rest, field, valid, misplaced }) => {
      const error = await wireError(tool, { ...rest, [field]: [`${valid},${misplaced}`] } as never);

      expect(error.data?.reason).toBe('variable_wrong_cadence');
      expect(error.message).toContain(`${misplaced} is not valid in ${field}`);
      expect(error.message).not.toContain(`${valid} is not valid`);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it.each([
    { tool: openmeteoGetForecastTool, rest: SEATTLE },
    { tool: openmeteoGetHistoricalTool, rest: HISTORICAL },
  ])(
    '$tool.name answers hourly ["temperature_2m,temperature_2m_max"] with both columns',
    async ({ tool, rest }) => {
      const pair = ['temperature_2m', 'temperature_2m_max'];
      const { sent, result } = await answered(
        tool,
        { ...rest, hourly_variables: [pair.join(',')] },
        answer('hourly', pair),
      );

      expect(result.isError).toBeFalsy();
      expect(sent[0]?.[2]).toMatchObject({ hourly: pair });
      const { hourly } = result.structuredContent as { hourly: Record<string, unknown>[] };
      expect(hourly[0]).toEqual({
        time: '2024-07-01T00:00',
        temperature_2m: 1.5,
        temperature_2m_max: null,
      });
    },
  );

  it('rejects forecast current_variables beside a comma-joined pair of models, before any request', async () => {
    const error = await wireError(openmeteoGetForecastTool, {
      ...SEATTLE,
      current_variables: ['temperature_2m'],
      models: ['ecmwf_ifs025,ncep_gfs_seamless'],
    } as never);

    expect(error.data?.reason).toBe('current_multi_model');
    expect(error.message).toContain('2 models (ecmwf_ifs025, ncep_gfs_seamless)');
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    {
      tool: openmeteoGetForecastTool,
      rest: { ...SEATTLE, hourly_variables: ['temperature_2m'] },
      at: 'icon_d2,ecmwf_ifs025',
    },
    {
      tool: openmeteoGetHistoricalTool,
      rest: { ...HISTORICAL, hourly_variables: ['temperature_2m'] },
      at: 'cerra,era5',
    },
  ])(
    '$tool.name calls plain columns unattributable when models ["$at"] answers with one model',
    async ({ tool, rest, at }) => {
      const { result } = await answered(
        tool,
        { ...rest, models: [at] },
        answer('hourly', ['temperature_2m']),
      );

      const { notice } = result.structuredContent as { notice?: string };
      expect(notice).toContain(`2 models were requested (${at.split(',').join(', ')})`);
      expect(notice).toContain('unattributable');
      expect(contentText(result)).toContain('unattributable');
    },
  );

  /** `count` distinct names, `name_0` … `name_{count-1}`. */
  const names = (count: number): string[] => Array.from({ length: count }, (_, i) => `name_${i}`);

  it.each([
    {
      tool: openmeteoGetForecastTool,
      args: SEATTLE,
      field: 'hourly_variables',
      key: 'hourly',
      count: 51,
    },
    {
      tool: openmeteoGetFloodTool,
      args: { ...SEATTLE, daily_variables: ['river_discharge'] },
      field: 'models',
      key: 'models',
      count: 7,
    },
  ])(
    '$tool.name counts elements against the $field cap, so one element joining $count names sends them all',
    async ({ tool, args, field, key, count }) => {
      await callTool(tool, { ...args, [field]: [names(count).join(',')] });

      expect(upstream).toHaveBeenCalledTimes(1);
      expect(sentParams()[key]).toEqual(names(count));
    },
  );
});

describe('advertised input schemas', () => {
  /** Every wrapped list field and its item cap, as each tool advertised it before the split. */
  const WRAPPED: { tool: AnyTool; field: string; maxItems: number }[] = [
    { tool: openmeteoGetForecastTool, field: 'current_variables', maxItems: 50 },
    { tool: openmeteoGetForecastTool, field: 'hourly_variables', maxItems: 50 },
    { tool: openmeteoGetForecastTool, field: 'daily_variables', maxItems: 50 },
    { tool: openmeteoGetForecastTool, field: 'models', maxItems: 57 },
    { tool: openmeteoGetHistoricalTool, field: 'hourly_variables', maxItems: 50 },
    { tool: openmeteoGetHistoricalTool, field: 'daily_variables', maxItems: 50 },
    { tool: openmeteoGetHistoricalTool, field: 'models', maxItems: 8 },
    { tool: openmeteoGetMarineTool, field: 'current_variables', maxItems: 50 },
    { tool: openmeteoGetMarineTool, field: 'hourly_variables', maxItems: 50 },
    { tool: openmeteoGetMarineTool, field: 'daily_variables', maxItems: 50 },
    { tool: openmeteoGetMarineTool, field: 'models', maxItems: 10 },
    { tool: openmeteoGetAirQualityTool, field: 'current_variables', maxItems: 50 },
    { tool: openmeteoGetAirQualityTool, field: 'hourly_variables', maxItems: 50 },
    { tool: openmeteoGetEnsembleTool, field: 'hourly_variables', maxItems: 50 },
    { tool: openmeteoGetEnsembleTool, field: 'daily_variables', maxItems: 50 },
    { tool: openmeteoGetFloodTool, field: 'daily_variables', maxItems: 20 },
    { tool: openmeteoGetFloodTool, field: 'models', maxItems: 6 },
    { tool: openmeteoGetClimateTool, field: 'daily_variables', maxItems: 50 },
    { tool: openmeteoGetClimateTool, field: 'models', maxItems: 7 },
  ];

  it.each(WRAPPED)(
    '$tool.name advertises $field as an optional string array of at most $maxItems',
    ({ tool, field, maxItems }) => {
      const advertised = tool.input['~standard'].jsonSchema.input({
        target: 'draft-2020-12',
      }) as { properties: Record<string, unknown>; required?: string[] };

      expect(advertised.properties[field]).toStrictEqual({
        description: expect.any(String),
        maxItems,
        type: 'array',
        items: { type: 'string' },
      });
      expect(advertised.required ?? []).not.toContain(field);
    },
  );
});
