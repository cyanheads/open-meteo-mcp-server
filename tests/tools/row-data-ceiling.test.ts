/**
 * @fileoverview Tests for the openmeteo_dataframe_query response ceiling: the measure of
 * a page in characters of row data, and how many leading rows fit in 8,000,000 of them.
 * @module tests/tools/row-data-ceiling.test
 */

import { describe, expect, it } from 'vitest';
import { openmeteoDataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { rowDataChars, rowsWithinCeiling } from '@/mcp-server/tools/row-data-ceiling.js';
import { firstText } from '../helpers/content.js';
import { cpuMicrosPerCall } from '../helpers/cpu-time.js';

/** The declared ceiling, written out rather than read from the module under test. */
const CEILING = 8_000_000;

/** The character at UTF-16 code unit `code`, for those a source file should not hold raw. */
const unit = (code: number) => String.fromCharCode(code);

type Rows = Record<string, unknown>[];

/**
 * The page `build` makes with its pad string sized so the page, written as JSON, is
 * exactly `chars` characters. Every value is one JSON writes without escapes and no
 * surface writes longer, so the JSON length is the row data's own size.
 */
function sizedTo(chars: number, build: (pad: string) => Rows): Rows {
  const rows = build('x'.repeat(chars - JSON.stringify(build('')).length));
  expect(JSON.stringify(rows).length).toBe(chars);
  return rows;
}

const SHAPES: [string, (pad: string) => Rows][] = [
  ['one string column', (pad) => [{ note: pad }]],
  [
    'many rows of mixed scalars',
    (pad) => [
      ...Array.from({ length: 5_000 }, (_, i) => ({
        time: `2024-01-01T${String(i % 24).padStart(2, '0')}:00`,
        temperature_2m: -2.3 + i / 10,
        is_day: i % 2 === 0,
        snowfall: null,
        id: '123456789012345',
      })),
      { time: '2024-12-31T23:00', note: pad },
    ],
  ],
  [
    'nested lists and structs',
    (pad) => [
      { s: { a: [1, 2.5, { b: 'é😀', e: [] }], o: {} }, l: [[1, 2], [], [null]] },
      { m: { k: [true, false], deep: { note: pad } } },
    ],
  ],
  [
    'a list of nulls and empty strings',
    (pad) => [
      { l: Array.from({ length: 1_000_000 }, (_, i) => (i % 2 === 0 ? null : '')) },
      { note: pad },
    ],
  ],
];

describe('rowDataChars', () => {
  it('counts a value of plain characters as its JSON length', () => {
    for (const value of [
      { time: '2024-01-01T00:00', temperature_2m: -2.3, ok: true, n: null },
      [1, [2, [3, []]], {}, { a: 'é😀' }],
      '',
      { [`col_${'x'.repeat(50)}`]: 'v' },
    ]) {
      expect(rowDataChars(value)).toBe(JSON.stringify(value).length);
    }
  });

  /**
   * Each character class beside the longest form either surface writes it as: its JSON
   * escape in structuredContent, or its Markdown form in content[] (a numeric reference,
   * or a backslash escape that JSON then doubles).
   */
  it.each([
    ['a plain letter', 'x', 'x'],
    ['a hyphen', '-', '-'],
    ['an accented letter', 'é', 'é'],
    ['a line feed', '\n', '&#10;'],
    ['a carriage return', '\r', '&#13;'],
    ['a tab', '\t', '&#9;'],
    ['a form feed', '\f', '&#12;'],
    ['a backspace', '\b', '\\b'],
    ['a vertical tab', '\v', '\\u000b'],
    ['a control character', '\u0001', '\\u0001'],
    ['a space', ' ', '&#32;'],
    ['a no-break space', unit(0xa0), '&#160;'],
    ['an em space', unit(0x2003), '&#8195;'],
    ['a line separator', unit(0x2028), '&#8232;'],
    ['a paragraph separator', unit(0x2029), '&#8233;'],
    ['an ideographic space', unit(0x3000), '&#12288;'],
    ['a byte order mark', unit(0xfeff), '&#65279;'],
    ['a quote', '"', '\\"'],
    ['a backslash', '\\', '\\\\\\\\'],
    ['a star', '*', '\\\\*'],
    ['a backtick', '`', '\\\\`'],
    ['a bracket', '[', '\\\\['],
    ['a pipe', '|', '\\\\|'],
    ['a tilde', '~', '\\\\~'],
    ['an underscore', '_', '\\\\_'],
    ['an angle bracket', '<', '\\\\<'],
    ['an ampersand', '&', '\\\\&'],
    ['a lone high surrogate', '\ud83d', '\\ud83d'],
    ['a lone low surrogate', '\ude00', '\\ude00'],
  ])('counts %s at the length of %s', (_class, ch, written) => {
    expect(rowDataChars(ch.repeat(1_000))).toBe(2 + 1_000 * written.length);
  });

  it('counts a surrogate pair as its two characters', () => {
    expect(rowDataChars('😀'.repeat(1_000))).toBe(2 + 2_000);
  });

  it('counts an underscore between two letters or digits once, and one at a word edge at its escape', () => {
    expect(rowDataChars('temperature_2m_member01')).toBe(2 + 23);
    expect(rowDataChars('_a_')).toBe(2 + 3 + 1 + 3);
    expect(rowDataChars('a__b')).toBe(2 + 1 + 3 + 3 + 1);
  });

  it('counts each character class at least as long as either surface writes it, whole or inside text', () => {
    const format = openmeteoDataframeQueryTool.format;
    if (!format) throw new Error('openmeteo_dataframe_query has no format()');
    /** Both surfaces' size for a one-cell page, each as JSON carries it on the wire. */
    const written = (cell: string) => {
      const result = {
        rows: [{ c: cell }],
        row_count: 1,
        truncated: false,
        canvas_id: 'abcdefghij',
      };
      return {
        structured: JSON.stringify(result.rows).length,
        content: JSON.stringify(firstText(format(result))).length,
      };
    };
    const empty = written('');
    const classes = [
      ...'x-+=>1.é"\\*`[|~_<&# \t\n\r\f\v\b\u0001',
      ...[0xa0, 0x2003, 0x2028, 0x3000, 0xfeff].map(unit),
      '😀',
      '\ud83d',
    ];
    for (const ch of classes) {
      for (const cell of [ch.repeat(500), `a${`${ch}b`.repeat(500)}`, `${ch}\n`.repeat(500)]) {
        const surfaces = written(cell);
        const counted = rowDataChars([{ c: cell }]) - rowDataChars([{ c: '' }]);
        // A block marker opening a line, or a `#` closing one, takes one backslash in
        // content[] (two once JSON escapes it) that the measure does not count.
        const lineEdges = 4 * cell.split(/\r\n|[\r\n\p{Zl}\p{Zp}]/u).length;
        const label = JSON.stringify(cell.slice(0, 4));
        expect(counted, label).toBeGreaterThanOrEqual(surfaces.structured - empty.structured);
        expect(counted + lineEdges, label).toBeGreaterThanOrEqual(surfaces.content - empty.content);
      }
    }
  });

  it('stops counting past the ceiling', () => {
    const total = rowDataChars(['x'.repeat(CEILING), '\n'.repeat(CEILING)]);
    expect(total).toBeGreaterThan(CEILING);
    expect(total).toBeLessThan(CEILING + 10);
  });
});

describe('rowsWithinCeiling', () => {
  describe.each(SHAPES)('%s', (_shape, build) => {
    it('fits whole at exactly 8,000,000 characters of row data', () => {
      const rows = sizedTo(CEILING, build);
      expect(rowsWithinCeiling(rows)).toBe(rows.length);
    });

    it('leaves out the last row one character over', () => {
      const rows = sizedTo(CEILING + 1, build);
      expect(rowsWithinCeiling(rows)).toBe(rows.length - 1);
    });
  });

  it('counts a character at its longest written form at the boundary', () => {
    // `[{"c":"…"},{"pad":"…"}]` is 21 characters around the two strings' contents, and
    // the twenty line feeds count 100, as `&#10;` each, not the 40 of their JSON escapes.
    const rows = [{ c: '\n'.repeat(20) }, { pad: 'x'.repeat(CEILING - 121) }];
    expect(rowDataChars(rows)).toBe(CEILING);
    expect(rowsWithinCeiling(rows)).toBe(2);
    rows[0] = { c: `${'\n'.repeat(20)}x` };
    expect(rowsWithinCeiling(rows)).toBe(1);
  });

  it('counts the leading rows that fit', () => {
    const row = { note: 'x'.repeat(3_000_000) };
    expect(rowsWithinCeiling([row, row, row])).toBe(2);
    expect(rowsWithinCeiling([row, row])).toBe(2);
  });

  it('counts a value that is only nulls, past the ceiling', () => {
    const rows = [{ l: new Array(2_000_000).fill(null) }];
    expect(JSON.stringify(rows).length).toBeGreaterThan(CEILING);
    expect(rowsWithinCeiling(rows)).toBe(0);
  });

  it('counts column names in every row', () => {
    const name = 'c'.repeat(800);
    const rows = Array.from({ length: 10_000 }, () => ({ [name]: 1 }));
    expect(JSON.stringify(rows).length).toBeGreaterThan(CEILING);
    expect(rowsWithinCeiling(rows)).toBeLessThan(rows.length);
  });

  it('fits an empty page', () => {
    expect(rowsWithinCeiling([])).toBe(0);
  });

  describe('stops at the first value past the ceiling', () => {
    const over = 'x'.repeat(CEILING);
    const unread = () => {
      throw new Error('read past the ceiling');
    };

    it('reads no later row', () => {
      const rows: Rows = [
        { note: over },
        Object.defineProperty({}, 'v', { get: unread, enumerable: true }),
      ];
      expect(rowsWithinCeiling(rows)).toBe(0);
    });

    it('reads no later column of the same row', () => {
      const row = Object.defineProperty({ note: over }, 'v', { get: unread, enumerable: true });
      expect(rowsWithinCeiling([row])).toBe(0);
    });

    it('reads no later element of the same list', () => {
      const list: unknown[] = [over];
      Object.defineProperty(list, 1, { get: unread, enumerable: true });
      expect(rowsWithinCeiling([{ list }])).toBe(0);
    });
  });

  describe('running time', () => {
    /** Generous CPU ceiling per value or character walked. */
    const CPU_MICROS_PER_UNIT = 1;
    const BASE = 5_000;
    const LARGEST = 320_000;

    /** Shapes grown by doubling from 5k values or characters to 320k, the full 64× span. */
    const SIZED: [string, (size: number) => Rows][] = [
      ['a list of nulls', (size) => [{ l: new Array(size).fill(null) }]],
      ['a list of numbers', (size) => [{ l: Array.from({ length: size }, (_, i) => i / 4) }]],
      [
        'one row of many columns',
        (size) => [Object.fromEntries(Array.from({ length: size }, (_, i) => [`c${i}`, i]))],
      ],
      ['many one-column rows', (size) => Array.from({ length: size }, (_, i) => ({ v: i }))],
      ['a repeated opener with no closer', (size) => [{ s: '['.repeat(size) }]],
      ['nested openers', (size) => [{ s: '[!['.repeat(size / 5).padEnd(size, '[') }]],
      ['overlapping prefixes', (size) => [{ s: '&#'.repeat(size / 2) }]],
      ['a whitespace run inside one line', (size) => [{ s: `a${' '.repeat(size)}b` }]],
      ['lone surrogates', (size) => [{ s: '\ud83d'.repeat(size) }]],
      ['one long line ending in a break', (size) => [{ s: `${'§1 x'.repeat(size / 4)}\ny` }]],
      ['breaks throughout', (size) => [{ s: '  \r\n'.repeat(size / 4) }]],
      ['a long digit run', (size) => [{ s: '1'.repeat(size) }]],
    ];

    it.each(SIZED)('stays linear on %s', (_shape, build) => {
      const timeAt = (size: number) => {
        const rows = build(size);
        return cpuMicrosPerCall(
          () => rowsWithinCeiling(rows),
          Math.max(4, Math.ceil(400_000 / size)),
        );
      };

      const base = timeAt(BASE);
      expect(base).toBeLessThan(BASE * CPU_MICROS_PER_UNIT);
      let atLargest = base;
      for (let size = BASE * 2; size <= LARGEST; size *= 2) {
        atLargest = timeAt(size);
        expect(atLargest, `${size} units`).toBeLessThan(size * CPU_MICROS_PER_UNIT);
      }

      // Linear growth over the 64× span is its own size; quadratic would be its square.
      expect(atLargest / base).toBeLessThan(256);
    });
  });
});
