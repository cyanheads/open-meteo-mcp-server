/**
 * @fileoverview Every `canvas_id` input on the surface is declared with the framework's
 * `CanvasIdSchema`: the minted 10-character shape reaches `inputSchema`, and a value
 * that could never be a minted id is rejected at argument validation — before the
 * handler, the canvas, or any upstream request runs. Output `canvas_id` fields stay
 * plain strings, since those ids came from the server.
 * @module tests/tools/canvas-id-input.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openmeteoDataframeDescribeTool,
  openmeteoDataframeQueryTool,
  openmeteoGetAirQualityTool,
  openmeteoGetClimateTool,
  openmeteoGetEnsembleTool,
  openmeteoGetFloodTool,
  openmeteoGetForecastTool,
  openmeteoGetHistoricalTool,
  openmeteoGetMarineTool,
} from '@/mcp-server/tools/definitions/index.js';
import { firstText } from '../helpers/content.js';

const acquire = vi.fn();
vi.mock('@/services/canvas-accessor.js', () => ({
  getCanvas: () => ({ acquire }),
}));

/** One spy behind every service method — any upstream call means the handler ran. */
const upstream = vi.fn();
vi.mock('@/services/open-meteo/open-meteo-service.js', () => ({
  getOpenMeteoService: () =>
    Object.fromEntries(
      [
        'getGeocode',
        'getForecast',
        'getHistorical',
        'getMarine',
        'getAirQuality',
        'getEnsemble',
        'getFlood',
        'getClimate',
        'getElevation',
      ].map((method) => [method, upstream]),
    ),
}));

const SEATTLE = { latitude: 47.6, longitude: -122.3 };

/** Each tool that takes a canvas_id, with the rest of an otherwise valid call. */
const CASES = [
  { tool: openmeteoDataframeDescribeTool, rest: {}, required: true },
  { tool: openmeteoDataframeQueryTool, rest: { sql: 'SELECT 1' }, required: true },
  {
    tool: openmeteoGetForecastTool,
    rest: { ...SEATTLE, hourly_variables: ['temperature_2m'] },
    required: false,
  },
  {
    tool: openmeteoGetHistoricalTool,
    rest: {
      ...SEATTLE,
      start_date: '2024-07-01',
      end_date: '2024-07-02',
      daily_variables: ['temperature_2m_max'],
    },
    required: false,
  },
  {
    tool: openmeteoGetMarineTool,
    rest: { ...SEATTLE, hourly_variables: ['wave_height'] },
    required: false,
  },
  {
    tool: openmeteoGetAirQualityTool,
    rest: { ...SEATTLE, hourly_variables: ['pm2_5'] },
    required: false,
  },
  {
    tool: openmeteoGetEnsembleTool,
    rest: { ...SEATTLE, hourly_variables: ['temperature_2m'] },
    required: false,
  },
  {
    tool: openmeteoGetFloodTool,
    rest: { ...SEATTLE, daily_variables: ['river_discharge'] },
    required: false,
  },
  {
    tool: openmeteoGetClimateTool,
    rest: {
      ...SEATTLE,
      start_date: '2049-01-01',
      end_date: '2049-01-02',
      daily_variables: ['temperature_2m_max'],
    },
    required: false,
  },
] as const;

/** Values no registry mint can produce: wrong length either side, a disallowed character, blank. */
const MALFORMED = ['x', 'abc123456', 'abc12345678', 'abc/123456', 'abc 123456', ''];

type JsonSchemaObject = { properties: Record<string, { pattern?: string }>; required?: string[] };

describe('canvas_id input declaration', () => {
  it.each(CASES)('$tool.name advertises the minted id pattern in inputSchema', ({ tool }) => {
    const schema = z.toJSONSchema(tool.input) as JsonSchemaObject;
    expect(schema.properties.canvas_id?.pattern).toBe('^[A-Za-z0-9_-]{10}$');
  });

  it.each(CASES)('$tool.name output canvas_id stays a plain string', ({ tool }) => {
    const schema = z.toJSONSchema(tool.output, { io: 'output' }) as JsonSchemaObject;
    expect(schema.properties.canvas_id).toBeDefined();
    expect(schema.properties.canvas_id?.pattern).toBeUndefined();
  });

  it.each(CASES)(
    '$tool.name requires canvas_id only where the tool cannot mint one',
    ({ tool, required }) => {
      const shape = (tool.input as z.ZodObject).shape as Record<string, z.ZodType>;
      const field = shape.canvas_id as z.ZodType;
      expect(field.safeParse(undefined).success).toBe(!required);
    },
  );

  it.each(CASES)(
    '$tool.name accepts a 10-character id using every allowed character class',
    ({ tool }) => {
      const shape = (tool.input as z.ZodObject).shape as Record<string, z.ZodType>;
      expect((shape.canvas_id as z.ZodType).safeParse('Az09-_Az09').success).toBe(true);
    },
  );
});

describe('malformed canvas_id at argument validation', () => {
  beforeEach(() => {
    acquire.mockReset();
    upstream.mockReset();
  });

  const matrix = CASES.flatMap(({ tool, rest }) =>
    MALFORMED.map((canvasId) => ({ name: tool.name, tool, rest, canvasId })),
  );

  it.each(matrix)(
    '$name rejects canvas_id "$canvasId" before the handler runs',
    async ({ tool, rest, canvasId }) => {
      const result = await runToolContract(tool, { ...rest, canvas_id: canvasId } as never);

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          message: expect.stringContaining('canvas_id'),
          data: { reason: 'invalid_arguments' },
        },
      });
      const text = firstText(result.content);
      expect(text).toContain('canvas_id');
      expect(text).toContain('reason invalid_arguments');
      expect(acquire).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
    },
  );
});
