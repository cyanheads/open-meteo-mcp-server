/**
 * @fileoverview Tests for the composed response notice and the temporal
 * coverage-gap analysis behind it. Fixtures mirror shapes verified against the live
 * endpoints: a CAMS archive range that opens before the product begins, and an
 * ncep_gefs025 window that runs past the model's horizon.
 * @module tests/tools/response-notice.test
 */

import { describe, expect, it, vi } from 'vitest';
import {
  byEnsembleVariable,
  type CoverageGap,
  composeNotice,
  describeCoverageGaps,
  findCoverageGaps,
} from '@/mcp-server/tools/response-notice.js';
import type { ColumnarBlock } from '@/services/open-meteo/types.js';

/** `count` consecutive hourly ISO timestamps from `from`. */
const hourlyTimes = (count: number, from = '2022-08-01T00:00'): string[] => {
  const start = new Date(`${from}:00Z`).getTime();
  return Array.from({ length: count }, (_, i) =>
    new Date(start + i * 3_600_000).toISOString().slice(0, 16),
  );
};

/** A sink that records every write, so last-write-wins is observable. */
const recordingSink = () => {
  const writes: string[] = [];
  return { writes, ctx: { enrich: { notice: (text: string) => writes.push(text) } } };
};

describe('composeNotice', () => {
  it('writes the whole composed string on every part, so nothing is dropped', () => {
    // ctx.enrich.notice is last-write-wins on a single key. Rewriting the full string
    // each time is what makes the final write carry every source.
    const { writes, ctx } = recordingSink();
    const notice = composeNotice(ctx);

    notice.add('pm2_5 returned no data.');
    notice.add('Partial hourly coverage for us_aqi.');
    notice.add('Staged 2592 rows.');

    expect(writes).toHaveLength(3);
    expect(writes.at(-1)).toBe(
      'pm2_5 returned no data. Partial hourly coverage for us_aqi. Staged 2592 rows.',
    );
  });

  it('ignores absent and blank parts so a source can call it unconditionally', () => {
    const { writes, ctx } = recordingSink();
    const notice = composeNotice(ctx);

    notice.add(undefined);
    notice.add('');
    expect(writes).toHaveLength(0);

    notice.add('Only this.');
    expect(writes).toEqual(['Only this.']);
  });

  it('never writes when no source has anything to say', () => {
    const notice = vi.fn();
    composeNotice({ enrich: { notice } }).add(undefined);
    expect(notice).not.toHaveBeenCalled();
  });

  it('composes to one line, since the trailer quotes only the first', () => {
    // The framework renders `notice` as `> <text>` — a newline would drop everything
    // after it out of the blockquote in content[].
    const { writes, ctx } = recordingSink();
    const notice = composeNotice(ctx);
    notice.add('First.');
    notice.add('Second.');
    expect(writes.at(-1)).not.toContain('\n');
  });
});

describe('findCoverageGaps', () => {
  it('reports a variable with no values anywhere in the window', () => {
    // Live at 47.6062,-122.3321 for 2022-01-01…02: us_aqi reports the real unit USAQI
    // and 48 nulls, because the CAMS global archive does not start until August 2022.
    const time = hourlyTimes(48, '2022-01-01T00:00');
    const block: ColumnarBlock = { time, us_aqi: time.map(() => null) };

    const [gap] = findCoverageGaps('hourly', block, { time: 'iso8601', us_aqi: 'USAQI' });

    expect(gap).toMatchObject({
      cadence: 'hourly',
      kind: 'all-null',
      nullRows: 48,
      totalRows: 48,
      variables: ['us_aqi'],
    });
    expect(gap?.first).toBeUndefined();
    expect(gap?.last).toBeUndefined();
  });

  it('reports where a partially covered variable actually starts and stops', () => {
    // Live for 2022-08-01…03: pm2_5 is null until 2022-08-03T17:00 and carries values
    // from there to the end of the range.
    const time = hourlyTimes(72);
    const block: ColumnarBlock = {
      time,
      pm2_5: time.map((_, row) => (row < 65 ? null : 4.1)),
    };

    const [gap] = findCoverageGaps('hourly', block, { time: 'iso8601', pm2_5: 'μg/m³' });

    expect(gap).toMatchObject({
      kind: 'partial',
      first: time[65],
      last: time[71],
      nullRows: 65,
      totalRows: 72,
      variables: ['pm2_5'],
    });
  });

  it('reports a trailing run the same way as a leading one', () => {
    // ncep_gefs025 over 16 days: daily carries 16 rows and the last 6 are null.
    const time = Array.from({ length: 16 }, (_, i) => `2026-09-${String(9 + i).padStart(2, '0')}`);
    const block: ColumnarBlock = {
      time,
      temperature_2m_max: time.map((_, row) => (row < 10 ? 20.5 : null)),
    };

    const [gap] = findCoverageGaps('daily', block, { time: 'iso8601', temperature_2m_max: '°C' });

    expect(gap).toMatchObject({ kind: 'partial', first: time[0], last: time[9], nullRows: 6 });
  });

  it('names variables that ran out together in one gap', () => {
    const time = hourlyTimes(24);
    const block: ColumnarBlock = {
      time,
      pm2_5: time.map((_, row) => (row < 10 ? 4.1 : null)),
      pm10: time.map((_, row) => (row < 10 ? 8.2 : null)),
      ozone: time.map((_, row) => (row < 10 ? 60 : null)),
    };

    const gaps = findCoverageGaps('hourly', block, {
      pm2_5: 'μg/m³',
      pm10: 'μg/m³',
      ozone: 'μg/m³',
    });

    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.variables).toEqual(['pm2_5', 'pm10', 'ozone']);
  });

  it('separates variables whose gaps differ', () => {
    const time = hourlyTimes(24);
    const block: ColumnarBlock = {
      time,
      pm2_5: time.map((_, row) => (row < 10 ? 4.1 : null)),
      us_aqi: time.map(() => null),
    };

    const gaps = findCoverageGaps('hourly', block, { pm2_5: 'μg/m³', us_aqi: 'USAQI' });

    expect(gaps.map((g) => g.kind)).toEqual(['partial', 'all-null']);
    expect(gaps.map((g) => g.variables)).toEqual([['pm2_5'], ['us_aqi']]);
  });

  it('collapses an ensemble member fan-out to the variable that was requested', () => {
    // A 31-member model would otherwise report the same gap 31 times.
    const time = Array.from({ length: 16 }, (_, i) => `2026-09-${String(9 + i).padStart(2, '0')}`);
    const block: ColumnarBlock = { time };
    const units: Record<string, string> = { time: 'iso8601' };
    for (let m = 1; m <= 31; m++) {
      const column = `temperature_2m_max_member${String(m).padStart(2, '0')}`;
      block[column] = time.map((_, row) => (row < 10 ? 20 + m / 10 : null));
      units[column] = '°C';
    }

    const gaps = findCoverageGaps('daily', block, units, byEnsembleVariable);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.variables).toEqual(['temperature_2m_max']);
    expect(gaps[0]?.nullRows).toBe(6);
  });

  it('treats a member group as covered for any row one member carries', () => {
    const time = hourlyTimes(4);
    const block: ColumnarBlock = {
      time,
      temperature_2m_member01: [1, null, null, null],
      temperature_2m_member02: [null, 2, 3, null],
    };

    const [gap] = findCoverageGaps('hourly', block, undefined, byEnsembleVariable);

    expect(gap).toMatchObject({ kind: 'partial', first: time[0], last: time[2], nullRows: 1 });
  });

  it('skips a column upstream marked with the unit "undefined"', () => {
    // That is an unserved name, already named by its own notice — reporting it here
    // would say the same thing twice in different words.
    const time = hourlyTimes(4);
    const block: ColumnarBlock = {
      time,
      pm2_5: [4.1, 4.2, 4.3, 4.4],
      temperature_2m_max: [null, null, null, null],
    };

    const gaps = findCoverageGaps('hourly', block, {
      pm2_5: 'μg/m³',
      temperature_2m_max: 'undefined',
    });

    expect(gaps).toEqual([]);
  });

  it('reports nothing when every column carries data in every row', () => {
    const time = hourlyTimes(4);
    expect(findCoverageGaps('hourly', { time, pm2_5: [1, 2, 3, 4] }, { pm2_5: 'μg/m³' })).toEqual(
      [],
    );
  });

  it('treats zero and the empty string as data rather than a gap', () => {
    // A dry window is `precipitation: [0, 0, …]` and `is_day` is served as 0/1, not
    // nulls. Testing falsiness instead of nullness would report every rainless
    // forecast and every night hour as a coverage gap.
    const time = hourlyTimes(3);
    const block: ColumnarBlock = {
      time,
      precipitation: [0, 0, 0],
      is_day: [0, 0, 0],
      weather_text: ['', '', ''],
    };

    expect(findCoverageGaps('hourly', block, undefined)).toEqual([]);
  });

  it('reports nothing for an absent or empty block', () => {
    expect(findCoverageGaps('daily', undefined, undefined)).toEqual([]);
    expect(findCoverageGaps('daily', { time: [] }, undefined)).toEqual([]);
  });

  it('ignores the time column itself', () => {
    // `time` is never null and is not a requested variable — it must not become a gap.
    const time = hourlyTimes(4);
    const gaps = findCoverageGaps('hourly', { time, pm2_5: [null, 1, 2, 3] }, undefined);
    expect(gaps.flatMap((g) => g.variables)).toEqual(['pm2_5']);
  });
});

describe('describeCoverageGaps', () => {
  const gap = (over: Partial<CoverageGap> = {}): CoverageGap => ({
    cadence: 'hourly',
    kind: 'all-null',
    nullRows: 48,
    totalRows: 48,
    variables: ['us_aqi'],
    ...over,
  });

  it('says the window is empty, and why that is not an unserved name', () => {
    const text = describeCoverageGaps([gap()]);

    expect(text).toContain('No hourly data for us_aqi');
    expect(text).toContain('all 48 values are null');
    expect(text).toContain('units are real');
  });

  it('gives the first and last timestamp with data for a partial run', () => {
    const text = describeCoverageGaps([
      gap({
        kind: 'partial',
        cadence: 'daily',
        variables: ['temperature_2m_max'],
        first: '2026-09-09',
        last: '2026-09-18',
        nullRows: 6,
        totalRows: 16,
      }),
    ]);

    expect(text).toContain('Partial daily coverage for temperature_2m_max');
    expect(text).toContain('data runs 2026-09-09 to 2026-09-18');
    expect(text).toContain('6 of 16 rows are null');
  });

  it('joins both cadences into one line', () => {
    const text = describeCoverageGaps(
      [gap({ cadence: 'hourly' })],
      [gap({ cadence: 'daily', variables: ['temperature_2m_max'] })],
    );

    expect(text).toContain('No hourly data for us_aqi');
    expect(text).toContain('No daily data for temperature_2m_max');
    expect(text).not.toContain('\n');
  });

  it('caps the names it lists and counts the rest', () => {
    const text = describeCoverageGaps([gap({ variables: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })]);

    expect(text).toContain('a, b, c, d, and 3 more');
    expect(text).not.toContain(', e,');
  });

  it('returns undefined when there is nothing to report', () => {
    expect(describeCoverageGaps([])).toBeUndefined();
    expect(describeCoverageGaps([], [])).toBeUndefined();
  });
});
