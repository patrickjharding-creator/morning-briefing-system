import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import type { BriefingData } from '@morning-briefing/shared'
import { fetchWeather } from './weather'
import { fetchCalendarData } from './calendar'
import { fetchGarminData } from './garmin'
import { buildParentingData } from './parenting'
import { parseFitnessPlan } from './fitness-plan'
import { buildRaceCountdown } from './smart-dates'

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-southeast-2' })
const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'ap-southeast-2' })

const BUCKET = process.env.S3_BUCKET!
const CONFIG_BUCKET = process.env.CONFIG_BUCKET ?? BUCKET

async function getSecret(name: string): Promise<string> {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: name }))
  if (!res.SecretString) throw new Error(`Secret ${name} is empty`)
  return res.SecretString
}

async function getS3Text(key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: CONFIG_BUCKET, Key: key }))
  return await res.Body!.transformToString()
}

export async function handler(): Promise<void> {
  const today = new Date()
  const dateStr = today.toISOString().slice(0, 10)

  console.log(`Ingest Lambda running for ${dateStr}`)

  // ── Secrets ──────────────────────────────────────────────────────────────

  const [
    owmApiKey,
    icloudPassword,
    garminCredentialsRaw,
  ] = await Promise.all([
    getSecret('OPENWEATHERMAP_API_KEY'),
    getSecret('ICLOUD_APP_PASSWORD'),
    getSecret('GARMIN_CREDENTIALS'),
  ])

  const garminCredentials = JSON.parse(garminCredentialsRaw) as { username: string; password: string }

  // ── Config files (from S3 config bucket) ─────────────────────────────────

  const [briefingConfigRaw, parentingScheduleRaw, fitnessPlanRaw] = await Promise.all([
    getS3Text('personal-config/briefing-config.json'),
    getS3Text('personal-config/parenting-schedule.json'),
    getS3Text('personal-config/fitness-plan.yaml'),
  ])

  const briefingConfig = JSON.parse(briefingConfigRaw) as {
    location: { lat: number; lon: number }
    weather: { advisory_rules: Record<string, unknown> }
    calendar: { caldav_url: string; apple_id: string; birthdays_in_calendar: boolean; race_detection: { calendar_name: string; fallback_title_keywords: string[] } }
    garmin: { goals: { weight_kg: number; sleep_hours: number } }
    smart_dates: { birthday_advance_warning_days: number; race_warning_weeks: number[]; plan_expiry_warning_days: number }
  }

  const parentingSchedule = JSON.parse(parentingScheduleRaw)

  // ── Fetch all data sources in parallel ───────────────────────────────────

  const [weatherResult, calendarResult, garminResult] = await Promise.allSettled([
    fetchWeather(owmApiKey, {
      lat: briefingConfig.location.lat,
      lon: briefingConfig.location.lon,
      advisory_rules: briefingConfig.weather.advisory_rules as Parameters<typeof fetchWeather>[1]['advisory_rules'],
    }),
    fetchCalendarData({
      caldav_url: briefingConfig.calendar.caldav_url,
      apple_id: briefingConfig.calendar.apple_id,
      password: icloudPassword,
      birthdays_in_calendar: briefingConfig.calendar.birthdays_in_calendar,
      race_detection: briefingConfig.calendar.race_detection,
      smart_dates: { race_warning_weeks: briefingConfig.smart_dates.race_warning_weeks },
    }, today),
    fetchGarminData(garminCredentials, today),
  ])

  if (weatherResult.status === 'rejected') console.error('Weather fetch failed:', weatherResult.reason)
  if (calendarResult.status === 'rejected') console.error('Calendar fetch failed:', calendarResult.reason)
  if (garminResult.status === 'rejected') console.error('Garmin fetch failed:', garminResult.reason)

  const weather = weatherResult.status === 'fulfilled' ? weatherResult.value : {
    periods: [], advisory: null, fetched_at: new Date().toISOString()
  }

  const { appointments = [], birthdays = [], races = [] } =
    calendarResult.status === 'fulfilled' ? calendarResult.value : {}

  const garmin = garminResult.status === 'fulfilled' ? garminResult.value : null

  // ── Parenting ─────────────────────────────────────────────────────────────

  const parenting = buildParentingData(parentingSchedule, today)

  // ── Fitness plan ─────────────────────────────────────────────────────────

  const { planned_session, plan_expiry_warning, weekly_planned_count } = parseFitnessPlan(
    fitnessPlanRaw,
    today,
    briefingConfig.smart_dates.plan_expiry_warning_days
  )

  // ── Nearest upcoming race ─────────────────────────────────────────────────

  const nextRace = races[0] ?? null

  // ── Assemble ingest JSON ──────────────────────────────────────────────────

  const briefing: Partial<BriefingData> = {
    date: dateStr,
    opening_line: null,          // Synthesis Lambda
    weather,
    appointments,
    birthdays,
    race: nextRace,
    parenting,
    reminders: [],               // TODO: Apple Reminders via iCloud CalDAV (VTODO)
    suggested_actions: [],       // Synthesis Lambda
    drafts: [],                  // Synthesis Lambda
    fitness: {
      recovery: garmin?.recovery ?? {
        hrv_status: 'Unknown', hrv_value: null,
        sleep_duration_hr: 0, body_battery: null, resting_hr: null,
      },
      planned_session,
      last_activity: garmin?.last_activity ?? null,
      weekly_progress: {
        completed: garmin?.weekly_activity_count ?? 0,
        planned: weekly_planned_count,
      },
      goals: garmin?.goals ?? {
        weight_current_kg: null,
        weight_target_kg: briefingConfig.garmin.goals.weight_kg,
        sleep_30day_avg_hr: null,
        sleep_target_hr: briefingConfig.garmin.goals.sleep_hours,
      },
      race_countdown: nextRace?.countdown_flag ?? null,
      plan_expiry_warning,
      commentary: null,          // Synthesis Lambda
    },
    news: [],                    // Batch Lambda (11pm job)
    philosopher: null,           // Synthesis Lambda
  }

  // ── Write to S3 ──────────────────────────────────────────────────────────

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `ingest/${dateStr}.json`,
    Body: JSON.stringify(briefing, null, 2),
    ContentType: 'application/json',
  }))

  console.log(`Ingest complete — written to s3://${BUCKET}/ingest/${dateStr}.json`)
}
