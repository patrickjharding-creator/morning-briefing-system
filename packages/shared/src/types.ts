// ─── Weather ────────────────────────────────────────────────────────────────

export interface WeatherPeriod {
  label: string          // "Today", "Tonight", "Tomorrow"
  condition: string      // e.g. "Partly cloudy"
  temp_min_c: number
  temp_max_c: number
  rain_mm: number
  wind_kmh: number
}

export interface WeatherData {
  periods: WeatherPeriod[]
  advisory: string | null  // e.g. "Rain during training window (07:00–09:00)"
  fetched_at: string       // ISO timestamp
}

// ─── Calendar / Appointments ─────────────────────────────────────────────────

export interface CalendarEvent {
  id: string
  title: string
  start: string    // ISO timestamp
  end: string      // ISO timestamp
  all_day: boolean
  calendar: string // calendar name
  location?: string
  notes?: string
}

export interface Birthday {
  name: string
  date: string     // ISO date (YYYY-MM-DD)
  days_away: number
}

export interface RaceEvent {
  name: string
  date: string     // ISO date (YYYY-MM-DD)
  days_away: number
  countdown_flag: string | null  // e.g. "Race week", "Taper starts 2026-06-29"
}

// ─── Parenting ───────────────────────────────────────────────────────────────

export interface ParentingPeriod {
  period: 'morning' | 'afternoon' | 'evening' | 'night'
  time_start: string
  time_end: string
  assignee: string        // "pat", "pam", "sophie"
  duties: string[]
  sophie_note?: string    // populated when assignee is "sophie"
}

export interface ParentingData {
  is_school_day: boolean
  is_school_holiday: boolean
  pat_periods: ParentingPeriod[]
  school_holiday_flag: string | null   // e.g. "School holidays start in 2 days"
  last_dropoff_flag: string | null     // e.g. "Last school drop-off of the week"
}

// ─── Reminders / To-Do ───────────────────────────────────────────────────────

export interface Reminder {
  id: string
  title: string
  due: string | null    // ISO timestamp
  overdue: boolean
  list: string          // reminder list name
  notes?: string
}

// ─── Fitness ─────────────────────────────────────────────────────────────────

export interface GarminRecovery {
  hrv_status: string        // e.g. "Balanced", "Poor"
  hrv_value: number | null
  sleep_duration_hr: number
  body_battery: number | null
  resting_hr: number | null
}

export interface GarminActivity {
  discipline: string        // e.g. "run", "cycling", "swim"
  name: string
  date: string
  duration_min: number
  distance_km: number | null
  avg_hr: number | null
}

export interface GarminGoals {
  weight_current_kg: number | null
  weight_target_kg: number
  sleep_30day_avg_hr: number | null
  sleep_target_hr: number
}

export interface PlannedSession {
  discipline: string
  type: string
  duration_min?: number
  distance_km?: number
  distance_m?: number
  rpe?: number
  notes: string
}

export interface FitnessData {
  recovery: GarminRecovery
  planned_session: PlannedSession | null   // null = rest day
  last_activity: GarminActivity | null
  weekly_progress: { completed: number; planned: number }
  goals: GarminGoals
  race_countdown: string | null            // from smart date logic
  plan_expiry_warning: string | null
  commentary: string | null               // populated by Haiku in synthesis
}

// ─── Messaging ───────────────────────────────────────────────────────────────

export type MessageSource = 'gmail' | 'imessage' | 'whatsapp' | 'messenger'

export interface NormalisedMessage {
  id: string
  source: MessageSource
  source_id: string
  thread_id: string
  direction: 'inbound' | 'outbound'
  sender: { name: string; identifier: string }
  recipients: Array<{ name: string; identifier: string }>
  subject?: string
  body: string
  timestamp: string
  read: boolean
  attachments?: Array<{ type: string; name: string }>
  metadata: Record<string, unknown>
}

// ─── Correspondence drafts ───────────────────────────────────────────────────

export interface DraftCorrespondence {
  id: string
  created_at: string
  status: 'draft' | 'approved' | 'rejected' | 'sent'
  to: string
  subject: string
  body: string
  context: string
  approved_at?: string
  sent_at?: string
}

// ─── News ────────────────────────────────────────────────────────────────────

export interface NewsBullet {
  topic: string    // "World", "Australia", "Technology", "Science", "Business"
  headline: string // max 25 words
  source: string
}

// ─── Gmail classification ─────────────────────────────────────────────────────

export interface ClassifiedThread {
  thread_id: string
  subject: string
  sender: string
  action_needed: boolean
  summary: string
  messages: NormalisedMessage[]
}

// ─── Assembled briefing ──────────────────────────────────────────────────────

export interface BriefingData {
  date: string                       // YYYY-MM-DD
  opening_line: string | null        // populated by Sonnet in synthesis
  weather: WeatherData
  appointments: CalendarEvent[]
  birthdays: Birthday[]
  race: RaceEvent | null
  parenting: ParentingData
  reminders: Reminder[]
  suggested_actions: string[]        // populated by Sonnet in synthesis
  drafts: DraftCorrespondence[]      // populated by Sonnet in synthesis
  fitness: FitnessData
  news: NewsBullet[]                 // populated by Batch job
  philosopher: { quote: string; author: string; tradition: string } | null
}
