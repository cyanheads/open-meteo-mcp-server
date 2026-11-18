/**
 * @fileoverview Shared input handling for the variable- and model-name lists of the
 * seven weather tools. {@link nameList} is the schema of every list field: it also takes
 * the names as one comma-joined string, Open-Meteo's own list format. Open-Meteo reads
 * every comma in a list value as a separator, answers a blank name with a timestamp-only
 * success, and rejects a padded one under a message that prints it as a valid-looking
 * name. So each handler runs its lists through {@link cleanNames} before its cadence
 * check, its other guards, and the upstream request: an element holding a comma becomes
 * the names it joins, every name is trimmed, and blank ones are dropped. A field left
 * with no names reads as not provided. Names are not checked against any allowlist here.
 * @module mcp-server/tools/name-input
 */

import { z } from '@cyanheads/mcp-ts-core';

/**
 * Splits a comma-joined string into its names. A string opening with `[` or `{` is left
 * whole for the framework's JSON-string repair, and an array passes through unchanged,
 * so the schema's cap counts its elements; {@link cleanNames} splits them later.
 */
function splitJoinedNames(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const head = value.trimStart()[0];
  return head === '[' || head === '{' ? value : value.split(',');
}

/**
 * The rejection for a value that is neither a list nor a joined string. A field behind
 * `z.preprocess()` gets no framework-written "Send … as an array" hint, so the message
 * carries the remedy itself.
 */
function notANameList(value: unknown): string {
  if (typeof value === 'string') {
    return 'Send an array of names; this string is not a well-formed JSON array.';
  }
  return `Send an array of names, not ${typeof value === 'object' ? 'an object' : `a ${typeof value}`}.`;
}

/**
 * An optional list of at most `maxNames` variable or model names, also accepted as one
 * comma-joined string. Advertises exactly `z.array(z.string()).max(maxNames).optional()`:
 * `tools/list` emits only the inner schema of a preprocess, so the string form is
 * accepted without being offered. Put the field's `.describe()` on the result. The cap
 * counts array elements and the segments of a joined string, blank ones included; an
 * array element holding a comma counts once however many names it joins.
 * {@link cleanNames} splits those elements and drops the blank names.
 */
export function nameList(maxNames: number) {
  return z.preprocess(
    splitJoinedNames,
    z
      .array(z.string(), {
        error: (issue) => (issue.code === 'invalid_type' ? notANameList(issue.input) : undefined),
      })
      .max(maxNames)
      .optional(),
  );
}

/**
 * Splits each element on commas, trims every name, and drops blank ones, keeping the
 * order; `undefined` when none remain. `["a,b"]` and `["a", "b"]` come out the same.
 */
export function cleanNames(names: readonly string[] | undefined): string[] | undefined {
  const cleaned = names
    ?.flatMap((name) => name.split(','))
    .map((name) => name.trim())
    .filter((name) => name !== '');
  return cleaned?.length ? cleaned : undefined;
}
