/**
 * @fileoverview Shared cleanup for the variable- and model-name inputs of the seven
 * weather tools. Open-Meteo answers a blank name with a timestamp-only success and
 * rejects a padded one under a message that prints it as a valid-looking name, so each
 * handler trims every name and drops the blank ones before its cadence check, its
 * `no_variables_requested` guard, and the upstream request. A field left with no names
 * reads as not provided. Names are not checked against any allowlist here.
 * @module mcp-server/tools/name-input
 */

/** Trims each name and drops blank ones; `undefined` when none remain. */
export function cleanNames(names: readonly string[] | undefined): string[] | undefined {
  const cleaned = names?.map((name) => name.trim()).filter((name) => name !== '');
  return cleaned?.length ? cleaned : undefined;
}

/** Trims a single name; `undefined` when it is blank. */
export function cleanName(name: string | undefined): string | undefined {
  return name?.trim() || undefined;
}
