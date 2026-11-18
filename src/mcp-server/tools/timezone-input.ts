/**
 * @fileoverview Shared `timezone` input framing for the seven time-series tools. Covers
 * the ways a bad zone reaches a caller: a blank string, which `openMeteoUrl` omits from
 * the query so upstream falls back to GMT rather than the documented `auto`; and a
 * non-empty zone upstream rejects — one it does not recognize, or a comma-separated list
 * of zones — which arrives in the same `{"error":true,"reason":…}` envelope as an
 * unknown variable name and would otherwise be framed as one. Each tool declares its own
 * `invalid_timezone` contract entry and calls these for the message — the strings live
 * here so seven tools cannot drift apart.
 * @module mcp-server/tools/timezone-input
 */

/**
 * Upstream's rejection of an unrecognized zone — HTTP 400 with
 * `{"reason":"Invalid timezone","error":true}`, verified against both `/v1/forecast` and
 * `/v1/archive`. Anchored at the head so it cannot claim an unrelated envelope that
 * merely mentions a time zone; a genuinely unknown variable name is untouched by it and
 * still classifies as `invalid_variable`.
 */
const INVALID_TIMEZONE_REASON = /^invalid timezone/i;

/**
 * Upstream's rejection of a zone holding a comma: it reads the value as a list of zones,
 * one per coordinate, and a time-series call sends one coordinate — HTTP 400 with this
 * reason, verified against `/v1/forecast` and `/v1/archive`. Anchored the same way.
 */
const ZONE_LIST_REASON =
  /^parameter 'timezone' and coordinates must have the same number of elements/i;

/** Whether an upstream error reason rejects the requested `timezone`. */
export function isInvalidTimezoneReason(upstreamReason: string | undefined): boolean {
  const reason = (upstreamReason ?? '').trim();
  return INVALID_TIMEZONE_REASON.test(reason) || ZONE_LIST_REASON.test(reason);
}

/**
 * Why a blank `timezone` is a caller error rather than a way to ask for the upstream
 * default: every tool schema defaults the field to `auto`, and no documented workflow
 * instructs a caller to send a blank value.
 */
export const BLANK_TIMEZONE_MESSAGE =
  'timezone was blank. Use "auto" or an exact IANA time-zone name such as ' +
  '"America/Los_Angeles", or omit timezone entirely to use the "auto" default.';

/** The surfaced message for an upstream rejection of the requested zone. */
export function frameInvalidTimezoneMessage(upstreamReason: string | undefined): string {
  const raw = (upstreamReason ?? '').trim();
  const guidance = ZONE_LIST_REASON.test(raw)
    ? 'Open-Meteo rejected the requested timezone: the comma made it a list of zones, one per coordinate, and this call has one coordinate. Use "auto" or one exact IANA time-zone name (e.g. "America/Los_Angeles", "Europe/Berlin").'
    : 'Open-Meteo rejected the requested timezone. Use "auto" or an exact IANA time-zone name (e.g. "America/Los_Angeles", "Europe/Berlin").';
  return raw ? `${guidance} (Upstream: ${raw})` : guidance;
}
