/**
 * @fileoverview Guards the advertised tool surface: every registered tool follows
 * the three-token `openmeteo_<verb>_<object>` naming pattern, the retired
 * `openmeteo_geocode` name is not served as an alias, and no advertised text carries
 * SQL the canvas rejects.
 * @module tests/tools/tool-surface.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import * as definitions from '@/mcp-server/tools/definitions/index.js';

const TOOL_NAMES = Object.values(definitions)
  .map((definition) => definition.name)
  .sort();

describe('advertised tool surface', () => {
  it('registers twelve tools', () => {
    expect(TOOL_NAMES).toHaveLength(12);
  });

  it('names every tool openmeteo_<verb>_<object> — never a bare two-token name', () => {
    for (const name of TOOL_NAMES) {
      expect(name).toMatch(/^openmeteo_[a-z0-9]+_[a-z0-9_]+$/);
      expect(name.split('_').length).toBeGreaterThanOrEqual(3);
    }
  });

  it('serves openmeteo_search_locations and no openmeteo_geocode alias', () => {
    expect(TOOL_NAMES).toContain('openmeteo_search_locations');
    expect(TOOL_NAMES).not.toContain('openmeteo_geocode');
  });

  it('advertises no -> lambda; SQL examples use the lambda x: form (#78)', () => {
    const advertised = Object.values(definitions).map((definition) =>
      JSON.stringify({
        description: definition.description,
        input: z.toJSONSchema(definition.input),
        output: z.toJSONSchema(definition.output),
      }),
    );
    expect(advertised).toHaveLength(12);
    for (const text of advertised) expect(text).not.toContain('->');
    // The dataframe query description still teaches the lambda form that does work.
    expect(definitions.openmeteoDataframeQueryTool.input.shape.sql.description).toContain(
      'lambda x: x > 0.5',
    );
  });
});
