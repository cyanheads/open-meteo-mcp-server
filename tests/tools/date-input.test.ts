/**
 * @fileoverview Every `start_date` / `end_date` input on the surface is a real calendar
 * date: the five date-taking tools advertise `format: "date"` with a calendar-aware
 * `pattern` in `inputSchema`, and an impossible date (Feb 30, a non-leap Feb 29, a
 * 31st in a 30-day month, month 00 or 13, day 00) is rejected at argument validation —
 * naming the field and the real-date rule — before the handler or any upstream request
 * runs. Real dates, leap days included, keep reaching the handler as sent.
 * @module tests/tools/date-input.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openmeteoGetAirQualityTool,
  openmeteoGetClimateTool,
  openmeteoGetFloodTool,
  openmeteoGetHistoricalTool,
  openmeteoGetMarineTool,
} from '@/mcp-server/tools/definitions/index.js';
import { firstText } from '../helpers/content.js';
import { upstream } from '../helpers/upstream-spy.js';

vi.mock('@/services/canvas-accessor.js', () => ({ getCanvas: () => undefined }));
vi.mock('@/services/open-meteo/open-meteo-service.js', () => import('../helpers/upstream-spy.js'));

const SEATTLE = { latitude: 47.6, longitude: -122.3 };

/** Each date-taking tool with the rest of an otherwise valid date-range call. */
const CASES = [
  {
    tool: openmeteoGetHistoricalTool,
    rest: { ...SEATTLE, daily_variables: ['temperature_2m_max'] },
    range: { start_date: '2024-07-01', end_date: '2024-07-02' },
  },
  {
    tool: openmeteoGetMarineTool,
    rest: { ...SEATTLE, hourly_variables: ['wave_height'] },
    range: { start_date: '2024-07-01', end_date: '2024-07-02' },
  },
  {
    tool: openmeteoGetAirQualityTool,
    rest: { ...SEATTLE, hourly_variables: ['pm2_5'] },
    range: { start_date: '2024-07-01', end_date: '2024-07-02' },
  },
  {
    tool: openmeteoGetFloodTool,
    rest: { ...SEATTLE, daily_variables: ['river_discharge'] },
    range: { start_date: '2024-07-01', end_date: '2024-07-02' },
  },
  {
    tool: openmeteoGetClimateTool,
    rest: { ...SEATTLE, daily_variables: ['temperature_2m_max'] },
    range: { start_date: '2049-01-01', end_date: '2049-01-02' },
  },
] as const;

const FIELDS = ['start_date', 'end_date'] as const;

/** Shaped like a date, but no calendar has them. */
const IMPOSSIBLE = [
  '2024-02-30',
  '2023-02-29',
  '2024-04-31',
  '2024-13-01',
  '2024-00-10',
  '2024-01-00',
];

/** Real dates every schema must accept: leap days, month ends, and the coverage bounds. */
const REAL = [
  '2024-02-29',
  '2000-02-29',
  '2024-04-30',
  '2024-12-31',
  '1940-01-01',
  '1950-01-01',
  '1984-01-01',
  '2050-12-31',
];

type JsonSchemaProperty = { format?: string; pattern?: string; type?: string };
type JsonSchemaObject = { properties: Record<string, JsonSchemaProperty> };

function fieldSchema(tool: (typeof CASES)[number]['tool'], field: string): z.ZodType {
  return ((tool.input as z.ZodObject).shape as Record<string, z.ZodType>)[field] as z.ZodType;
}

describe('date input declaration', () => {
  const matrix = CASES.flatMap(({ tool }) =>
    FIELDS.map((field) => ({ name: tool.name, tool, field })),
  );

  it.each(matrix)(
    '$name advertises $field as a calendar date in inputSchema',
    ({ tool, field }) => {
      const schema = z.toJSONSchema(tool.input) as JsonSchemaObject;
      const property = schema.properties[field];
      expect(property).toMatchObject({ type: 'string', format: 'date' });
      expect(property?.pattern).toEqual(expect.any(String));
      // The advertised pattern itself refuses Feb 30, so a validating client rejects it too.
      const pattern = new RegExp(property?.pattern ?? '');
      expect(pattern.test('2024-02-30')).toBe(false);
      expect(pattern.test('2024-02-29')).toBe(true);
    },
  );

  it.each(matrix)('$name $field accepts every real date, leap days included', ({ tool, field }) => {
    const schema = fieldSchema(tool, field);
    for (const date of REAL) {
      expect(schema.safeParse(date).success, date).toBe(true);
    }
  });
});

describe('impossible calendar dates at argument validation', () => {
  beforeEach(() => {
    upstream.mockReset();
  });

  const matrix = CASES.flatMap(({ tool, rest, range }) =>
    FIELDS.flatMap((field) =>
      IMPOSSIBLE.map((date) => ({ name: tool.name, tool, rest, range, field, date })),
    ),
  );

  it.each(matrix)(
    '$name rejects $field "$date" before the handler runs',
    async ({ tool, rest, range, field, date }) => {
      const result = await runToolContract(tool, { ...rest, ...range, [field]: date } as never);

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          message: expect.stringContaining(field),
          data: { reason: 'invalid_arguments' },
        },
      });
      const text = firstText(result.content);
      expect(text).toContain(field);
      expect(text).toContain('real calendar date');
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it.each(CASES)(
    '$tool.name forwards a leap-day single-day range to the service unchanged',
    async ({ tool, rest }) => {
      upstream.mockRejectedValue(new Error('stop after the request is built'));
      const leapDay = tool === openmeteoGetClimateTool ? '2048-02-29' : '2024-02-29';
      await runToolContract(tool, { ...rest, start_date: leapDay, end_date: leapDay } as never);

      expect(upstream).toHaveBeenCalledTimes(1);
      expect(upstream.mock.calls[0]?.[2]).toMatchObject({ start_date: leapDay, end_date: leapDay });
    },
  );
});
