/**
 * @fileoverview The shared `tilt` / `azimuth` inputs and the notice for a plane Open-Meteo
 * filled in. The bounds and every branch of {@link tiltNotice} are tabled here once; the
 * forecast, historical, and ensemble tool tests prove only their wiring.
 * @module tests/tools/tilt-input.test
 */

import { describe, expect, it } from 'vitest';
import { azimuthInput, tiltInput, tiltNotice } from '@/mcp-server/tools/tilt-input.js';

const GTI = 'global_tilted_irradiance';
const GTI_INSTANT = 'global_tilted_irradiance_instant';

const SET_BOTH =
  'Set tilt (degrees from horizontal, 0–90) and azimuth (0 south, -90 east, 90 west, ±180 north) for the plane of a tilted panel.';

const HORIZONTAL = `global_tilted_irradiance was computed for a horizontal surface because tilt was not set: the same irradiance as shortwave_radiation. ${SET_BOTH}`;

const SOUTH_FACING =
  'global_tilted_irradiance was computed for a panel facing south (azimuth 0) because azimuth was not set. Set azimuth to face the panel another way: -90 east, 90 west, 180 north, the usual choice in the Southern Hemisphere.';

describe('tilt and azimuth bounds (#101)', () => {
  it.each([0, 90, 33.5, undefined])('accepts tilt %s', (value) => {
    expect(tiltInput.safeParse(value).success).toBe(true);
  });

  it.each([-1, 91, -0.5, 90.01, Number.NaN, Number.POSITIVE_INFINITY, '33', null])(
    'rejects tilt %s',
    (value) => {
      expect(tiltInput.safeParse(value).success).toBe(false);
    },
  );

  it.each([-180, 180, 0, -90.5, undefined])('accepts azimuth %s', (value) => {
    expect(azimuthInput.safeParse(value).success).toBe(true);
  });

  it.each([-181, 181, 180.5, Number.NaN, Number.NEGATIVE_INFINITY, '0', null])(
    'rejects azimuth %s',
    (value) => {
      expect(azimuthInput.safeParse(value).success).toBe(false);
    },
  );
});

describe('tiltNotice (#101)', () => {
  it.each([
    ['no variable lists', {}, []],
    ['only undefined lists', {}, [undefined, undefined]],
    ['the horizontal twin itself', {}, [['shortwave_radiation', 'direct_radiation']]],
    [
      'tilt and azimuth beside untilted variables',
      { tilt: 33, azimuth: -90 },
      [['temperature_2m']],
    ],
    ['tilt alone beside untilted variables', { tilt: 33 }, [['shortwave_radiation_instant']]],
  ] as const)('says nothing when no tilted variable was requested: %s', (_label, plane, lists) => {
    expect(tiltNotice(plane, ...lists)).toBeUndefined();
  });

  it.each([
    ['tilt and azimuth both set', { tilt: 33, azimuth: 0 }],
    ['a north-facing plane', { tilt: 34, azimuth: 180 }],
    ['tilt: 0 sent explicitly', { tilt: 0 }],
    ['tilt: 0 with an azimuth', { tilt: 0, azimuth: 90 }],
  ] as const)('says nothing when the caller chose the plane: %s', (_label, plane) => {
    expect(tiltNotice(plane, [GTI, GTI_INSTANT])).toBeUndefined();
  });

  it('names a horizontal surface and shortwave_radiation when tilt is unset', () => {
    expect(tiltNotice({}, ['temperature_2m', GTI])).toBe(HORIZONTAL);
  });

  it('names the instant twin for the instant variable', () => {
    expect(tiltNotice({}, [GTI_INSTANT])).toBe(
      `global_tilted_irradiance_instant was computed for a horizontal surface because tilt was not set: the same irradiance as shortwave_radiation_instant. ${SET_BOTH}`,
    );
  });

  it('names both variables and both twins, in either list order and across lists', () => {
    const expected = `global_tilted_irradiance and global_tilted_irradiance_instant were computed for a horizontal surface because tilt was not set: the same irradiance as shortwave_radiation and shortwave_radiation_instant. ${SET_BOTH}`;
    expect(tiltNotice({}, [GTI_INSTANT, GTI])).toBe(expected);
    expect(tiltNotice({}, [GTI_INSTANT], undefined, [GTI])).toBe(expected);
  });

  it('names a variable requested in two lists once', () => {
    expect(tiltNotice({}, [GTI], [GTI])).toBe(HORIZONTAL);
  });

  it('keeps the horizontal sentence when only azimuth was sent, and asks for tilt alone', () => {
    // Upstream leaves tilt at 0 when only azimuth is sent: every row equals shortwave_radiation.
    expect(tiltNotice({ azimuth: 180 }, [GTI])).toBe(
      'global_tilted_irradiance was computed for a horizontal surface because tilt was not set: the same irradiance as shortwave_radiation. Set tilt (degrees from horizontal, 0–90) as well: azimuth has no effect on a horizontal surface.',
    );
  });

  it.each([33, 0.5, 90])(
    'names the south-facing default when tilt is %s and azimuth unset',
    (tilt) => {
      expect(tiltNotice({ tilt }, [GTI])).toBe(SOUTH_FACING);
    },
  );

  it('pluralizes the south-facing sentence for both variables', () => {
    expect(tiltNotice({ tilt: 34 }, [GTI, GTI_INSTANT])).toBe(
      'global_tilted_irradiance and global_tilted_irradiance_instant were computed for a panel facing south (azimuth 0) because azimuth was not set. Set azimuth to face the panel another way: -90 east, 90 west, 180 north, the usual choice in the Southern Hemisphere.',
    );
  });
});
