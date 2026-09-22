/**
 * @fileoverview Pins where each tool's declared error reasons are produced. A reason is
 * either thrown by a literal `ctx.fail('<reason>'` in the handler, or produced below it
 * and marked `thrownBy: 'service'`. The linter's `error-contract-unthrown` rule reads
 * that marker, so a stale one silences it for a reason the handler really throws, and a
 * missing one lets a dead entry go unreported. The rule also skips any handler holding
 * no literal `ctx.fail(`; this test reads every tool regardless.
 * @module tests/tools/error-contract.test
 */

import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import * as definitions from '@/mcp-server/tools/definitions/index.js';

/**
 * Reasons each tool marks `thrownBy: 'service'`. Empty throughout: every declared
 * reason is thrown by the handler itself — the canvas and SQL-gate failures the
 * dataframe tools declare are caught from the framework and rethrown through
 * `ctx.fail`, so they count as handler-thrown too.
 */
const SERVICE_MARKED: Record<string, readonly string[]> = {
  openmeteo_dataframe_describe: [],
  openmeteo_dataframe_query: [],
  openmeteo_get_air_quality: [],
  openmeteo_get_climate: [],
  openmeteo_get_elevation: [],
  openmeteo_get_ensemble: [],
  openmeteo_get_flood: [],
  openmeteo_get_forecast: [],
  openmeteo_get_historical: [],
  openmeteo_get_marine: [],
  openmeteo_search_locations: [],
};

const tools = Object.values(definitions);

function contractOf(tool: (typeof tools)[number]): readonly ErrorContract[] {
  return (tool.errors ?? []) as readonly ErrorContract[];
}

/** Reasons named by a literal `ctx.fail('<reason>'` in the handler source. */
function handlerThrown(tool: (typeof tools)[number]): Set<string> {
  const source = tool.handler.toString();
  return new Set(
    [...source.matchAll(/ctx\.fail\(\s*["'`]([a-z_]+)["'`]/g)].map((m) => m[1] as string),
  );
}

function serviceMarked(tool: (typeof tools)[number]): string[] {
  return contractOf(tool)
    .filter((entry) => entry.thrownBy === 'service')
    .map((entry) => entry.reason)
    .sort();
}

describe('error contract production sites', () => {
  it('covers every registered tool', () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(SERVICE_MARKED).sort());
  });

  it.each(tools)('$name marks exactly the expected reasons thrownBy: service', (tool) => {
    expect(serviceMarked(tool)).toEqual([...(SERVICE_MARKED[tool.name] ?? [])].sort());
  });

  it.each(tools)('$name declares no reason that nothing produces', (tool) => {
    const thrown = handlerThrown(tool);
    const marked = new Set(serviceMarked(tool));
    const dead = contractOf(tool)
      .map((entry) => entry.reason)
      .filter((reason) => !thrown.has(reason) && !marked.has(reason));
    expect(dead).toEqual([]);
  });

  it.each(tools)('$name marks no handler-thrown reason as service-produced', (tool) => {
    const thrown = handlerThrown(tool);
    expect(serviceMarked(tool).filter((reason) => thrown.has(reason))).toEqual([]);
  });

  it('reads a handler-thrown reason as handler-thrown and unmarked', () => {
    const tool = definitions.openmeteoSearchLocationsTool;
    expect(handlerThrown(tool).has('no_results')).toBe(true);
    expect(serviceMarked(tool)).not.toContain('no_results');
  });
});
