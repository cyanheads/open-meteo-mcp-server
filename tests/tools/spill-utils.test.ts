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
  boundedPreview,
  boundedPreviewByCadence,
  deriveSpillSchema,
  exceedsInlineBudget,
  noCanvasNotice,
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

describe('boundedPreview', () => {
  /** Narrow daily row — roughly 50 chars serialized. */
  const narrowRow = (i: number): TimeRecord => ({
    time: `2023-01-${String((i % 28) + 1).padStart(2, '0')}`,
    temperature_2m_max: 10 + (i % 20),
  });

  it('returns the whole set when it fits the budget', () => {
    const records = Array.from({ length: 500 }, (_, i) => narrowRow(i));
    expect(boundedPreview(records)).toEqual(records);
  });

  it('stops at the budget for an oversized set', () => {
    const records = Array.from({ length: 50_000 }, (_, i) => narrowRow(i));
    const preview = boundedPreview(records);

    expect(preview.length).toBeLessThan(records.length);
    expect(JSON.stringify(preview).length).toBeLessThanOrEqual(PREVIEW_CHARS * 1.1);
    // Chronological head, not a sample.
    expect(preview[0]).toEqual(records[0]);
  });

  it('agrees with exceedsInlineBudget on whether anything was dropped', () => {
    // The two measure the same rows against the same number, so a set that does not
    // exceed the budget must come back whole and one that does must come back short.
    for (const count of [1, 500, 1500, 5000]) {
      const records = Array.from({ length: count }, (_, i) => narrowRow(i));
      const preview = boundedPreview(records);
      expect(preview.length < records.length).toBe(exceedsInlineBudget(records));
    }
  });

  it('keeps one row even when that row alone blows the budget', () => {
    // A response with a single enormous row must still carry data, not an empty array.
    const fat: TimeRecord = { time: '2023-01-01', blob: 'x'.repeat(PREVIEW_CHARS * 2) };
    expect(boundedPreview([fat, narrowRow(0)])).toEqual([fat]);
  });

  it('returns an empty array for an empty set', () => {
    expect(boundedPreview([])).toEqual([]);
  });

  it('starts at the first row carrying data, skipping the leading all-null run', () => {
    // Upstream leads with nulls in three shapes — ensemble past_days placeholders, a
    // forecast past_days window longer than the API serves, and a GloFAS range that
    // starts before the coordinate's record. A chronological head would spend the
    // whole budget inside that run and carry no data at all.
    const nullRow = (i: number): TimeRecord => ({
      time: `2023-01-${String((i % 28) + 1).padStart(2, '0')}`,
      temperature_2m_max: null,
    });
    const records = [
      ...Array.from({ length: 3000 }, (_, i) => nullRow(i)),
      ...Array.from({ length: 3000 }, (_, i) => narrowRow(i)),
    ];
    const preview = boundedPreview(records);

    expect(preview[0]).toEqual(records[3000]);
    expect(preview.every((r) => r.temperature_2m_max !== null)).toBe(true);
  });

  it('returns the head when every row is all-null', () => {
    // No row carries data, so there is nothing better to show — an empty array would
    // just hide the shape of what came back.
    const records = Array.from({ length: 5000 }, (_, i) => ({
      time: `2023-01-${String((i % 28) + 1).padStart(2, '0')}`,
      temperature_2m_max: null,
    })) satisfies TimeRecord[];
    const preview = boundedPreview(records);

    expect(preview[0]).toEqual(records[0]);
    expect(preview.length).toBeGreaterThan(0);
    expect(preview.length).toBeLessThan(records.length);
  });
});

describe('boundedPreviewByCadence', () => {
  /** Wide hourly row — 9 marine variables, the shape the #32 repro requests. */
  const hourlyRow = (i: number): TimeRecord => {
    const record: TimeRecord = { time: `2026-04-30T${String(i % 24).padStart(2, '0')}:00` };
    for (const name of [
      'wave_height',
      'wave_direction',
      'wave_period',
      'wind_wave_height',
      'wind_wave_direction',
      'wind_wave_period',
      'swell_wave_height',
      'swell_wave_direction',
      'swell_wave_period',
    ]) {
      record[name] = 1 + (i % 30) / 10;
    }
    return record;
  };

  /** Narrow daily row — the cheap cadence. */
  const dailyRow = (i: number): TimeRecord => ({
    time: `2026-04-${String((i % 28) + 1).padStart(2, '0')}`,
    wave_height_max: 2 + (i % 15) / 10,
    wave_direction_dominant: 90 + (i % 40),
    wave_period_max: 9 + (i % 6),
  });

  const size = (rows: readonly TimeRecord[]) =>
    rows.reduce((chars, row) => chars + JSON.stringify(row).length, 0);

  it('carries daily rows when a wide hourly window would have taken the whole budget (#32)', () => {
    // The live repro: 2,400 hourly rows against 100 daily. One preview over the
    // concatenated array spends the budget before the first daily row.
    const hourly = Array.from({ length: 2400 }, (_, i) => hourlyRow(i));
    const daily = Array.from({ length: 100 }, (_, i) => dailyRow(i));

    const preview = boundedPreviewByCadence(hourly, daily);

    expect(preview.daily).toHaveLength(100);
    expect(preview.hourly.length).toBeGreaterThan(0);
    expect(preview.hourly.length).toBeLessThan(hourly.length);
    // The concatenated approach this replaces, for contrast: rows, all of them hourly.
    const concatenated = boundedPreview([...hourly, ...daily]);
    expect(concatenated.length).toBeGreaterThan(0);
    expect(concatenated.some((r) => !String(r.time).includes('T'))).toBe(false);
  });

  it('keeps the two previews inside one PREVIEW_CHARS budget', () => {
    const hourly = Array.from({ length: 5000 }, (_, i) => hourlyRow(i));
    const daily = Array.from({ length: 4000 }, (_, i) => dailyRow(i));

    const preview = boundedPreviewByCadence(hourly, daily);

    // One-row overshoot per cadence, exactly as a single boundedPreview allows.
    expect(size(preview.hourly) + size(preview.daily)).toBeLessThanOrEqual(PREVIEW_CHARS * 1.1);
    // Neither cadence is starved: each clears its guaranteed half.
    expect(size(preview.hourly)).toBeGreaterThan(PREVIEW_CHARS / 2 - 1000);
    expect(size(preview.daily)).toBeGreaterThan(PREVIEW_CHARS / 2 - 1000);
  });

  it('gives a single-cadence response the whole budget, not half of it', () => {
    // A daily-only or hourly-only request must not lose rows to a reservation the
    // other cadence never claims.
    const daily = Array.from({ length: 4000 }, (_, i) => dailyRow(i));
    const hourly = Array.from({ length: 4000 }, (_, i) => hourlyRow(i));

    // Both sides truncate, so the equality is against a real row set rather than two
    // empty arrays, and each side clears the half a fixed reservation would have left.
    const dailyOnly = boundedPreviewByCadence([], daily).daily;
    const hourlyOnly = boundedPreviewByCadence(hourly, []).hourly;

    expect(dailyOnly).toEqual(boundedPreview(daily));
    expect(hourlyOnly).toEqual(boundedPreview(hourly));
    expect(dailyOnly.length).toBeGreaterThan(0);
    expect(hourlyOnly.length).toBeGreaterThan(0);
    expect(size(dailyOnly)).toBeGreaterThan(PREVIEW_CHARS / 2);
    expect(size(hourlyOnly)).toBeGreaterThan(PREVIEW_CHARS / 2);
  });

  it('skips a leading all-null run in each cadence independently', () => {
    const nullHourly = (i: number): TimeRecord => ({
      time: `2026-04-30T${String(i % 24).padStart(2, '0')}:00`,
      wave_height: null,
    });
    const nullDaily = (i: number): TimeRecord => ({
      time: `2026-04-${String((i % 28) + 1).padStart(2, '0')}`,
      wave_height_max: null,
    });
    const hourly = [
      ...Array.from({ length: 500 }, (_, i) => nullHourly(i)),
      ...Array.from({ length: 500 }, (_, i) => hourlyRow(i)),
    ];
    const daily = [
      ...Array.from({ length: 40 }, (_, i) => nullDaily(i)),
      ...Array.from({ length: 40 }, (_, i) => dailyRow(i)),
    ];

    const preview = boundedPreviewByCadence(hourly, daily);

    expect(preview.hourly[0]).toEqual(hourly[500]);
    expect(preview.daily[0]).toEqual(daily[40]);
  });

  it('keeps daily whole when one hourly row alone blows the whole budget', () => {
    // Hourly overshoots past PREVIEW_CHARS on its single row, so the complement is
    // negative — daily falls back to the half it claimed on the first pass rather than
    // to the one row an unfloored budget would leave.
    const fat: TimeRecord = { time: '2026-04-30T00:00', blob: 'x'.repeat(PREVIEW_CHARS * 2) };
    const daily = Array.from({ length: 10 }, (_, i) => dailyRow(i));

    const preview = boundedPreviewByCadence([fat], daily);

    expect(preview.hourly).toEqual([fat]);
    expect(preview.daily).toEqual(daily);
  });

  it('returns two empty arrays when neither cadence has records', () => {
    expect(boundedPreviewByCadence([], [])).toEqual({ hourly: [], daily: [] });
  });
});

describe('noCanvasNotice', () => {
  it('names the disabled setting, the enabling setting, and the tool-specific levers', () => {
    const text = noCanvasNotice('a shorter start_date–end_date range, or fewer daily_variables');

    // Why there is no canvas_id …
    expect(text).toContain('CANVAS_PROVIDER_TYPE=none');
    // … and both ways to reach the omitted rows.
    expect(text).toContain('CANVAS_PROVIDER_TYPE=duckdb');
    expect(text).toContain('a shorter start_date–end_date range, or fewer daily_variables');
    // … and how the preview was picked, since it is not the chronological head.
    expect(text).toContain('first row carrying data');
  });
});
