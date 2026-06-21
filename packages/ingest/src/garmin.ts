import GarminConnect from 'garmin-connect'
import type { GarminRecovery, GarminActivity, GarminGoals } from '@morning-briefing/shared'

interface GarminCredentials {
  username: string
  password: string
}

export interface GarminData {
  recovery: GarminRecovery
  last_activity: GarminActivity | null
  goals: GarminGoals
  weekly_activity_count: number
}

function disciplineFromTypeKey(typeKey: string): string {
  const t = typeKey.toLowerCase()
  if (t.includes('running') || t.includes('run')) return 'run'
  if (t.includes('cycling') || t.includes('biking') || t.includes('road_biking')) return 'cycling'
  if (t.includes('swimming') || t.includes('swim')) return 'swim'
  if (t.includes('strength') || t.includes('gym')) return 'strength'
  return typeKey
}

function getStartOfWeek(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day  // Monday as start
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

export async function fetchGarminData(
  credentials: GarminCredentials,
  today: Date
): Promise<GarminData> {
  const client = new GarminConnect.GarminConnect(credentials, 'garmin.com')
  await client.login()

  const [sleepResult, heartRateResult, weightResult, activitiesResult] = await Promise.allSettled([
    client.getSleepData(today),
    client.getHeartRate(today),
    client.getDailyWeightData(today),
    client.getActivities(0, 14),
  ])

  // ── Recovery ─────────────────────────────────────────────────────────────

  const sleep = sleepResult.status === 'fulfilled' ? sleepResult.value : null
  const sleepSec = sleep?.dailySleepDTO?.sleepTimeSeconds ?? 0
  const sleepDurationHr = Math.round((sleepSec / 3600) * 10) / 10
  const restingHr = sleep?.restingHeartRate ?? null

  // HRV and Body Battery are available on SleepData directly
  const hrvValue = sleep?.avgOvernightHrv ?? null
  const hrvStatus = sleep?.hrvStatus ?? 'Unavailable'
  const bodyBattery = sleep?.bodyBatteryChange ?? null

  // ── Last activity + weekly count ──────────────────────────────────────────

  let lastActivity: GarminActivity | null = null
  let weeklyCount = 0

  if (activitiesResult.status === 'fulfilled') {
    const acts = activitiesResult.value
    const startOfWeek = getStartOfWeek(today)

    weeklyCount = acts.filter(a => new Date(a.startTimeLocal) >= startOfWeek).length

    const last = acts[0]
    if (last) {
      lastActivity = {
        discipline: disciplineFromTypeKey(last.activityType?.typeKey ?? ''),
        name: last.activityName,
        date: last.startTimeLocal.slice(0, 10),
        duration_min: Math.round((last.duration ?? 0) / 60),
        distance_km: last.distance ? Math.round((last.distance / 1000) * 10) / 10 : null,
        avg_hr: last.averageHR ?? null,
      }
    }
  }

  // ── Goals ─────────────────────────────────────────────────────────────────

  // Weight comes back in grams from Garmin API
  const weightGrams = weightResult.status === 'fulfilled'
    ? weightResult.value?.totalAverage?.weight ?? null
    : null
  const weightKg = weightGrams ? Math.round((weightGrams / 1000) * 10) / 10 : null

  return {
    recovery: {
      hrv_status: hrvStatus,
      hrv_value: hrvValue,
      sleep_duration_hr: sleepDurationHr,
      body_battery: bodyBattery,
      resting_hr: restingHr,
    },
    last_activity: lastActivity,
    goals: {
      weight_current_kg: weightKg,
      weight_target_kg: 90,
      sleep_30day_avg_hr: null,   // requires 30-day aggregation — add in v2
      sleep_target_hr: 7,
    },
    weekly_activity_count: weeklyCount,
  }
}
