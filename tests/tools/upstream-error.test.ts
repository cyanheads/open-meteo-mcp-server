/**
 * @fileoverview Tests for the upstream unknown-variable error framing helper.
 * Fixture reason strings are verbatim from the live Open-Meteo endpoints.
 * @module tests/tools/upstream-error.test
 */

import { describe, expect, it } from 'vitest';
import {
  frameInvalidVariableMessage,
  frameRequestTooLargeMessage,
  isRequestTooLargeReason,
} from '@/mcp-server/tools/upstream-error.js';

/** Verbatim from the live forecast endpoint for hourly=temperature_2m,not_a_real_variable_xyz. */
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
