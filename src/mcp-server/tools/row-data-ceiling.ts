/**
 * @fileoverview The response ceiling on openmeteo_dataframe_query: the most row data one
 * response carries, and the measure of a page against it.
 * @module mcp-server/tools/row-data-ceiling
 */

/**
 * Most characters of row data one openmeteo_dataframe_query response carries. It bounds
 * what one response costs the server to build: a page over it is refused, never cut.
 */
export const ROW_DATA_CEILING_CHARS = 8_000_000;

/**
 * Characters each ASCII code unit is written as on whichever surface writes it longer:
 * `structuredContent` as JSON, or `content[]` as escaped Markdown, then as JSON.
 */
const ASCII_CHARS = (() => {
  const chars = new Uint8Array(128).fill(1);
  chars.fill(6, 0x00, 0x20); // `\u0001` in JSON
  chars[0x08] = 2; // `\b`
  chars[0x09] = 4; // `&#9;`
  chars[0x0a] = 5; // `&#10;`
  chars[0x0c] = 5; // `&#12;`
  chars[0x0d] = 5; // `&#13;`
  chars[0x20] = 5; // `&#32;`
  chars[0x22] = 2; // `\"`
  chars[0x5c] = 4; // `\\`, then `\\\\` in JSON
  for (const ch of '`*[]|~_<&') chars[ch.charCodeAt(0)] = 3; // `\*`, then `\\*` in JSON
  return chars;
})();

const UNDERSCORE = 0x5f;

/** Whether `code` is an ASCII letter or digit; false past either end of a string (`NaN`). */
function isAsciiWordChar(code: number): boolean {
  const lower = code | 0x20;
  return (code >= 0x30 && code <= 0x39) || (lower >= 0x61 && lower <= 0x7a);
}

/** {@link ASCII_CHARS} for a code unit past ASCII, reading its neighbours for a surrogate's pair. */
function wideChars(code: number, text: string, i: number): number {
  if (code >= 0xd800 && code <= 0xdfff) {
    const paired =
      code <= 0xdbff
        ? (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00
        : (text.charCodeAt(i - 1) & 0xfc00) === 0xd800;
    return paired ? 1 : 6; // `\udc00` in JSON
  }
  if (code === 0x3000 || code === 0xfeff) return 8; // `&#12288;`
  if (
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f
  ) {
    return 7; // `&#8232;`
  }
  return code === 0xa0 ? 6 : 1; // `&#160;`
}

/**
 * Characters of row data in `value`: its length written as JSON, with each character
 * counted at the most characters either response surface writes a top-level string's
 * character as. A string adds
 * its two quotes and its characters: a line break, control character, or whitespace at
 * the length of its JSON escape or Markdown numeric reference (2 to 8), a backslash at
 * 4, each of `` ` * [ ] | ~ _ < & `` at 3 and a quote at 2 for their escapes (except an
 * underscore between two ASCII letters or digits, which neither surface escapes), a
 * lone surrogate at 6, every other character at 1. A number, boolean, or null adds the
 * length of its printed form; a struct its braces and, per field, the field name
 * counted as a string, the colon, the separating comma, and the value; a list its
 * brackets, separating commas, and elements. So column names count in every row, and
 * nested lists and structs at every level, and a value of plain characters counts as
 * its JSON length. Not counted, so the measure estimates content[] rather than bounding
 * it: the one backslash content[] gives a block marker that opens a line, or a `#` that
 * closes one; the second escaping content[] gives a string nested in a list or struct,
 * which it renders as JSON and then escapes; and the table's header and delimiter rows.
 *
 * Allocates nothing proportional to `value`: it walks it adding lengths, and stops
 * reading as soon as the total passes {@link ROW_DATA_CEILING_CHARS}, returning a total
 * past the ceiling rather than the whole count.
 */
export function rowDataChars(value: unknown): number {
  return addChars(0, value);
}

/**
 * How many leading rows of `rows` fit within {@link ROW_DATA_CEILING_CHARS} characters of
 * row data ({@link rowDataChars}) — `rows.length` when the whole page does. The page
 * counts as the list of its rows, so the first `n` rows fit while
 * `rowDataChars(rows.slice(0, n))` stays within the ceiling.
 */
export function rowsWithinCeiling(rows: readonly Record<string, unknown>[]): number {
  let total = 1; // The page's opening bracket; each row below adds its comma or the closing one.
  for (let i = 0; i < rows.length; i++) {
    total = addChars(total + 1, rows[i]);
    if (total > ROW_DATA_CEILING_CHARS) return i;
  }
  return rows.length;
}

/** `total` plus the characters of row data in `value`, or a sum past the ceiling once it gets there. */
function addChars(total: number, value: unknown): number {
  if (typeof value === 'string') return addStringChars(total, value);
  if (value === null || typeof value !== 'object') return total + String(value).length;
  let sum = total + 1; // The opening bracket or brace; each item below adds its comma or the closing one.
  let items = 0;
  if (Array.isArray(value)) {
    for (const item of value) {
      sum = addChars(sum + 1, item);
      if (sum > ROW_DATA_CEILING_CHARS) return sum;
      items++;
    }
  } else {
    for (const key in value) {
      sum = addChars(addStringChars(sum + 2, key), (value as Record<string, unknown>)[key]);
      if (sum > ROW_DATA_CEILING_CHARS) return sum;
      items++;
    }
  }
  return items === 0 ? sum + 1 : sum;
}

/**
 * `total` plus `text` as a quoted string, its characters counted as
 * {@link rowsWithinCeiling} counts them; stops reading once the sum is past the ceiling.
 */
function addStringChars(total: number, text: string): number {
  let sum = total + 2;
  // Every character counts at least once, so a string that cannot fit is not read.
  if (sum + text.length > ROW_DATA_CEILING_CHARS) return sum + text.length;
  for (let i = 0; i < text.length && sum <= ROW_DATA_CEILING_CHARS; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x80) sum += wideChars(code, text, i);
    else if (
      code === UNDERSCORE &&
      isAsciiWordChar(text.charCodeAt(i - 1)) &&
      isAsciiWordChar(text.charCodeAt(i + 1))
    ) {
      sum += 1; // Between two letters or digits, as in `temperature_2m`, nothing escapes it.
    } else sum += ASCII_CHARS[code] as number;
  }
  return sum;
}
