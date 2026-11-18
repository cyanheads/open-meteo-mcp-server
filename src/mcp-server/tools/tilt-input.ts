/**
 * @fileoverview Shared `tilt` and `azimuth` inputs for the three tools whose endpoints
 * serve `global_tilted_irradiance`: forecast, historical, and ensemble. Open-Meteo reads
 * the panel plane from two query parameters that appear only in that variable's own docs
 * entry, and fills an unset one silently — `tilt` with 0, a horizontal surface, and
 * `azimuth` with 0, south-facing — so a tilted column can carry a plane the caller did
 * not choose under a name that says otherwise. The fields, their bounds, and the notice
 * that names an upstream-filled plane live here so the three tools cannot drift apart.
 * @module mcp-server/tools/tilt-input
 */

import { z } from '@cyanheads/mcp-ts-core';

/**
 * The variables `tilt` and `azimuth` act on, each with the horizontal variable it matches
 * when `tilt` is unset. Upstream-verified on the forecast, archive, and ensemble
 * endpoints: no other variable moves with either parameter. The forecast endpoint rounds
 * a pair up to 0.1 W/m² apart on some rows, so the notice says "the same irradiance",
 * never "equal".
 */
const HORIZONTAL_TWIN = new Map([
  ['global_tilted_irradiance', 'shortwave_radiation'],
  ['global_tilted_irradiance_instant', 'shortwave_radiation_instant'],
]);

/**
 * Panel tilt from horizontal. Bounded here rather than upstream: Open-Meteo's 400 for an
 * out-of-range value arrives in the unknown-variable envelope and would be framed as a
 * bad variable name.
 */
export const tiltInput = z
  .number()
  .min(0)
  .max(90)
  .optional()
  .describe(
    'Panel tilt in degrees from horizontal (0–90: 0 flat, 90 vertical), for global_tilted_irradiance and global_tilted_irradiance_instant. Omitted, Open-Meteo computes them for a horizontal surface, the same irradiance as shortwave_radiation and shortwave_radiation_instant, and the notice says so. No other variable reads it.',
  );

/** Panel azimuth; bounded here for the reason {@link tiltInput} is. */
export const azimuthInput = z
  .number()
  .min(-180)
  .max(180)
  .optional()
  .describe(
    'Panel azimuth in degrees (-180–180): 0 south, -90 east, 90 west, ±180 north. Applies to global_tilted_irradiance and global_tilted_irradiance_instant once tilt is above 0. Omitted with tilt set, Open-Meteo faces the panel south (0) and the notice says so; a panel in the Southern Hemisphere usually faces north (180). No other variable reads it.',
  );

/** The plane a call asked for, as its parsed input carries it. */
export interface TiltPlane {
  readonly azimuth?: number | undefined;
  readonly tilt?: number | undefined;
}

/** `a` or `a and b` — at most the two tilted variables are ever named. */
const joinNames = (names: readonly string[]): string => names.join(' and ');

/**
 * The notice sentence for a tilted variable computed on a plane upstream chose, or
 * `undefined` when the call named no tilted variable or chose the plane itself.
 *
 *   - `tilt` unset: a horizontal surface, the same irradiance as the horizontal twin —
 *     whether or not `azimuth` was sent, since azimuth has no effect on a flat surface.
 *   - `tilt` above 0 with `azimuth` unset: a south-facing panel.
 *   - `tilt: 0` sent: the caller chose horizontal; nothing to say.
 *
 * The trigger is the requested names, not the response columns, so model and member
 * suffixes need no parsing. Pass every list the tool sends upstream that can carry a
 * tilted name (`hourly_variables`, and `current_variables` on the forecast tool).
 */
export function tiltNotice(
  plane: TiltPlane,
  ...variableLists: readonly (readonly string[] | undefined)[]
): string | undefined {
  const requested = new Set(variableLists.flatMap((list) => list ?? []));
  const tilted = [...HORIZONTAL_TWIN].filter(([name]) => requested.has(name));
  if (tilted.length === 0) return;

  const names = joinNames(tilted.map(([name]) => name));
  const verb = tilted.length === 1 ? 'was' : 'were';

  if (plane.tilt === undefined) {
    const remedy =
      plane.azimuth === undefined
        ? 'Set tilt (degrees from horizontal, 0–90) and azimuth (0 south, -90 east, 90 west, ±180 north) for the plane of a tilted panel.'
        : 'Set tilt (degrees from horizontal, 0–90) as well: azimuth has no effect on a horizontal surface.';
    return `${names} ${verb} computed for a horizontal surface because tilt was not set: the same irradiance as ${joinNames(tilted.map(([, twin]) => twin))}. ${remedy}`;
  }

  if (plane.tilt === 0 || plane.azimuth !== undefined) return;
  return `${names} ${verb} computed for a panel facing south (azimuth 0) because azimuth was not set. Set azimuth to face the panel another way: -90 east, 90 west, 180 north, the usual choice in the Southern Hemisphere.`;
}
