/**
 * @fileoverview Per-tool wiring of the notice mechanisms `response-notice.ts` owns. Each
 * of the seven weather tools renders its `notice` into `content[]` through
 * `renderNotice`, so a CommonMark parse reads back exactly `structuredContent.notice`;
 * historical, forecast, and climate hand the caller's model selection to the coverage
 * analysis, so a model that returned nothing for a variable another selected model
 * served is named instead of the location or window; and a horizon or archive-start gap
 * under six null rows reaches the notice through each tool it was measured on. The full
 * value tables live in `response-notice.test.ts`; this file proves one case per side of
 * each branch, per tool.
 * @module tests/tools/notice-wiring.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openmeteoGetAirQualityTool } from '@/mcp-server/tools/definitions/get-air-quality.tool.js';
import { openmeteoGetClimateTool } from '@/mcp-server/tools/definitions/get-climate.tool.js';
import { openmeteoGetEnsembleTool } from '@/mcp-server/tools/definitions/get-ensemble.tool.js';
import { openmeteoGetFloodTool } from '@/mcp-server/tools/definitions/get-flood.tool.js';
import { openmeteoGetForecastTool } from '@/mcp-server/tools/definitions/get-forecast.tool.js';
import { openmeteoGetHistoricalTool } from '@/mcp-server/tools/definitions/get-historical.tool.js';
import { openmeteoGetMarineTool } from '@/mcp-server/tools/definitions/get-marine.tool.js';
import { renderedText } from '../helpers/commonmark.js';

const service = vi.hoisted(() => ({
  getAirQuality: vi.fn(),
  getClimate: vi.fn(),
  getEnsemble: vi.fn(),
  getFlood: vi.fn(),
  getForecast: vi.fn(),
  getHistorical: vi.fn(),
  getMarine: vi.fn(),
}));

vi.mock('@/services/open-meteo/open-meteo-service.js', () => ({
  getOpenMeteoService: () => service,
}));

// No canvas: every fixture here is small enough to return inline.
vi.mock('@/services/canvas-accessor.js', () => ({ getCanvas: () => undefined }));

type CallToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** `count` consecutive ISO dates from `from`. */
const dates = (count: number, from: string): string[] => {
  const start = new Date(`${from}T00:00:00Z`).getTime();
  return Array.from({ length: count }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );
};

/** `count` consecutive hourly ISO timestamps from `from`. */
const hours = (count: number, from: string): string[] => {
  const start = new Date(`${from}:00Z`).getTime();
  return Array.from({ length: count }, (_, i) =>
    new Date(start + i * 3_600_000).toISOString().slice(0, 16),
  );
};

const ENVELOPE = {
  latitude: 47.6,
  longitude: -122.33,
  elevation: 50,
  generationtime_ms: 1,
  utc_offset_seconds: 0,
  timezone: 'GMT',
  timezone_abbreviation: 'GMT',
};

const POINT = { latitude: 47.6, longitude: -122.33 };

/** The `structuredContent.notice` a result carries, failing the test when it has none. */
const noticeOf = (result: CallToolResult): string => {
  expect(result.isError).toBeFalsy();
  const notice = (result.structuredContent as { notice?: unknown }).notice;
  expect(typeof notice).toBe('string');
  return notice as string;
};

/** The `content[]` trailer block — the last text block, where the framework appends enrichment. */
const trailerOf = (result: CallToolResult): string => {
  const block = result.content.at(-1);
  return block?.type === 'text' ? block.text : '';
};

// --- notice rendering --------------------------------------------------------

/**
 * One call per tool whose response carries a column upstream reported with the unit
 * "undefined" under a Markdown-active name. `_x_` is emphasis to a CommonMark parse when
 * it sits between spaces, so a notice echoing it unescaped reads back as `x`.
 */
const EMPHASIS_NAME = '_x_';

const daily2 = dates(2, '2026-11-09');
const hourly2 = hours(2, '2026-11-09T00:00');

const RENDER_CASES = [
  {
    name: 'openmeteo_get_forecast',
    run: () => {
      service.getForecast.mockResolvedValue({
        ...ENVELOPE,
        daily_units: { time: 'iso8601', temperature_2m_max: '°C', [EMPHASIS_NAME]: 'undefined' },
        daily: { time: daily2, temperature_2m_max: [10, 11], [EMPHASIS_NAME]: [null, null] },
      });
      return runToolContract(openmeteoGetForecastTool, {
        ...POINT,
        daily_variables: ['temperature_2m_max'],
        forecast_days: 2,
      });
    },
  },
  {
    name: 'openmeteo_get_historical',
    run: () => {
      service.getHistorical.mockResolvedValue({
        ...ENVELOPE,
        daily_units: { time: 'iso8601', temperature_2m_max: '°C', [EMPHASIS_NAME]: 'undefined' },
        daily: { time: daily2, temperature_2m_max: [10, 11], [EMPHASIS_NAME]: [null, null] },
      });
      return runToolContract(openmeteoGetHistoricalTool, {
        ...POINT,
        start_date: daily2[0] as string,
        end_date: daily2[1] as string,
        daily_variables: ['temperature_2m_max'],
      });
    },
  },
  {
    name: 'openmeteo_get_marine',
    run: () => {
      service.getMarine.mockResolvedValue({
        ...ENVELOPE,
        daily_units: { time: 'iso8601', wave_height_max: 'm', [EMPHASIS_NAME]: 'undefined' },
        daily: { time: daily2, wave_height_max: [1.2, 1.4], [EMPHASIS_NAME]: [null, null] },
      });
      return runToolContract(openmeteoGetMarineTool, {
        ...POINT,
        daily_variables: ['wave_height_max'],
        forecast_days: 2,
      });
    },
  },
  {
    name: 'openmeteo_get_air_quality',
    run: () => {
      service.getAirQuality.mockResolvedValue({
        ...ENVELOPE,
        hourly_units: { time: 'iso8601', pm2_5: 'μg/m³', [EMPHASIS_NAME]: 'undefined' },
        hourly: { time: hourly2, pm2_5: [4.1, 4.2], [EMPHASIS_NAME]: [null, null] },
      });
      return runToolContract(openmeteoGetAirQualityTool, {
        ...POINT,
        hourly_variables: ['pm2_5'],
        forecast_days: 1,
      });
    },
  },
  {
    name: 'openmeteo_get_ensemble',
    run: () => {
      service.getEnsemble.mockResolvedValue({
        ...ENVELOPE,
        daily_units: {
          time: 'iso8601',
          temperature_2m_max: '°C',
          temperature_2m_max_member01: '°C',
          [EMPHASIS_NAME]: 'undefined',
        },
        daily: {
          time: daily2,
          temperature_2m_max: [10, 11],
          temperature_2m_max_member01: [10.5, 11.5],
          [EMPHASIS_NAME]: [null, null],
        },
      });
      return runToolContract(openmeteoGetEnsembleTool, {
        ...POINT,
        daily_variables: ['temperature_2m_max'],
        forecast_days: 2,
      });
    },
  },
  {
    name: 'openmeteo_get_flood',
    run: () => {
      service.getFlood.mockResolvedValue({
        ...ENVELOPE,
        daily_units: { time: 'iso8601', river_discharge: 'm³/s', [EMPHASIS_NAME]: 'undefined' },
        daily: { time: daily2, river_discharge: [120, 118], [EMPHASIS_NAME]: [null, null] },
      });
      return runToolContract(openmeteoGetFloodTool, {
        ...POINT,
        daily_variables: ['river_discharge'],
        forecast_days: 2,
      });
    },
  },
  {
    name: 'openmeteo_get_climate',
    run: () => {
      service.getClimate.mockResolvedValue({
        ...ENVELOPE,
        daily_units: { time: 'iso8601', temperature_2m_max: '°C', [EMPHASIS_NAME]: 'undefined' },
        daily: { time: daily2, temperature_2m_max: [10, 11], [EMPHASIS_NAME]: [null, null] },
      });
      return runToolContract(openmeteoGetClimateTool, {
        ...POINT,
        start_date: daily2[0] as string,
        end_date: daily2[1] as string,
        daily_variables: ['temperature_2m_max'],
      });
    },
  },
] as const;

describe('notice rendering in content[]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('quotes a notice with no Markdown-active text as it always has', async () => {
    service.getHistorical.mockResolvedValue({
      ...ENVELOPE,
      daily_units: { time: 'iso8601', temperature_2m_max: '°C', uv_index_max: 'undefined' },
      daily: { time: daily2, temperature_2m_max: [10, 11], uv_index_max: [null, null] },
    });
    const result = await runToolContract(openmeteoGetHistoricalTool, {
      ...POINT,
      start_date: daily2[0] as string,
      end_date: daily2[1] as string,
      daily_variables: ['temperature_2m_max'],
    });

    const notice = noticeOf(result);
    expect(notice).toBe(
      'uv_index_max returned no data — Open-Meteo reported the unit as "undefined", which means ' +
        'the archive does not serve that name in the cadence it was requested under. Check the ' +
        'spelling, and whether it belongs in hourly_variables or daily_variables.',
    );
    expect(trailerOf(result)).toBe(`\n\n> ${notice}`);
  });

  it.each(RENDER_CASES)(
    '$name: content[] reads back exactly the stored notice',
    async ({ run }) => {
      const result = await run();

      const notice = noticeOf(result);
      // Stored as composed: the name as upstream returned it, nothing added for rendering.
      expect(notice).toContain(`${EMPHASIS_NAME} returned no data`);
      expect(notice).not.toMatch(/[\\`]/);
      expect(renderedText(trailerOf(result))).toBe(notice);
    },
  );
});

// --- model attribution of an all-null gap (#90) --------------------------------

describe('model attribution of an all-null coverage gap (#90)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const week = dates(7, '2020-06-01');
  const filled = (base: number) => week.map((_, row) => base + row);
  const empty = week.map(() => null);

  it('openmeteo_get_historical: names the empty model and the one that served the variable', async () => {
    // Live shape: era5_land carries no precipitation; era5 does. The second model also
    // returns snowfall_sum under the unit "undefined", which has its own sentence.
    service.getHistorical.mockResolvedValue({
      ...ENVELOPE,
      daily_units: {
        time: 'iso8601',
        temperature_2m_max_era5_land: '°C',
        precipitation_sum_era5_land: 'mm',
        snowfall_sum_era5_land: 'undefined',
        temperature_2m_max_era5: '°C',
        precipitation_sum_era5: 'mm',
        snowfall_sum_era5: 'cm',
      },
      daily: {
        time: week,
        temperature_2m_max_era5_land: filled(28),
        precipitation_sum_era5_land: empty,
        snowfall_sum_era5_land: empty,
        temperature_2m_max_era5: filled(27),
        precipitation_sum_era5: filled(0),
        snowfall_sum_era5: filled(0),
      },
    });

    const result = await runToolContract(openmeteoGetHistoricalTool, {
      ...POINT,
      start_date: week[0] as string,
      end_date: week[6] as string,
      daily_variables: ['temperature_2m_max', 'precipitation_sum', 'snowfall_sum'],
      models: ['era5_land', 'era5'],
    });

    expect(noticeOf(result)).toBe(
      'snowfall_sum_era5_land returned no data — Open-Meteo reported the unit as "undefined", ' +
        'which on a model-suffixed column means that model does not serve the variable: ' +
        'era5_land does not serve snowfall_sum. Read it from a model that serves it. ' +
        'era5_land returned no daily data for precipitation_sum_era5_land — all 7 values are ' +
        'null, while era5 returned values for the same variable. Read it from era5.',
    );
    expect(renderedText(trailerOf(result))).toBe(noticeOf(result));
  });

  it('openmeteo_get_historical: attributes the archive’s _archive_best_match columns to best_match', async () => {
    // Live shape: beside another model the archive suffixes Best Match `_archive_best_match`.
    service.getHistorical.mockResolvedValue({
      ...ENVELOPE,
      daily_units: {
        time: 'iso8601',
        temperature_2m_max_archive_best_match: '°C',
        temperature_2m_max_era5: '°C',
      },
      daily: {
        time: week,
        temperature_2m_max_archive_best_match: filled(28),
        temperature_2m_max_era5: filled(27),
      },
    });

    const result = await runToolContract(openmeteoGetHistoricalTool, {
      ...POINT,
      start_date: week[0] as string,
      end_date: week[6] as string,
      daily_variables: ['temperature_2m_max'],
      models: ['best_match', 'era5'],
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('openmeteo_get_historical: keeps the location-or-window sentence when no models were sent', async () => {
    service.getHistorical.mockResolvedValue({
      ...ENVELOPE,
      daily_units: { time: 'iso8601', temperature_2m_max: '°C', precipitation_sum: 'mm' },
      daily: { time: week, temperature_2m_max: filled(28), precipitation_sum: empty },
    });

    const result = await runToolContract(openmeteoGetHistoricalTool, {
      ...POINT,
      start_date: week[0] as string,
      end_date: week[6] as string,
      daily_variables: ['temperature_2m_max', 'precipitation_sum'],
    });

    expect(noticeOf(result)).toBe(
      'No daily data for precipitation_sum anywhere in the requested window — all 7 values are ' +
        'null even though the units are real, so this location or the requested window falls ' +
        'outside this dataset’s coverage rather than the names being unserved.',
    );
  });

  const day = hours(24, '2026-11-09T00:00');

  it('openmeteo_get_forecast: names the empty model and the one that served the variable', async () => {
    service.getForecast.mockResolvedValue({
      ...ENVELOPE,
      hourly_units: {
        time: 'iso8601',
        temperature_2m_dwd_icon_seamless: '°C',
        visibility_dwd_icon_seamless: 'm',
        temperature_2m_ncep_hrrr_conus: '°C',
        visibility_ncep_hrrr_conus: 'm',
      },
      hourly: {
        time: day,
        temperature_2m_dwd_icon_seamless: day.map(() => 9),
        visibility_dwd_icon_seamless: day.map(() => null),
        temperature_2m_ncep_hrrr_conus: day.map(() => 9.5),
        visibility_ncep_hrrr_conus: day.map(() => 16_200),
      },
    });

    const result = await runToolContract(openmeteoGetForecastTool, {
      ...POINT,
      hourly_variables: ['temperature_2m', 'visibility'],
      models: ['dwd_icon_seamless', 'ncep_hrrr_conus'],
      forecast_days: 1,
    });

    expect(noticeOf(result)).toBe(
      'dwd_icon_seamless returned no hourly data for visibility_dwd_icon_seamless — all 24 values ' +
        'are null, while ncep_hrrr_conus returned values for the same variable. Read it from ' +
        'ncep_hrrr_conus.',
    );
  });

  it('openmeteo_get_forecast: keeps the location-or-window sentence when no models were sent', async () => {
    service.getForecast.mockResolvedValue({
      ...ENVELOPE,
      hourly_units: { time: 'iso8601', temperature_2m: '°C', visibility: 'm' },
      hourly: { time: day, temperature_2m: day.map(() => 9), visibility: day.map(() => null) },
    });

    const result = await runToolContract(openmeteoGetForecastTool, {
      ...POINT,
      hourly_variables: ['temperature_2m', 'visibility'],
      forecast_days: 1,
    });

    expect(noticeOf(result)).toBe(
      'No hourly data for visibility anywhere in the requested window — all 24 values are null ' +
        'even though the units are real, so this location or the requested window falls outside ' +
        'this dataset’s coverage rather than the names being unserved.',
    );
  });

  it('openmeteo_get_climate: names the empty model and the one that served the variables', async () => {
    service.getClimate.mockResolvedValue({
      ...ENVELOPE,
      daily_units: {
        time: 'iso8601',
        temperature_2m_max_CMCC_CM2_VHR4: '°C',
        rain_sum_CMCC_CM2_VHR4: 'mm',
        shortwave_radiation_sum_CMCC_CM2_VHR4: 'MJ/m²',
        temperature_2m_max_MRI_AGCM3_2_S: '°C',
        rain_sum_MRI_AGCM3_2_S: 'mm',
        shortwave_radiation_sum_MRI_AGCM3_2_S: 'MJ/m²',
      },
      daily: {
        time: week,
        temperature_2m_max_CMCC_CM2_VHR4: filled(28),
        rain_sum_CMCC_CM2_VHR4: empty,
        shortwave_radiation_sum_CMCC_CM2_VHR4: empty,
        temperature_2m_max_MRI_AGCM3_2_S: filled(27),
        rain_sum_MRI_AGCM3_2_S: filled(0),
        shortwave_radiation_sum_MRI_AGCM3_2_S: filled(20),
      },
    });

    const result = await runToolContract(openmeteoGetClimateTool, {
      ...POINT,
      start_date: week[0] as string,
      end_date: week[6] as string,
      daily_variables: ['temperature_2m_max', 'rain_sum', 'shortwave_radiation_sum'],
      models: ['CMCC_CM2_VHR4', 'MRI_AGCM3_2_S'],
    });

    expect(noticeOf(result)).toBe(
      'CMCC_CM2_VHR4 returned no daily data for rain_sum_CMCC_CM2_VHR4, ' +
        'shortwave_radiation_sum_CMCC_CM2_VHR4 — all 7 values are null, while MRI_AGCM3_2_S ' +
        'returned values for the same variables. Read them from MRI_AGCM3_2_S.',
    );
  });

  it('openmeteo_get_climate: keeps the location-or-window sentence when no models were sent', async () => {
    service.getClimate.mockResolvedValue({
      ...ENVELOPE,
      daily_units: { time: 'iso8601', temperature_2m_max: '°C', rain_sum: 'mm' },
      daily: { time: week, temperature_2m_max: filled(28), rain_sum: empty },
    });

    const result = await runToolContract(openmeteoGetClimateTool, {
      ...POINT,
      start_date: week[0] as string,
      end_date: week[6] as string,
      daily_variables: ['temperature_2m_max', 'rain_sum'],
    });

    expect(noticeOf(result)).toBe(
      'No daily data for rain_sum anywhere in the requested window — all 7 values are null even ' +
        'though the units are real, so this location or the requested window falls outside this ' +
        'dataset’s coverage rather than the names being unserved.',
    );
  });
});

// --- short-window edge gaps (#91) --------------------------------------------

describe('a horizon or archive-start gap under six null rows (#91)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('openmeteo_get_ensemble: names where a 35-day pull’s data ends (1 trailing row of 35)', async () => {
    // Live: ncep_gefs05 over 35 days leaves the last daily row null on every member.
    const time = dates(35, '2026-11-09');
    const member = (base: number) => time.map((_, row) => (row < 34 ? base + row / 10 : null));
    service.getEnsemble.mockResolvedValue({
      ...ENVELOPE,
      daily_units: {
        time: 'iso8601',
        temperature_2m_max: '°C',
        temperature_2m_max_member01: '°C',
        temperature_2m_max_member02: '°C',
      },
      daily: {
        time,
        temperature_2m_max: member(8),
        temperature_2m_max_member01: member(9),
        temperature_2m_max_member02: member(10),
      },
    });

    const result = await runToolContract(openmeteoGetEnsembleTool, {
      ...POINT,
      daily_variables: ['temperature_2m_max'],
      models: 'ncep_gefs05',
      forecast_days: 35,
    });

    expect(noticeOf(result)).toBe(
      'Partial daily coverage for temperature_2m_max: data runs 2026-11-09 to 2026-12-12, and 1 ' +
        'of 35 rows is null.',
    );
  });

  it('openmeteo_get_forecast: names a regional model’s horizon on a 3-day pull (1 trailing row of 3)', async () => {
    const time = dates(3, '2026-11-09');
    service.getForecast.mockResolvedValue({
      ...ENVELOPE,
      daily_units: {
        time: 'iso8601',
        temperature_2m_max_ecmwf_ifs025: '°C',
        temperature_2m_max_ncep_hrrr_conus: '°C',
      },
      daily: {
        time,
        temperature_2m_max_ecmwf_ifs025: [9, 10, 11],
        temperature_2m_max_ncep_hrrr_conus: [9.5, 10.5, null],
      },
    });

    const result = await runToolContract(openmeteoGetForecastTool, {
      ...POINT,
      daily_variables: ['temperature_2m_max'],
      models: ['ecmwf_ifs025', 'ncep_hrrr_conus'],
      forecast_days: 3,
    });

    expect(noticeOf(result)).toBe(
      'Partial daily coverage for temperature_2m_max_ncep_hrrr_conus: data runs 2026-11-09 to ' +
        '2026-11-10, and 1 of 3 rows is null.',
    );
  });

  it('openmeteo_get_historical: names where ERA5’s lag ends a 100-day window (5 trailing rows)', async () => {
    const time = dates(100, '2026-08-01');
    service.getHistorical.mockResolvedValue({
      ...ENVELOPE,
      daily_units: { time: 'iso8601', temperature_2m_max: '°C' },
      daily: { time, temperature_2m_max: time.map((_, row) => (row < 95 ? 20 : null)) },
    });

    const result = await runToolContract(openmeteoGetHistoricalTool, {
      ...POINT,
      start_date: time[0] as string,
      end_date: time[99] as string,
      daily_variables: ['temperature_2m_max'],
      models: ['era5'],
    });

    expect(noticeOf(result)).toBe(
      'Partial daily coverage for temperature_2m_max: data runs 2026-08-01 to 2026-11-03, and 5 ' +
        'of 100 rows are null.',
    );
  });
});
