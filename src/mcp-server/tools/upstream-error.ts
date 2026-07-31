/**
 * @fileoverview Frames Open-Meteo upstream error `reason` strings for unknown-variable
 * rejections. The forecast/archive-family endpoints reject unknown variable names with
 * an internal Swift type-init message ("Data corrupted at path ''. Cannot initialize
 * <Type> from invalid String value <value>.") that neither leads with the fix nor cleanly
 * names the problem. This helper leads with actionable guidance, names the offending
 * value(s) when the upstream message embeds them, and demotes the raw upstream string
 * to a trailing parenthetical. No client-side variable allowlist — the API stays the
 * authority on what is valid; this only reframes its rejection.
 * @module mcp-server/tools/upstream-error
 */

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
 *   "variable or model" for the ensemble and climate endpoints (their `models`
 *   parameter is rejected through the same envelope).
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
