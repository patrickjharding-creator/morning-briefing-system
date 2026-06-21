import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import type { BriefingData } from '@morning-briefing/shared'
import { fetchWeather } from './weather'
import { buildRaceCountdown, buildPlanExpiryWarning } from './smart-dates'

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-southeast-2' })
const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'ap-southeast-2' })

const BUCKET = process.env.S3_BUCKET!
const CONFIG_BUCKET = process.env.CONFIG_BUCKET ?? BUCKET

async function getSecret(name: string): Promise<string> {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: name }))
  if (!res.SecretString) throw new Error(`Secret ${name} is empty`)
  return res.SecretString
}

async function getConfig(): Promise<Record<string, unknown>> {
  // TODO: fetch from GitHub config repo via GitHub API
  // For local dev, fall back to reading from the local personal-config directory
  throw new Error('getConfig not yet implemented')
}

export async function handler(): Promise<void> {
  const today = new Date()
  const dateStr = today.toISOString().slice(0, 10)

  console.log(`Ingest Lambda running for ${dateStr}`)

  const [owmApiKey] = await Promise.all([
    getSecret('OPENWEATHERMAP_API_KEY'),
  ])

  // TODO: load briefing-config.json from GitHub config repo
  const config = {
    lat: -33.8885,
    lon: 151.2099,
    advisory_rules: {
      rain_threshold_mm: 2,
      heat_threshold_celsius: 28,
      wind_threshold_kmh: 30,
      training_window_start: '06:00',
      training_window_end: '09:00',
    },
    smart_dates: {
      birthday_advance_warning_days: 7,
      race_warning_weeks: [8, 4, 2, 1] as number[],
      plan_expiry_warning_days: 7,
    },
  }

  // ── Fetch all data sources in parallel ──────────────────────────────────────

  const [weather] = await Promise.all([
    fetchWeather(owmApiKey, config),
    // TODO: fetchCalendar()
    // TODO: fetchParenting()
    // TODO: fetchReminders()
    // TODO: fetchGarmin()
    // TODO: fetchFitnessPlan()
  ])

  // ── Assemble partial briefing JSON (ingest stage only) ─────────────────────
  // Synthesis Lambda will fill: opening_line, suggested_actions, drafts,
  // fitness.commentary, philosopher, news (from Batch job)

  const briefing: Partial<BriefingData> = {
    date: dateStr,
    opening_line: null,
    weather,
    appointments: [],       // TODO
    birthdays: [],          // TODO
    race: null,             // TODO
    parenting: {            // TODO
      is_school_day: false,
      is_school_holiday: false,
      pat_periods: [],
      school_holiday_flag: null,
      last_dropoff_flag: null,
    },
    reminders: [],          // TODO
    suggested_actions: [],
    drafts: [],
    fitness: {              // TODO
      recovery: {
        hrv_status: 'Unknown',
        hrv_value: null,
        sleep_duration_hr: 0,
        body_battery: null,
        resting_hr: null,
      },
      planned_session: null,
      last_activity: null,
      weekly_progress: { completed: 0, planned: 0 },
      goals: {
        weight_current_kg: null,
        weight_target_kg: 90,
        sleep_30day_avg_hr: null,
        sleep_target_hr: 7,
      },
      race_countdown: null,
      plan_expiry_warning: null,
      commentary: null,
    },
    news: [],
    philosopher: null,
  }

  // ── Write to S3 ─────────────────────────────────────────────────────────────

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `ingest/${dateStr}.json`,
    Body: JSON.stringify(briefing, null, 2),
    ContentType: 'application/json',
  }))

  console.log(`Ingest complete — written to s3://${BUCKET}/ingest/${dateStr}.json`)
}
