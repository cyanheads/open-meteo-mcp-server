/**
 * @fileoverview Tests for the shared `timezone` framing: which upstream rejections read
 * as a bad zone, and the message each one surfaces. Reason strings are verbatim from the
 * live forecast and archive endpoints.
 * @module tests/tools/timezone-input.test
 */

import { describe, expect, it } from 'vitest';
import {
  frameInvalidTimezoneMessage,
  isInvalidTimezoneReason,
} from '@/mcp-server/tools/timezone-input.js';
import { cpuMicrosPerCall } from '../helpers/cpu-time.js';

/** Upstream's reason for an unrecognized zone such as `timezone=Mars/Olympus` (HTTP 400). */
const UNKNOWN_ZONE = 'Invalid timezone';

/**
 * Upstream's reason for `timezone=Europe/Berlin,America/New_York` beside one coordinate
 * (HTTP 400): it reads the comma as a list separator, one zone per coordinate.
 */
const ZONE_LIST = "Parameter 'timezone' and coordinates must have the same number of elements";

describe('isInvalidTimezoneReason', () => {
  it.each([
    ['an unrecognized zone', UNKNOWN_ZONE],
    ['a comma-separated list of zones', ZONE_LIST],
  ])('recognizes the rejection of %s', (_shape, reason) => {
    expect(isInvalidTimezoneReason(reason)).toBe(true);
  });

  it('reads the wording at the head of the trimmed reason, in any case', () => {
    expect(isInvalidTimezoneReason(`  ${ZONE_LIST}\n`)).toBe(true);
    expect(isInvalidTimezoneReason(ZONE_LIST.toUpperCase())).toBe(true);
    expect(isInvalidTimezoneReason('invalid TIMEZONE')).toBe(true);
  });

  it.each([
    [
      'an unknown variable named timezone',
      'Invalid value: Cannot initialize SurfacePressureAndHeightVariable<VariableAndPreviousDay, VariableOrSpread<ForecastPressureVariable>, ForecastHeightVariable> from invalid String value timezone',
    ],
    [
      'a date rejection',
      "Parameter 'start_date' is out of allowed range from 1940-01-01 to 2026-11-27",
    ],
    ['the wording after other text', `Upstream said: ${ZONE_LIST}`],
  ])('leaves %s to the branches that own it', (_shape, reason) => {
    expect(isInvalidTimezoneReason(reason)).toBe(false);
  });

  it('is false for a missing or empty reason', () => {
    expect(isInvalidTimezoneReason(undefined)).toBe(false);
    expect(isInvalidTimezoneReason('')).toBe(false);
    expect(isInvalidTimezoneReason('   ')).toBe(false);
  });
});

describe('frameInvalidTimezoneMessage', () => {
  it('names the remedy for an unrecognized zone and quotes upstream', () => {
    expect(frameInvalidTimezoneMessage(UNKNOWN_ZONE)).toBe(
      'Open-Meteo rejected the requested timezone. Use "auto" or an exact IANA time-zone name (e.g. "America/Los_Angeles", "Europe/Berlin"). (Upstream: Invalid timezone)',
    );
  });

  it('says a comma made the zone a list, asks for one zone, and quotes upstream', () => {
    expect(frameInvalidTimezoneMessage(ZONE_LIST)).toBe(
      `Open-Meteo rejected the requested timezone: the comma made it a list of zones, one per coordinate, and this call has one coordinate. Use "auto" or one exact IANA time-zone name (e.g. "America/Los_Angeles", "Europe/Berlin"). (Upstream: ${ZONE_LIST})`,
    );
  });

  it('gives the remedy alone when upstream sent no reason', () => {
    expect(frameInvalidTimezoneMessage(undefined)).toBe(
      'Open-Meteo rejected the requested timezone. Use "auto" or an exact IANA time-zone name (e.g. "America/Los_Angeles", "Europe/Berlin").',
    );
  });
});

describe('timezone framing running time', () => {
  /** Generous CPU ceiling per character, in microseconds, held at every size. */
  const CPU_MICROS_PER_CHAR = 1;
  const BASE = 5_000;
  const LARGEST = 320_000;

  /** Reason shapes grown by doubling from 5k characters to 320k, the full 64× span. */
  const SHAPES: [string, (size: number) => string][] = [
    ['a repeated opener with no closer', (size) => "Parameter '".repeat(size / 10).padEnd(size)],
    ['nested openers', (size) => "Parameter 'timezone".repeat(size / 20)],
    ['overlapping prefixes', (size) => 'Invalid timezon'.repeat(size / 15).padEnd(size)],
    ['a whitespace run inside one line', (size) => `a${' '.repeat(size)}b`],
    ['a whitespace run before the wording', (size) => `${' '.repeat(size)}${ZONE_LIST}`],
    ['one long line ending in a break', (size) => `${'§1 x'.repeat(size / 4)}\ny`],
    ['breaks throughout', (size) => '  \r\n'.repeat(size / 4)],
    ['a long digit run', (size) => '1'.repeat(size)],
  ];

  it.each(SHAPES)(
    'stays linear on %s',
    (_shape, build) => {
      const timeAt = (size: number) => {
        const reason = build(size);
        return cpuMicrosPerCall(
          () => {
            isInvalidTimezoneReason(reason);
            frameInvalidTimezoneMessage(reason);
          },
          Math.max(4, Math.ceil(400_000 / size)),
        );
      };

      expect(timeAt(BASE)).toBeLessThan(BASE * CPU_MICROS_PER_CHAR);
      let ratio = 1;
      for (let size = BASE * 2; size <= LARGEST; size *= 2) {
        const base = timeAt(BASE);
        const atSize = timeAt(size);
        expect(atSize, `${size} characters`).toBeLessThan(size * CPU_MICROS_PER_CHAR);
        ratio = atSize / base;
      }

      // Linear growth over the 64× span is its own size; quadratic would be its square.
      expect(ratio).toBeLessThan(256);
    },
    0,
  );
});
