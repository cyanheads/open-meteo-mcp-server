/**
 * @fileoverview Blank and whitespace-padded variable names across the seven weather
 * tools, plus the `cleanNames` / `cleanName` helpers behind them. Every name is trimmed
 * and a blank one dropped before the cadence check, the `no_variables_requested` guard,
 * and the upstream request — so a field holding only blanks counts as not provided and a
 * padded name reaches Open-Meteo as the name. How each tool sends and echoes a cleaned
 * `models` value is pinned in that tool's own test file.
 * @module tests/tools/name-input.test
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
import { cleanName, cleanNames } from '@/mcp-server/tools/name-input.js';
import { firstText } from '../helpers/content.js';
import { upstream } from '../helpers/upstream-spy.js';
import { type WireError, wireError } from '../helpers/wire-error.js';

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

/** The service parameter each variable field is sent as. */
const PARAM = {
  current_variables: 'current',
  hourly_variables: 'hourly',
  daily_variables: 'daily',
} as const;

type VariableField = keyof typeof PARAM;

/**
 * The 13 variable fields: each tool, the rest of an otherwise valid call, and a name its
 * catalog files under that field's cadence (so a misplacement check cannot fire).
 */
const FIELDS: {
  tool: AnyTool;
  rest: Record<string, unknown>;
  field: VariableField;
  name: string;
}[] = [
  {
    tool: openmeteoGetForecastTool,
    rest: SEATTLE,
    field: 'current_variables',
    name: 'temperature_2m',
  },
  {
    tool: openmeteoGetForecastTool,
    rest: SEATTLE,
    field: 'hourly_variables',
    name: 'temperature_2m',
  },
  {
    tool: openmeteoGetForecastTool,
    rest: SEATTLE,
    field: 'daily_variables',
    name: 'temperature_2m_max',
  },
  {
    tool: openmeteoGetHistoricalTool,
    rest: HISTORICAL,
    field: 'hourly_variables',
    name: 'temperature_2m',
  },
  {
    tool: openmeteoGetHistoricalTool,
    rest: HISTORICAL,
    field: 'daily_variables',
    name: 'temperature_2m_max',
  },
  { tool: openmeteoGetMarineTool, rest: SEATTLE, field: 'hourly_variables', name: 'wave_height' },
  {
    tool: openmeteoGetMarineTool,
    rest: SEATTLE,
    field: 'daily_variables',
    name: 'wave_height_max',
  },
  { tool: openmeteoGetAirQualityTool, rest: SEATTLE, field: 'current_variables', name: 'pm2_5' },
  { tool: openmeteoGetAirQualityTool, rest: SEATTLE, field: 'hourly_variables', name: 'pm2_5' },
  {
    tool: openmeteoGetEnsembleTool,
    rest: SEATTLE,
    field: 'hourly_variables',
    name: 'temperature_2m',
  },
  {
    tool: openmeteoGetEnsembleTool,
    rest: SEATTLE,
    field: 'daily_variables',
    name: 'temperature_2m_max',
  },
  { tool: openmeteoGetFloodTool, rest: SEATTLE, field: 'daily_variables', name: 'river_discharge' },
  {
    tool: openmeteoGetClimateTool,
    rest: CLIMATE,
    field: 'daily_variables',
    name: 'temperature_2m_max',
  },
];

const BLANKS = [[''], [' '], ['', ' ']];

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

describe('cleanNames / cleanName', () => {
  it('trims every name and keeps the order', () => {
    expect(cleanNames([' temperature_2m ', '\tprecipitation\n'])).toEqual([
      'temperature_2m',
      'precipitation',
    ]);
  });

  it('drops blank and whitespace-only entries, at any position', () => {
    expect(cleanNames(['', 'temperature_2m', ' ', 'precipitation', '\t'])).toEqual([
      'temperature_2m',
      'precipitation',
    ]);
  });

  it('returns undefined when no name survives, so the field reads as not provided', () => {
    expect(cleanNames([''])).toBeUndefined();
    expect(cleanNames([' ', '\n'])).toBeUndefined();
    expect(cleanNames([])).toBeUndefined();
    expect(cleanNames(undefined)).toBeUndefined();
  });

  it('trims a single name and turns a blank one into undefined', () => {
    expect(cleanName(' gem_global_ensemble')).toBe('gem_global_ensemble');
    expect(cleanName('gfs025')).toBe('gfs025');
    expect(cleanName(' ')).toBeUndefined();
    expect(cleanName('')).toBeUndefined();
    expect(cleanName(undefined)).toBeUndefined();
  });
});

describe('blank-only variable fields', () => {
  const matrix = FIELDS.flatMap(({ tool, rest, field }) =>
    BLANKS.map((blanks) => ({ name: tool.name, tool, rest, field, blanks })),
  );

  it.each(matrix)(
    '$name $field $blanks fails no_variables_requested before any upstream request',
    async ({ tool, rest, field, blanks }) => {
      const error = await wireError(tool, { ...rest, [field]: blanks } as never);

      expect(error.data?.reason).toBe('no_variables_requested');
      expect(error.message).toContain('blank or whitespace-only entries do not count');
      expect(upstream).not.toHaveBeenCalled();
    },
  );
});

describe('padded variable names', () => {
  it.each(FIELDS)(
    '$tool.name $field sends a padded name upstream trimmed',
    async ({ tool, rest, field, name }) => {
      await callTool(tool, { ...rest, [field]: [` ${name} `] });

      expect(upstream).toHaveBeenCalledTimes(1);
      expect(sentParams()[PARAM[field]]).toEqual([name]);
    },
  );

  it.each(FIELDS)(
    '$tool.name $field drops a blank entry beside a real name',
    async ({ tool, rest, field, name }) => {
      await callTool(tool, { ...rest, [field]: [name, ''] });

      expect(sentParams()[PARAM[field]]).toEqual([name]);
    },
  );

  it.each(['temperature_2m', ' temperature_2m '])(
    'repairs a lone string %j into a one-name list, trimmed',
    async (hourly_variables) => {
      await callTool(openmeteoGetForecastTool, { ...SEATTLE, hourly_variables });

      expect(sentParams().hourly).toEqual(['temperature_2m']);
    },
  );

  it('keeps an empty array as not provided (#17)', async () => {
    const error = await wireError(openmeteoGetForecastTool, {
      ...SEATTLE,
      hourly_variables: [],
    } as never);

    expect(error.data?.reason).toBe('no_variables_requested');
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('padded names and the cadence check', () => {
  it('still rejects a padded hourly name sent as a daily variable', async () => {
    const error = await wireError(openmeteoGetForecastTool, {
      ...SEATTLE,
      daily_variables: [' cloud_cover '],
    } as never);

    expect(error.data?.reason).toBe('variable_wrong_cadence');
    expect(error.message).toContain('cloud_cover');
    expect(error.message).not.toContain(' cloud_cover ');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('names the trimmed value in the misplacement message on both surfaces', async () => {
    const result = await callTool(openmeteoGetHistoricalTool, {
      ...HISTORICAL,
      hourly_variables: ['  temperature_2m_max'],
    });

    expect(result.isError).toBe(true);
    expect(firstText(result.content)).toContain('temperature_2m_max');
    expect(firstText(result.content)).not.toContain('  temperature_2m_max');
    const { error } = result.structuredContent as { error: WireError };
    expect(error.data?.reason).toBe('variable_wrong_cadence');
    expect(error.message).toContain('temperature_2m_max');
    expect(error.message).not.toContain('  temperature_2m_max');
  });
});
