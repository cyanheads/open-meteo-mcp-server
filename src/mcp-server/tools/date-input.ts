/**
 * @fileoverview Shared `start_date` / `end_date` schema for the five date-range tools.
 * A bare `YYYY-MM-DD` shape check lets impossible dates through, and Open-Meteo rolls an
 * overflowing day into the next month (`2024-02-30` answers for `2024-03-01`) rather than
 * rejecting it. `z.iso.date()` checks month lengths and leap years at argument validation
 * and advertises `format: "date"` plus a calendar-aware `pattern` in `tools/list`. Each
 * tool adds its own `.describe()` — coverage bounds and pairing rules differ per endpoint.
 * @module mcp-server/tools/date-input
 */

import { z } from '@cyanheads/mcp-ts-core';

/** The rejection a caller sees for a malformed or impossible date. */
const REAL_DATE_MESSAGE =
  'Must be a real calendar date in YYYY-MM-DD form: month 01–12 and a day that exists in ' +
  'that month (2024-02-29 is valid; 2023-02-29 and 2024-04-31 are not).';

/** A real calendar date, `YYYY-MM-DD`. */
export const CalendarDateSchema = z.iso.date({ error: REAL_DATE_MESSAGE });
