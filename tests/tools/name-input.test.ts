/**
 * @fileoverview Blank and whitespace-padded variable names across the seven weather
 * tools, plus the `cleanNames` helper behind them. Every element is split
 * on commas, every name trimmed, and a blank one dropped before the cadence check, the
 * `no_variables_requested` guard, and the upstream request — so a field holding only
 * blanks counts as not provided and a padded name reaches Open-Meteo as the name. How
 * each tool sends and echoes a cleaned `models` value is pinned in that tool's own test
 * file; a comma inside an element is tabled across every field in
 * `name-list-input.test.ts`.
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
import { cleanNames } from '@/mcp-server/tools/name-input.js';
import { firstText } from '../helpers/content.js';
import { cpuMicrosPerCall } from '../helpers/cpu-time.js';
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
 * The 14 variable fields: each tool, the rest of an otherwise valid call, and a name its
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
  { tool: openmeteoGetMarineTool, rest: SEATTLE, field: 'current_variables', name: 'wave_height' },
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

describe('cleanNames', () => {
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

  it('splits an element on commas into the names it joins, in order', () => {
    expect(cleanNames(['temperature_2m,wind_speed_10m', 'precipitation'])).toEqual([
      'temperature_2m',
      'wind_speed_10m',
      'precipitation',
    ]);
  });

  it('trims every segment of a split element and drops the blank ones', () => {
    expect(cleanNames([' temperature_2m , wind_speed_10m'])).toEqual([
      'temperature_2m',
      'wind_speed_10m',
    ]);
    expect(cleanNames(['temperature_2m,', ',precipitation', 'rain,,\tsnowfall\n'])).toEqual([
      'temperature_2m',
      'precipitation',
      'rain',
      'snowfall',
    ]);
  });

  it('reads elements holding only commas and whitespace as not provided', () => {
    expect(cleanNames([','])).toBeUndefined();
    expect(cleanNames([' , ', ',,', ''])).toBeUndefined();
  });
});

describe('cleanNames running time', () => {
  /** Generous CPU ceiling per character, in microseconds, held at every size. */
  const CPU_MICROS_PER_CHAR = 1;
  const BASE = 5_000;
  const LARGEST = 320_000;

  /** Shapes grown by doubling from 5k characters to 320k, the full 64× span. */
  const SHAPES: [string, (size: number) => string[]][] = [
    ['commas throughout', (size) => [','.repeat(size)]],
    ['padded names between commas', (size) => [' a ,'.repeat(size / 4)]],
    ['a whitespace run inside one name', (size) => [`a${' '.repeat(size)}b`]],
    [
      'a whitespace run around one name',
      (size) => [`${' '.repeat(size / 2)}a${' '.repeat(size / 2)}`],
    ],
    ['one long line ending in a break', (size) => [`${'§1 x'.repeat(size / 4)}\ny`]],
    ['breaks throughout', (size) => ['  \r\n'.repeat(size / 4)]],
    ['fifty elements of commas', (size) => Array.from({ length: 50 }, () => ','.repeat(size / 50))],
  ];

  it.each(SHAPES)(
    'stays linear on %s',
    (_shape, build) => {
      const timeAt = (size: number) => {
        const names = build(size);
        return cpuMicrosPerCall(() => cleanNames(names), Math.max(4, Math.ceil(400_000 / size)));
      };

      expect(timeAt(BASE)).toBeLessThan(BASE * CPU_MICROS_PER_CHAR);
      let ratio = 1;
      for (let size = BASE * 2; size <= LARGEST; size *= 2) {
        const base = timeAt(BASE);
        const atSize = timeAt(size);
        expect(atSize, `${size} characters`).toBeLessThan(size * CPU_MICROS_PER_CHAR);
        ratio = atSize / base;
      }

      // Linear growth over the 64× span is its own size; quadratic would be its square.
      expect(ratio).toBeLessThan(256);
    },
    0,
  );
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
      hourly_variables: ['  precipitation_sum'],
    });

    expect(result.isError).toBe(true);
    expect(firstText(result.content)).toContain('precipitation_sum');
    expect(firstText(result.content)).not.toContain('  precipitation_sum');
    const { error } = result.structuredContent as { error: WireError };
    expect(error.data?.reason).toBe('variable_wrong_cadence');
    expect(error.message).toContain('precipitation_sum');
    expect(error.message).not.toContain('  precipitation_sum');
  });
});

/** `count` distinct names, `name_0` … `name_{count-1}`. */
const names = (count: number): string[] => Array.from({ length: count }, (_, i) => `name_${i}`);

describe('list forms the framework already accepts', () => {
  it.each([
    ['a JSON-stringified array', '["temperature_2m","precipitation"]'],
    ['a JSON-stringified array after leading whitespace', ' ["temperature_2m","precipitation"]'],
  ])('reads %s as its two names', async (_label, hourly_variables) => {
    await callTool(openmeteoGetForecastTool, { ...SEATTLE, hourly_variables });

    expect(sentParams().hourly).toEqual(['temperature_2m', 'precipitation']);
  });

  it.each([
    ['an array', ['temperature_2m,precipitation', 'wind_speed_10m']],
    ['a JSON-stringified array', '["temperature_2m,precipitation","wind_speed_10m"]'],
  ])('splits an element of %s holding a comma into the names it joins', async (_label, list) => {
    await callTool(openmeteoGetForecastTool, { ...SEATTLE, hourly_variables: list });

    expect(sentParams().hourly).toEqual(['temperature_2m', 'precipitation', 'wind_speed_10m']);
  });

  it('reads null as not provided', async () => {
    await callTool(openmeteoGetForecastTool, {
      ...SEATTLE,
      hourly_variables: null,
      daily_variables: ['temperature_2m_max'],
    });

    expect(sentParams().hourly).toBeUndefined();
    expect(sentParams().daily).toEqual(['temperature_2m_max']);
  });

  it('accepts 50 names in an array and rejects 51 as too big', async () => {
    await callTool(openmeteoGetForecastTool, { ...SEATTLE, hourly_variables: names(50) });
    expect(sentParams().hourly).toEqual(names(50));

    upstream.mockReset();
    const error = await wireError(openmeteoGetForecastTool, {
      ...SEATTLE,
      hourly_variables: names(51),
    } as never);
    expect(error.code).toBe(-32602);
    expect(error.message).toBe(
      'Input validation error: Invalid arguments for tool openmeteo_get_forecast: hourly_variables: Too big: expected array to have <=50 items',
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it('drops an underscore-prefixed spelling of the field, as for any undeclared _ key', async () => {
    await callTool(openmeteoGetForecastTool, {
      ...SEATTLE,
      _hourly_variables: ['temperature_2m'],
      daily_variables: ['temperature_2m_max'],
    });

    expect(sentParams().hourly).toBeUndefined();
    expect(sentParams().daily).toEqual(['temperature_2m_max']);
  });

  it('reaches the field from a case-folded spelling of its key', async () => {
    await callTool(openmeteoGetForecastTool, { ...SEATTLE, Hourly_Variables: ['temperature_2m'] });

    expect(sentParams().hourly).toEqual(['temperature_2m']);
  });

  it('advertises a name list as a plain optional string array', () => {
    const advertised = openmeteoGetAirQualityTool.input['~standard'].jsonSchema.input({
      target: 'draft-2020-12',
    }) as { properties: Record<string, unknown>; required?: string[] };

    expect(advertised.properties.hourly_variables).toStrictEqual({
      description:
        'Hourly air quality variables (e.g., ["pm2_5", "pm10", "ozone", "nitrogen_dioxide", "european_aqi", "us_aqi"]). At least one of current_variables or hourly_variables is required.',
      maxItems: 50,
      type: 'array',
      items: { type: 'string' },
    });
    expect(advertised.required).not.toContain('hourly_variables');
  });
});

describe('comma-joined name lists (#96)', () => {
  it.each([
    ['a comma-joined pair', 'temperature_2m,precipitation'],
    ['padded names and a trailing comma', ' temperature_2m , precipitation ,'],
    ['an empty segment', 'temperature_2m,,precipitation'],
  ])('splits %s into the names it joins', async (_label, hourly_variables) => {
    await callTool(openmeteoGetForecastTool, { ...SEATTLE, hourly_variables });

    expect(upstream).toHaveBeenCalledTimes(1);
    expect(sentParams().hourly).toEqual(['temperature_2m', 'precipitation']);
  });

  it.each(['', ' , ,'])(
    'reads %j as not provided, so the call fails no_variables_requested',
    async (hourly_variables) => {
      const error = await wireError(openmeteoGetForecastTool, {
        ...SEATTLE,
        hourly_variables,
      } as never);

      expect(error.data?.reason).toBe('no_variables_requested');
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it('accepts 50 joined names and rejects 51 as too big', async () => {
    await callTool(openmeteoGetForecastTool, {
      ...SEATTLE,
      hourly_variables: names(50).join(','),
    });
    expect(sentParams().hourly).toEqual(names(50));

    upstream.mockReset();
    const error = await wireError(openmeteoGetForecastTool, {
      ...SEATTLE,
      hourly_variables: names(51).join(','),
    } as never);
    expect(error.code).toBe(-32602);
    expect(error.message).toBe(
      'Input validation error: Invalid arguments for tool openmeteo_get_forecast: hourly_variables: Too big: expected array to have <=50 items',
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    [true, 'hourly_variables: Send an array of names, not a boolean.'],
    [2.5, 'hourly_variables: Send an array of names, not a number.'],
    [{ name: 'temperature_2m' }, 'hourly_variables: Send an array of names, not an object.'],
    [
      '["temperature_2m",',
      'hourly_variables: Send an array of names; this string is not a well-formed JSON array.',
    ],
    [
      ' {"name":"temperature_2m"}',
      'hourly_variables: Send an array of names; this string is not a well-formed JSON array.',
    ],
  ])('rejects %j with the remedy on every surface', async (hourly_variables, line) => {
    const result = await callTool(openmeteoGetForecastTool, { ...SEATTLE, hourly_variables });

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as { error: WireError };
    expect(error.code).toBe(-32602);
    expect(error.message).toBe(
      `Input validation error: Invalid arguments for tool openmeteo_get_forecast: ${line}`,
    );
    expect(error.data?.recovery?.hint).toBe(line);
    expect(firstText(result.content)).toContain(`openmeteo_get_forecast: ${line}`);
    expect(upstream).not.toHaveBeenCalled();
  });
});
