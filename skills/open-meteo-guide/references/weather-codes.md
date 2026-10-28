# WMO weather codes

`weather_code` on `openmeteo_get_forecast` and `openmeteo_get_historical` returns an integer with the unit `wmo code`. The server does not decode it. The table is Open-Meteo's published WMO interpretation set.

On daily rows the code is the most severe condition of the day, so a daily `80` means showers at some point that day, not all day. Read hourly `weather_code` or `precipitation_hours` to tell how long.

| Code | Condition |
|:--|:--|
| 0 | Clear sky |
| 1 | Mainly clear |
| 2 | Partly cloudy |
| 3 | Overcast |
| 45 | Fog |
| 48 | Depositing rime fog |
| 51 | Light drizzle |
| 53 | Moderate drizzle |
| 55 | Dense drizzle |
| 56 | Light freezing drizzle |
| 57 | Dense freezing drizzle |
| 61 | Slight rain |
| 63 | Moderate rain |
| 65 | Heavy rain |
| 66 | Light freezing rain |
| 67 | Heavy freezing rain |
| 71 | Slight snowfall |
| 73 | Moderate snowfall |
| 75 | Heavy snowfall |
| 77 | Snow grains |
| 80 | Slight rain showers |
| 81 | Moderate rain showers |
| 82 | Violent rain showers |
| 85 | Slight snow showers |
| 86 | Heavy snow showers |
| 95 | Thunderstorm |
| 96 | Thunderstorm with slight hail |
| 97 | Heavy thunderstorm |
| 99 | Thunderstorm with heavy hail |

Only models with an explicit hail forecast report 96 and 99 (Open-Meteo names DWD ICON and UKMO).
