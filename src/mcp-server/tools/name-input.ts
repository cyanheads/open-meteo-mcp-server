/**
 * @fileoverview Shared input handling for the variable- and model-name lists of the
 * seven weather tools. {@link nameList} is the schema of every list field: it also takes
 * the names as one comma-joined string, Open-Meteo's own list format. Open-Meteo answers
 * a blank name with a timestamp-only success and rejects a padded one under a message
 * that prints it as a valid-looking name, so each handler trims every name and drops the
 * blank ones before its cadence check, its `no_variables_requested` guard, and the
 * upstream request. A field left with no names reads as not provided. Names are not
 * checked against any allowlist here.
 * @module mcp-server/tools/name-input
 */

import { z } from '@cyanheads/mcp-ts-core';

/**
 * Splits a comma-joined string into its names. A string opening with `[` or `{` is left
 * whole for the framework's JSON-string repair, and an array passes through unchanged:
 * its elements are not split.
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
 * accepted without being offered. Put the field's `.describe()` on the result. Blank
 * segments survive the split and count toward `maxNames`; {@link cleanNames} drops them.
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

/** Trims each name and drops blank ones; `undefined` when none remain. */
export function cleanNames(names: readonly string[] | undefined): string[] | undefined {
  const cleaned = names?.map((name) => name.trim()).filter((name) => name !== '');
  return cleaned?.length ? cleaned : undefined;
}

/** Trims a single name; `undefined` when it is blank. */
export function cleanName(name: string | undefined): string | undefined {
  return name?.trim() || undefined;
}
