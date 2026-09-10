/**
 * @fileoverview Test helper for measuring what a tool response actually costs a client.
 *
 * A handler returns its domain payload; the framework then merges the accumulated
 * enrichment into it to build `structuredContent`, and renders the domain payload
 * through `format()` to build `content[0].text`. Both surfaces have to stay inside the
 * server's inline ceiling, and neither is the row array on its own — this reassembles
 * them the way `buildToolSuccessResult` does so a test can assert against the real size.
 * @module tests/helpers/inline-surface
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { inlineBudget } from '@/mcp-server/tools/spill-utils.js';
import type { UnitsMap } from '@/services/open-meteo/types.js';

/**
 * Serialized length of the `structuredContent` a handler result produces — the domain
 * payload merged with its enrichment, exactly as the framework assembles it.
 */
export function structuredSize(result: object, ctx: Context): number {
  return JSON.stringify({ ...result, ...getEnrichment(ctx) }).length;
}

/**
 * The characters this result's preview rows were allowed: the inline ceiling less the
 * response scaffold, any fixed `current` block, and the unit maps the result carries,
 * recomputed the way the handler computed it. Row-array assertions measure against this rather than the whole
 * ceiling, which the maps and the rendered header have already spent part of.
 */
export function rowBudgetFor(result: {
  current?: Record<string, unknown> | undefined;
  current_units?: UnitsMap | undefined;
  daily_units?: UnitsMap | undefined;
  hourly_units?: UnitsMap | undefined;
}): number {
  return inlineBudget(result.current, result.hourly_units, result.daily_units, result.current_units)
    .rowBudget;
}
