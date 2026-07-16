/**
 * @fileoverview Tests for the shared DataCanvas spill helpers.
 * Fixtures mirror real Open-Meteo response shapes: ensemble past_days responses
 * opening with all-null placeholder rows, concatenated hourly + daily records,
 * string-valued daily variables (sunrise/sunset), and per-member column fan-out.
 * @module tests/tools/spill-utils.test
 */

import { type CanvasInstance, spillover } from '@cyanheads/mcp-ts-core/canvas';
import { describe, expect, it, vi } from 'vitest';
import {
  deriveSpillSchema,
  exceedsInlineBudget,
  PREVIEW_CHARS,
} from '@/mcp-server/tools/spill-utils.js';
import type { TimeRecord } from '@/services/open-meteo/types.js';

/** Column type by name, for order-independent assertions. */
const typeOf = (schema: ReturnType<typeof deriveSpillSchema>, name: string) =>
  schema.find((c) => c.name === name)?.type;

const names = (schema: ReturnType<typeof deriveSpillSchema>) => schema.map((c) => c.name);

describe('deriveSpillSchema', () => {
  it('types a column from its real values when a long all-null run leads the set', () => {
    // #21: an ensemble past_days response opens with placeholder rows the models
    // don't hindcast. Typing from a leading window sees only nulls and falls back
    // to VARCHAR, which then coerces every real number through String().
    const records: TimeRecord[] = [
      ...Array.from({ length: 240 }, (_, i) => ({
        time: `2026-06-${String((i % 28) + 1).padStart(2, '0')}T00:00`,
        temperature_2m_member01: null,
        temperature_2m_member02: null,
      })),
      { time: '2026-07-09T17:00', temperature_2m_member01: 25.9, temperature_2m_member02: 24.1 },
      { time: '2026-07-09T18:00', temperature_2m_member01: 26.3, temperature_2m_member02: 25.0 },
    ];

    const schema = deriveSpillSchema(records);

    expect(typeOf(schema, 'temperature_2m_member01')).toBe('DOUBLE');
    expect(typeOf(schema, 'temperature_2m_member02')).toBe('DOUBLE');
    expect(typeOf(schema, 'time')).toBe('VARCHAR');
  });

  it('unions hourly and daily columns when both cadences are concatenated', () => {
    // #22: hourly records precede daily ones. A leading-window sniff never reaches
    // a daily row, so daily-only columns are never created on the table.
    const hourly: TimeRecord[] = Array.from({ length: 2160 }, (_, i) => ({
      time: `2023-01-01T${String(i % 24).padStart(2, '0')}:00`,
      temperature_2m: 3.5 + (i % 10),
    }));
    const daily: TimeRecord[] = Array.from({ length: 90 }, (_, i) => ({
      time: `2023-01-${String((i % 28) + 1).padStart(2, '0')}`,
      precipitation_sum: i % 2 === 0 ? 0.6 : 0,
    }));

    const schema = deriveSpillSchema([...hourly, ...daily]);

    expect(names(schema)).toEqual(['time', 'temperature_2m', 'precipitation_sum']);
    expect(typeOf(schema, 'temperature_2m')).toBe('DOUBLE');
    expect(typeOf(schema, 'precipitation_sum')).toBe('DOUBLE');
  });

  it('keeps string-valued daily variables VARCHAR', () => {
    // sunrise/sunset are ISO 8601 strings from the live API, not numbers — a
    // blanket "weather columns are numeric" rule would corrupt them.
    const records: TimeRecord[] = [
      {
        time: '2023-01-01',
        sunrise: '2023-01-01T08:57',
        sunset: '2023-01-01T17:28',
        temperature_2m_max: 7.7,
      },
      {
        time: '2023-01-02',
        sunrise: '2023-01-02T08:57',
        sunset: '2023-01-02T17:29',
        temperature_2m_max: 7.1,
      },
    ];

    const schema = deriveSpillSchema(records);

    expect(typeOf(schema, 'sunrise')).toBe('VARCHAR');
    expect(typeOf(schema, 'sunset')).toBe('VARCHAR');
    expect(typeOf(schema, 'temperature_2m_max')).toBe('DOUBLE');
  });

  it('widens a column whose leading value is whole but later values are fractional', () => {
    // Live precipitation arrives as [0, 0.5, 0, …]. Typing from the first non-null
    // value alone would call this column integer; the appender coerces to BIGINT
    // through Math.trunc, so 0.5mm of rain would silently become 0.
    const records: TimeRecord[] = [
      { time: '2023-01-01T00:00', precipitation: 0 },
      { time: '2023-01-01T01:00', precipitation: 0 },
      { time: '2023-01-01T02:00', precipitation: 0.5 },
      { time: '2023-01-01T03:00', precipitation: 0 },
    ];

    expect(typeOf(deriveSpillSchema(records), 'precipitation')).toBe('DOUBLE');
  });

  it('covers every member column across an ensemble fan-out', () => {
    const memberCount = 31;
    const records: TimeRecord[] = Array.from({ length: 3 }, (_, row) => {
      const record: TimeRecord = { time: `2026-07-09T${String(row).padStart(2, '0')}:00` };
      for (let m = 1; m <= memberCount; m++) {
        record[`temperature_2m_member${String(m).padStart(2, '0')}`] = 20 + m / 10;
      }
      return record;
    });

    const schema = deriveSpillSchema(records);

    expect(schema).toHaveLength(memberCount + 1); // + time
    expect(typeOf(schema, 'temperature_2m_member01')).toBe('DOUBLE');
    expect(typeOf(schema, 'temperature_2m_member31')).toBe('DOUBLE');
  });
});

describe('exceedsInlineBudget', () => {
  /** Narrow daily row — roughly 50 chars serialized. */
  const narrowRow = (i: number): TimeRecord => ({
    time: `2023-01-${String((i % 28) + 1).padStart(2, '0')}`,
    temperature_2m_max: 10 + (i % 20),
  });

  /** Wide hourly row — 18 variables, the shape a multi-variable pull returns. */
  const wideRow = (i: number): TimeRecord => {
    const record: TimeRecord = { time: `2023-01-01T${String(i % 24).padStart(2, '0')}:00` };
    for (let v = 0; v < 18; v++) record[`weather_variable_number_${v}`] = 100.5 + v;
    return record;
  };

  it('keeps many narrow rows inline', () => {
    expect(exceedsInlineBudget(Array.from({ length: 500 }, (_, i) => narrowRow(i)))).toBe(false);
  });

  it('spills a wide payload well under any row count', () => {
    // #23: 480 rows — below the old 500-row gate — but hundreds of KB inline.
    expect(exceedsInlineBudget(Array.from({ length: 480 }, (_, i) => wideRow(i)))).toBe(true);
  });

  it('spills once narrow rows accumulate past the budget', () => {
    expect(exceedsInlineBudget(Array.from({ length: 5000 }, (_, i) => narrowRow(i)))).toBe(true);
  });

  it('treats an empty set as inline', () => {
    expect(exceedsInlineBudget([])).toBe(false);
  });

  it.each([
    ['wide, under the old row gate', Array.from({ length: 480 }, (_, i) => wideRow(i))],
    ['narrow, over the old row gate', Array.from({ length: 502 }, (_, i) => narrowRow(i))],
    ['narrow, at the old row gate', Array.from({ length: 500 }, (_, i) => narrowRow(i))],
    ['huge', Array.from({ length: 5000 }, (_, i) => narrowRow(i))],
  ])('agrees with spillover() on whether to stage a table: %s', async (_label, records) => {
    // The precheck exists so a result that would not spill never acquires a canvas.
    // That only holds if it measures exactly what spillover() measures — assert the
    // two agree against the real helper rather than trusting the arithmetic matches.
    const registerTable = vi.fn().mockResolvedValue({
      tableName: 'spilled_test',
      rowCount: records.length,
      columns: [],
    });
    const canvas = { registerTable, drop: vi.fn() } as unknown as CanvasInstance;

    const result = await spillover({
      canvas,
      source: records,
      schema: deriveSpillSchema(records),
      previewChars: PREVIEW_CHARS,
    });

    expect(result.spilled).toBe(exceedsInlineBudget(records));
    expect(registerTable).toHaveBeenCalledTimes(result.spilled ? 1 : 0);
  });
});
