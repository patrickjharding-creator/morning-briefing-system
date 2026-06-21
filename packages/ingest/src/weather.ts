import axios from 'axios'
import type { WeatherData, WeatherPeriod } from '@morning-briefing/shared'

interface Config {
  lat: number
  lon: number
  advisory_rules: {
    rain_threshold_mm: number
    heat_threshold_celsius: number
    wind_threshold_kmh: number
    training_window_start: string  // "HH:MM"
    training_window_end: string    // "HH:MM"
  }
}

interface OWMForecastItem {
  dt: number
  main: { temp: number; temp_min: number; temp_max: number }
  weather: Array<{ description: string }>
  rain?: { '3h': number }
  wind: { speed: number }  // m/s
}

interface OWMResponse {
  list: OWMForecastItem[]
}

function toHourMin(timeStr: string): { h: number; m: number } {
  const [h, m] = timeStr.split(':').map(Number)
  return { h, m }
}

function isInWindow(dt: Date, start: string, end: string): boolean {
  const s = toHourMin(start)
  const e = toHourMin(end)
  const minutes = dt.getHours() * 60 + dt.getMinutes()
  return minutes >= s.h * 60 + s.m && minutes <= e.h * 60 + e.m
}

function buildAdvisory(
  items: OWMForecastItem[],
  rules: Config['advisory_rules'],
  now: Date
): string | null {
  const flags: string[] = []

  const windowItems = items.filter(item => {
    const dt = new Date(item.dt * 1000)
    const sameDay =
      dt.getDate() === now.getDate() &&
      dt.getMonth() === now.getMonth()
    return sameDay && isInWindow(dt, rules.training_window_start, rules.training_window_end)
  })

  const maxRain = Math.max(0, ...windowItems.map(i => i.rain?.['3h'] ?? 0))
  const maxTemp = Math.max(...windowItems.map(i => i.main.temp - 273.15))
  const maxWind = Math.max(...windowItems.map(i => i.wind.speed * 3.6))

  if (maxRain >= rules.rain_threshold_mm) flags.push(`rain (${maxRain.toFixed(1)} mm)`)
  if (maxTemp >= rules.heat_threshold_celsius) flags.push(`heat (${maxTemp.toFixed(0)}°C)`)
  if (maxWind >= rules.wind_threshold_kmh) flags.push(`wind (${maxWind.toFixed(0)} km/h)`)

  if (flags.length === 0) return null
  return `Training window advisory (${rules.training_window_start}–${rules.training_window_end}): ${flags.join(', ')}`
}

export async function fetchWeather(apiKey: string, config: Config): Promise<WeatherData> {
  const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${config.lat}&lon=${config.lon}&appid=${apiKey}&cnt=24`
  const { data } = await axios.get<OWMResponse>(url)
  const now = new Date()

  // Bucket forecast items into today, tonight, tomorrow
  const todayItems: OWMForecastItem[] = []
  const tonightItems: OWMForecastItem[] = []
  const tomorrowItems: OWMForecastItem[] = []

  for (const item of data.list) {
    const dt = new Date(item.dt * 1000)
    const dayOffset = dt.getDate() - now.getDate()
    const hour = dt.getHours()

    if (dayOffset === 0 && hour < 18) todayItems.push(item)
    else if (dayOffset === 0 && hour >= 18) tonightItems.push(item)
    else if (dayOffset === 1) tomorrowItems.push(item)
  }

  function summarisePeriod(items: OWMForecastItem[], label: string): WeatherPeriod {
    const temps = items.map(i => i.main.temp - 273.15)
    const rain = items.reduce((sum, i) => sum + (i.rain?.['3h'] ?? 0), 0)
    const wind = Math.max(...items.map(i => i.wind.speed * 3.6))
    const condition = items[0]?.weather[0]?.description ?? 'Unknown'

    return {
      label,
      condition: condition.charAt(0).toUpperCase() + condition.slice(1),
      temp_min_c: Math.round(Math.min(...temps)),
      temp_max_c: Math.round(Math.max(...temps)),
      rain_mm: Math.round(rain * 10) / 10,
      wind_kmh: Math.round(wind),
    }
  }

  const periods: WeatherPeriod[] = []
  if (todayItems.length) periods.push(summarisePeriod(todayItems, 'Today'))
  if (tonightItems.length) periods.push(summarisePeriod(tonightItems, 'Tonight'))
  if (tomorrowItems.length) periods.push(summarisePeriod(tomorrowItems, 'Tomorrow'))

  return {
    periods,
    advisory: buildAdvisory(data.list, config.advisory_rules, now),
    fetched_at: now.toISOString(),
  }
}
