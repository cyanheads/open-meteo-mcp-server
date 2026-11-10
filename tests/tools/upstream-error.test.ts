/**
 * @fileoverview Tests for the upstream error framing helpers and the reason predicates
 * that route an Open-Meteo rejection to its contract reason. Fixture reason strings are
 * verbatim from the Open-Meteo endpoints.
 * @module tests/tools/upstream-error.test
 */

import { describe, expect, it } from 'vitest';
import {
  frameInvalidVariableMessage,
  frameRequestTooLargeMessage,
  isDateOutOfRangeReason,
  isRequestTooLargeReason,
} from '@/mcp-server/tools/upstream-error.js';
import { cpuMicrosPerCall } from '../helpers/cpu-time.js';

/**
 * The forecast endpoint's unknown-name rejection for
 * hourly=temperature_2m,not_a_real_variable_xyz, in the wording upstream used before it
 * opened these messages with `Invalid value:` instead of `Data corrupted at path ''.`.
 */
const SWIFT_REASON =
  "Data corrupted at path ''. Cannot initialize SurfacePressureAndHeightVariable<VariableAndPreviousDay, VariableOrSpread<ForecastPressureVariable>, ForecastHeightVariable> from invalid String value not_a_real_variable_xyz.";

/** Verbatim from the live climate and archive endpoints for an over-wide request. */
const TOO_MUCH_DATA_REASON =
  'Your API call requests too much data. Please reduce the number of variables, locations and/or weather models.';

describe('frameInvalidVariableMessage', () => {
  it('names the offending variable and leads with guidance', () => {
    const msg = frameInvalidVariableMessage(SWIFT_REASON);
    expect(msg).toMatch(/^Unknown variable name: not_a_real_variable_xyz\./);
    expect(msg).toContain('Remove or correct it and retry');
  });

  it('demotes the raw upstream string to a trailing parenthetical', () => {
    const msg = frameInvalidVariableMessage(SWIFT_REASON);
    expect(msg.endsWith(`(Upstream: ${SWIFT_REASON})`)).toBe(true);
    // The jargon must not lead the message
    expect(msg.startsWith('Data corrupted')).toBe(false);
  });

  it('does not claim valid names are unknown when upstream echoes the whole comma list', () => {
    // With a percent-encoded comma (as URLSearchParams sends), the upstream echoes
    // the full requested list — valid names included — as the invalid value.
    const msg = frameInvalidVariableMessage(
      "Data corrupted at path ''. Cannot initialize X from invalid String value temperature_2m,bogus_one.",
    );
    expect(msg).toMatch(
      /^At least one of the requested variable names is not a valid Open-Meteo API name: temperature_2m, bogus_one\./,
    );
    expect(msg).toContain('Correct or remove the invalid name(s) and retry');
  });

  it('uses the caller-supplied label (ensemble variable-or-model case)', () => {
    // Verbatim from the live ensemble endpoint for models=not_a_model
    const msg = frameInvalidVariableMessage(
      "Data corrupted at path ''. Cannot initialize MultiDomains from invalid String value not_a_model.",
      'variable or model',
    );
    expect(msg).toMatch(/^Unknown variable or model name: not_a_model\./);
  });

  it('falls back to generic guidance when the reason has an unrecognized shape', () => {
    const msg = frameInvalidVariableMessage('Something unexpected happened');
    expect(msg).toMatch(/^The API rejected a requested variable name\./);
    expect(msg).toContain('(Upstream: Something unexpected happened)');
  });

  it('handles a missing upstream reason', () => {
    const msg = frameInvalidVariableMessage(undefined);
    expect(msg).toMatch(/^The API rejected a requested variable name\./);
    expect(msg).not.toContain('Upstream');
  });
});

describe('isRequestTooLargeReason', () => {
  it('recognizes the upstream volume rejection', () => {
    expect(isRequestTooLargeReason(TOO_MUCH_DATA_REASON)).toBe(true);
    expect(isRequestTooLargeReason(`  ${TOO_MUCH_DATA_REASON}`)).toBe(true);
    expect(isRequestTooLargeReason('YOUR API CALL REQUESTS TOO MUCH DATA.')).toBe(true);
  });

  it('leaves every other rejection shape to the branches that own them', () => {
    // Anchored at the head so it cannot claim an unrelated envelope, and an
    // unknown-name rejection keeps its own classification.
    expect(isRequestTooLargeReason(SWIFT_REASON)).toBe(false);
    expect(isRequestTooLargeReason('Invalid timezone')).toBe(false);
    expect(isRequestTooLargeReason('No data is available for this location')).toBe(false);
    expect(isRequestTooLargeReason('The dataset says your API call requests too much data.')).toBe(
      false,
    );
    expect(isRequestTooLargeReason(undefined)).toBe(false);
    expect(isRequestTooLargeReason('')).toBe(false);
  });
});

/**
 * Upstream's date rejections, verbatim per endpoint (HTTP 400). The range in each
 * message is the one the endpoint stated on the day it was captured.
 */
const DATE_REASONS = [
  [
    'archive start_date',
    "Parameter 'start_date' is out of allowed range from 1940-01-01 to 2026-11-10",
  ],
  [
    'archive end_date',
    "Parameter 'end_date' is out of allowed range from 1940-01-01 to 2026-11-10",
  ],
  ['archive and climate malformed date', 'Invalid date'],
  [
    'climate start_date',
    "Parameter 'start_date' is out of allowed range from 1950-01-01 to 2050-12-31",
  ],
  [
    'flood start_date',
    "Parameter 'start_date' is out of allowed range from 1984-01-01 to 2027-11-10",
  ],
  ['flood end_date', "Parameter 'end_date' is out of allowed range from 1984-01-01 to 2027-11-10"],
  [
    'marine start_date',
    "Parameter 'start_date' is out of allowed range from 1940-01-01 to 2026-11-25",
  ],
  [
    'air quality end_date',
    "Parameter 'end_date' is out of allowed range from 2013-01-01 to 2026-11-16",
  ],
] as const;

/** Every other rejection shape, each of which a broader date test would have claimed or could claim. */
const NON_DATE_REASONS = [
  // Unknown names quoting an offender that contains "range" or "date" (verbatim).
  [
    'unknown daily variable ending _range',
    'Invalid value: Cannot initialize ForecastVariableDaily from invalid String value temperature_2m_range',
  ],
  [
    'unknown hourly variable ending _range',
    'Invalid value: Cannot initialize SurfacePressureAndHeightVariable<VariableAndPreviousDay, VariableOrSpread<ForecastPressureVariable>, ForecastHeightVariable> from invalid String value temperature_2m_range',
  ],
  [
    'unknown discharge variable ending _range',
    'Invalid value: Cannot initialize ForecastVariableDaily from invalid String value river_discharge_range',
  ],
  [
    'unknown archive model ending _update',
    'Invalid value: Cannot initialize MultiDomains from invalid String value era5_update',
  ],
  [
    'unknown climate model ending _update',
    'Invalid value: Cannot initialize MultiDomains from invalid String value mri_update',
  ],
  [
    'unknown flood model ending _update',
    'Invalid value: Cannot initialize MultiDomains from invalid String value seamless_update',
  ],
  [
    'unknown name with neither substring',
    'Invalid value: Cannot initialize ForecastVariableDaily from invalid String value temperature_2m_maxx',
  ],
  ['the older unknown-name wording', SWIFT_REASON],
  // One-word edge cases and phrases that only mention dates.
  ['the bare word date', 'date'],
  ['the bare word range', 'range'],
  ['the bare word Date', 'Date'],
  ['the range phrase without its parameter', 'out of allowed range'],
  ['a date wording that does not lead', "Rejected: Parameter 'start_date' is out of allowed range"],
  ['a reversed range (checked locally first)', 'End-date must be larger or equals than start-date'],
  ['the bare flood rejection (checked locally first)', 'Bad Request'],
  ['an unquoted parameter name', 'Parameter start_date is out of allowed range'],
  ['a longer word after "Invalid date"', 'Invalid dates requested'],
  // The other classified upstream reasons.
  ['the volume rejection', TOO_MUCH_DATA_REASON],
  ['the timezone rejection', 'Invalid timezone'],
  ['the coverage-gap envelope', 'No data is available for this location'],
  ['concurrency 429', 'Too many concurrent requests'],
  // Messages the service writes itself, which a tool never classifies — including one
  // wrapping upstream's date wording inside a 5xx outage.
  [
    'service: 5xx envelope',
    "Open-Meteo API error: Parameter 'start_date' is out of allowed range from 1940-01-01 to 2026-11-10",
  ],
  ['service: 4xx without an envelope', 'Open-Meteo API returned 400.'],
  ['service: exhausted retries', 'Open-Meteo API unavailable after 3 attempts.'],
  ['service: timeout', 'Open-Meteo request timed out after 15s.'],
  ['service: unparseable body', 'Open-Meteo API returned unparseable response.'],
  [
    'service: rate limit',
    'Open-Meteo rate limit reached: Daily API request limit exceeded. Please try again tomorrow. Retrying immediately returns the same response.',
  ],
] as const;

describe('isDateOutOfRangeReason', () => {
  it.each(DATE_REASONS)('recognizes the %s rejection', (_shape, reason) => {
    expect(isDateOutOfRangeReason(reason)).toBe(true);
  });

  it('reads the wording at the head of the trimmed reason, in any case', () => {
    expect(isDateOutOfRangeReason(`  ${DATE_REASONS[0][1]}\n`)).toBe(true);
    expect(isDateOutOfRangeReason("PARAMETER 'END_DATE' IS OUT OF ALLOWED RANGE FROM X TO Y")).toBe(
      true,
    );
    expect(isDateOutOfRangeReason('invalid date')).toBe(true);
  });

  it.each(NON_DATE_REASONS)('leaves %s to the branches that own it', (_shape, reason) => {
    expect(isDateOutOfRangeReason(reason)).toBe(false);
  });

  it('is false for a missing or empty reason', () => {
    expect(isDateOutOfRangeReason(undefined)).toBe(false);
    expect(isDateOutOfRangeReason('')).toBe(false);
    expect(isDateOutOfRangeReason('   ')).toBe(false);
  });
});

describe('isDateOutOfRangeReason running time', () => {
  /** Per-character CPU ceiling, in microseconds, the predicate is held to at every size. */
  const CPU_MICROS_PER_CHAR = 0.1;
  const BASE = 5_000;

  /**
   * Shapes grown by doubling from 5k characters: the digit run to 320k, the full 64×
   * span, and every other shape to 80k.
   */
  const SHAPES: [string, (size: number) => string, number][] = [
    ['a repeated opener with no closer', (size) => "Parameter '".repeat(size / 10), 80_000],
    ['nested openers', (size) => "Parameter 'start_date".repeat(size / 20), 80_000],
    ['overlapping prefixes', (size) => 'Invalid dat'.repeat(size / 10), 80_000],
    ['a whitespace run inside one line', (size) => `a${' '.repeat(size)}b`, 80_000],
    ['a whitespace run before the wording', (size) => `${' '.repeat(size)}Invalid date`, 80_000],
    ['one long line ending in a break', (size) => `${'§1 x'.repeat(size / 4)}\ny`, 80_000],
    ['breaks throughout', (size) => '  \r\n'.repeat(size / 4), 80_000],
    ['a long digit run', (size) => '1'.repeat(size), 320_000],
  ];

  it.each(SHAPES)('stays linear on %s', (_shape, build, largest) => {
    const timeAt = (size: number) => {
      const input = build(size);
      return cpuMicrosPerCall(
        () => isDateOutOfRangeReason(input),
        Math.max(4, Math.ceil(2_000_000 / size)),
      );
    };

    const base = timeAt(BASE);
    expect(base).toBeLessThan(BASE * CPU_MICROS_PER_CHAR);
    let atLargest = base;
    for (let size = BASE * 2; size <= largest; size *= 2) {
      atLargest = timeAt(size);
      expect(atLargest, `${size} characters`).toBeLessThan(size * CPU_MICROS_PER_CHAR);
    }

    // Linear growth over the span is its own size; quadratic would be its square.
    const span = largest / BASE;
    expect(atLargest / base).toBeLessThan(4 * span);
  });
});

describe('frameRequestTooLargeMessage', () => {
  it('names the volume levers and never the spelling of a name', () => {
    const msg = frameRequestTooLargeMessage(
      TOO_MUCH_DATA_REASON,
      'fewer daily_variables, fewer models, or a shorter start_date–end_date range',
    );

    expect(msg).toMatch(/^Open-Meteo rejected this request as asking for too much data at once\./);
    expect(msg).toContain('fewer daily_variables, fewer models, or a shorter start_date–end_date');
    expect(msg).toContain('Every requested name is valid');
    expect(msg).not.toMatch(/spelling|exact Open-Meteo API name/i);
  });

  it('demotes the raw upstream string to a trailing parenthetical', () => {
    const msg = frameRequestTooLargeMessage(TOO_MUCH_DATA_REASON, 'fewer hourly_variables');
    expect(msg.endsWith(`(Upstream: ${TOO_MUCH_DATA_REASON})`)).toBe(true);
  });

  it('omits the parenthetical when upstream sent no reason', () => {
    const msg = frameRequestTooLargeMessage(undefined, 'fewer hourly_variables');
    expect(msg).toContain('fewer hourly_variables');
    expect(msg).not.toContain('Upstream');
  });
});
