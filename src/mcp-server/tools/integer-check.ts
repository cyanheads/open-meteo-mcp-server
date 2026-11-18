/**
 * @fileoverview The integer rule for a clamped numeric input (`limit`, `count`), shared by
 * the tools whose cap is lowered rather than rejected while OPENMETEO_CLAMP_LIMITS is on.
 * @module mcp-server/tools/integer-check
 */

import type { z } from '@cyanheads/mcp-ts-core';

/**
 * A `.check()` that rejects a non-integer. It stands in for `.int()`, whose safe-integer
 * range would reject 1e20 where clamping lowers it to the cap. Put it first in the chain:
 * its issue stops the later checks, so a fraction fails on this rule alone, as it did under
 * `.int()`. The schema still advertises `integer` only through `.meta({ type: 'integer' })`,
 * which the caller adds.
 */
export function integerCheck(payload: z.core.ParsePayload<number>): void {
  if (!Number.isInteger(payload.value)) {
    payload.issues.push({ code: 'invalid_type', expected: 'int', input: payload.value });
  }
}
