/**
 * @fileoverview Guards the advertised tool surface: every registered tool follows
 * the three-token `openmeteo_<verb>_<object>` naming pattern, and the retired
 * `openmeteo_geocode` name is not served as an alias.
 * @module tests/tools/tool-surface.test
 */

import { describe, expect, it } from 'vitest';
import * as definitions from '@/mcp-server/tools/definitions/index.js';

const TOOL_NAMES = Object.values(definitions)
  .map((definition) => definition.name)
  .sort();

describe('advertised tool surface', () => {
  it('registers eleven tools', () => {
    expect(TOOL_NAMES).toHaveLength(11);
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
});
