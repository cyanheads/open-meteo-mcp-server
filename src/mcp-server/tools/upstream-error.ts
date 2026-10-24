/**
 * @fileoverview Upstream-failure contract entries the tools share, and the framing of
 * Open-Meteo error `reason` strings.
 *
 * The entries cover the failures `OpenMeteoService` raises below every handler and tags
 * with `data.reason` — a 429, a coverage gap, and a retry ladder that runs out — so the
 * handler boundary fills each declaring tool's `recovery` onto the wire.
 *
 * The framing covers the two rejections every time-series tool has to tell apart: an
 * unknown variable or model name, and a request whose sheer volume upstream refuses.
 * Both arrive in the same `{"error":true,"reason":…}` envelope with no machine-readable
 * code, so the reason string is all there is to classify on.
 *
 * The forecast/archive-family endpoints reject unknown variable names with
 * an internal Swift type-init message ("Data corrupted at path ''. Cannot initialize
 * <Type> from invalid String value <value>.") that neither leads with the fix nor cleanly
 * names the problem. This helper leads with actionable guidance, names the offending
 * value(s) when the upstream message embeds them, and demotes the raw upstream string
 * to a trailing parenthetical. No client-side variable allowlist — the API stays the
 * authority on what is valid; this only reframes its rejection.
 * @module mcp-server/tools/upstream-error
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { coverageGapRecovery } from '@/services/open-meteo/coverage-gap.js';

/**
 * The `rate_limited` entry every upstream-calling tool declares in its `errors` contract.
 * The service throws it (see `rateLimitError` in `open-meteo-service.ts`), so the handler
 * boundary fills this `recovery` onto the wire.
 */
export const RATE_LIMITED_ERROR = {
  reason: 'rate_limited',
  code: JsonRpcErrorCode.RateLimited,
  when: 'Open-Meteo answered HTTP 429 because a free-tier request limit was reached.',
  recovery:
    'Wait before calling again. A per-minute, per-hour, or per-day limit reopens only when its window does (the message names which when Open-Meteo reports it), so an immediate retry gets the same rejection; "Too many concurrent requests" clears within seconds, once the requests already in flight finish.',
  thrownBy: 'service',
} as const;

/**
 * The `upstream_unavailable` entry every upstream-calling tool declares: the service's
 * three attempts all failed on an unreachable host, a 5xx, or an unreadable body (a CDN
 * HTML page, malformed JSON), and the last of them was not a timeout.
 */
export const UPSTREAM_UNAVAILABLE_ERROR = {
  reason: 'upstream_unavailable',
  code: JsonRpcErrorCode.ServiceUnavailable,
  when: 'Open-Meteo was unreachable, answered with a server error, or returned an unreadable response on all three attempts.',
  recovery:
    'Open-Meteo is unavailable right now, and this call already made three attempts. Wait a minute or two, then call again with the same arguments.',
  thrownBy: 'service',
} as const;

/**
 * The `upstream_timeout` entry every upstream-calling tool declares: the same exhausted
 * ladder, ending on the 15 s per-attempt timeout. A slow answer can be the request's own
 * size, so the recovery offers asking for less beside waiting.
 */
export const UPSTREAM_TIMEOUT_ERROR = {
  reason: 'upstream_timeout',
  code: JsonRpcErrorCode.ServiceUnavailable,
  when: 'Open-Meteo failed on all three attempts, and the last one got no answer within 15 seconds.',
  recovery:
    'Wait a minute, then call again. If the request is large, ask for less in one call (fewer variables, models, or coordinates, or a shorter date range or forecast window) so it can finish in time.',
  thrownBy: 'service',
} as const;

/** The endpoints whose tools reach a coverage gap and declare `coverage_gap`. */
type CoverageGapOperation = 'forecast' | 'ensemble' | 'historical' | 'marine' | 'flood';

/**
 * The `coverage_gap` entry for a tool that reaches the gap. Its recovery is the sentence
 * the service already writes into the rejection's message for that endpoint, so the
 * handler boundary fills the hint without `content[]` stating it twice.
 */
export function coverageGapContract(operation: CoverageGapOperation) {
  return {
    reason: 'coverage_gap',
    code: JsonRpcErrorCode.ValidationError,
    when: 'Open-Meteo has no data at this coordinate for the requested dataset or model, because its grid or domain does not reach the point.',
    recovery: coverageGapRecovery(operation),
    thrownBy: 'service',
  } as const;
}

/** The upstream type-init message shape: `… from invalid String value <value>.` */
const INVALID_VALUE_PATTERN = /from invalid String value (.+?)\.?$/;

/**
 * The value(s) an upstream type-init rejection named. Normally one: the service sends
 * every comma-joined list with a literal comma, so upstream parses it as a list and
 * names the single offending entry rather than echoing the whole request. The split
 * stays because the message is upstream's to shape — a parameter it does read as one
 * opaque value would come back as a list, and naming all of it beats naming none of it.
 * Empty when the message is some other shape.
 *
 * Module-private: {@link frameInvalidVariableMessage} is the only reader, and the only
 * surface a caller needs.
 */
function extractInvalidValues(upstreamReason: string | undefined): string[] {
  return (
    INVALID_VALUE_PATTERN.exec((upstreamReason ?? '').trim())?.[1]
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? []
  );
}

/**
 * Builds the surfaced error message for an upstream unknown-variable rejection.
 *
 * @param upstreamReason - Raw `reason` from the Open-Meteo error envelope.
 * @param label - What kind of name was rejected — "variable" for most tools,
 *   "variable or model" for the endpoints whose tool takes `models` — historical,
 *   ensemble, climate, flood ("discharge variable or model"), and forecast when
 *   models were sent (their `models` parameter is rejected through the same envelope).
 */
export function frameInvalidVariableMessage(
  upstreamReason: string | undefined,
  label = 'variable',
): string {
  const raw = (upstreamReason ?? '').trim();
  const offenders = extractInvalidValues(raw);

  if (offenders.length === 1) {
    return (
      `Unknown ${label} name: ${offenders[0]}. Remove or correct it and retry — ` +
      `names must be exact Open-Meteo API names. (Upstream: ${raw})`
    );
  }

  if (offenders.length > 1) {
    // Upstream named several values in one message — without an allowlist we can only
    // say at least one of them is invalid.
    return (
      `At least one of the requested ${label} names is not a valid Open-Meteo API name: ` +
      `${offenders.join(', ')}. Correct or remove the invalid name(s) and retry. (Upstream: ${raw})`
    );
  }

  const guidance = `The API rejected a requested ${label} name. Check that every name is an exact Open-Meteo API name and retry.`;
  return raw ? `${guidance} (Upstream: ${raw})` : guidance;
}

/**
 * The declared `invalid_variable` recovery of a tool that takes `models`: its own
 * `variableRecovery` plus the documented model list. A call that sent no models can only
 * have had a variable rejected, so its handler hints `variableRecovery` alone.
 *
 * @param documentedModels - The catalog's comma-joined model names.
 */
export function variableOrModelRecovery(
  variableRecovery: string,
  documentedModels: string,
): string {
  return `${variableRecovery} Documented models: ${documentedModels}. When the message names one model, correct only that one — the rest of the models list is valid.`;
}

/**
 * Upstream's volume rejection — HTTP 400 with `{"error":true,"reason":"Your API call
 * requests too much data. Please reduce the number of variables, locations and/or
 * weather models."}`, verified against both `/v1/climate` and `/v1/archive`. Anchored at
 * the head so it cannot claim an envelope that merely mentions the phrase, and so an
 * unknown-name rejection — which carries none of this wording — still classifies as one.
 */
const TOO_MUCH_DATA_REASON = /^your api call requests too much data/i;

export function isRequestTooLargeReason(upstreamReason: string | undefined): boolean {
  return TOO_MUCH_DATA_REASON.test((upstreamReason ?? '').trim());
}

/**
 * Builds the surfaced message for the volume rejection. Every name in the request is
 * valid — saying so is what keeps the caller off the spelling check
 * {@link frameInvalidVariableMessage} would otherwise send them on.
 *
 * @param upstreamReason - Raw `reason` from the Open-Meteo error envelope.
 * @param narrowing - The requesting tool's own inputs that shrink the payload, e.g.
 *   `'fewer daily_variables, fewer models, or a shorter start_date–end_date range'`.
 *   Named per tool because the levers differ: only some take `models`, and only some
 *   take a date range.
 */
export function frameRequestTooLargeMessage(
  upstreamReason: string | undefined,
  narrowing: string,
): string {
  const raw = (upstreamReason ?? '').trim();
  const guidance =
    'Open-Meteo rejected this request as asking for too much data at once. Every requested ' +
    `name is valid — narrow the request and retry: ${narrowing}.`;
  return raw ? `${guidance} (Upstream: ${raw})` : guidance;
}
