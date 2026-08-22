/**
 * @fileoverview Smoke coverage for every tool registered by open-meteo-mcp-server.
 * @module tests/smoke/definitions.smoke.test
 */

import { describe, expect, it } from 'vitest';
import * as definitions from '@/mcp-server/tools/definitions/index.js';

const tools = Object.values(definitions);

describe('server definition smoke test', () => {
  it('loads every registered tool with a complete executable contract', () => {
    expect(tools).toHaveLength(11);

    for (const definition of tools) {
      expect(definition.name).toMatch(/^openmeteo_/);
      expect(definition.description).toEqual(expect.any(String));
      expect(definition.input).toBeDefined();
      expect(definition.output).toBeDefined();
      expect(definition.handler).toEqual(expect.any(Function));
      expect(definition.format).toEqual(expect.any(Function));
    }
  });
});
