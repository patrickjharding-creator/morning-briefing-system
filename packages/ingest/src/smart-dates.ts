import type { RaceEvent, Birthday } from '@morning-briefing/shared'

const MS_PER_DAY = 1000 * 60 * 60 * 24

function daysBetween(a: Date, b: Date): number {
  const msA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())
  const msB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
  return Math.round((msB - msA) / MS_PER_DAY)
}

function weeksAway(days: number): number {
  return Math.floor(days / 7)
}

// ─── Race countdown ──────────────────────────────────────────────────────────

export function buildRaceCountdown(
  raceDate: string,
  raceName: string,
  warningWeeks: number[],
  today: Date
): RaceEvent | null {
  const race = new Date(raceDate)
  const days = daysBetween(today, race)

  if (days < 0) return null  // race is in the past

  let countdown_flag: string | null = null

  if (days === 0) {
    countdown_flag = `Race day — ${raceName}`
  } else if (days <= 7) {
    countdown_flag = `Race week — ${raceName} in ${days} day${days === 1 ? '' : 's'}`
  } else {
    const weeks = weeksAway(days)
    const sortedWarnings = [...warningWeeks].sort((a, b) => b - a)
    for (const w of sortedWarnings) {
      if (weeks <= w) {
        countdown_flag = buildWeekFlag(weeks, raceName)
        break
      }
    }
  }

  return { name: raceName, date: raceDate, days_away: days, countdown_flag }
}

function buildWeekFlag(weeks: number, raceName: string): string {
  if (weeks <= 1) return `Race week — ${raceName}`
  if (weeks === 2) return `${raceName} — taper time (2 weeks out)`
  if (weeks === 4) return `${raceName} — final build week approaching (4 weeks)`
  if (weeks === 8) return `${raceName} — entering peak block (8 weeks)`
  return `${raceName} in ${weeks} weeks`
}

// ─── School flags ────────────────────────────────────────────────────────────

interface SchoolHoliday {
  start: string
  end: string
  note: string
}

export function buildSchoolHolidayFlag(
  holidays: SchoolHoliday[],
  today: Date,
  advanceDays = 3
): string | null {
  for (const h of holidays) {
    const start = new Date(h.start)
    const days = daysBetween(today, start)
    if (days > 0 && days <= advanceDays) {
      return `School holidays start in ${days} day${days === 1 ? '' : 's'} — ${h.note}`
    }
  }
  return null
}

export function isSchoolHoliday(holidays: SchoolHoliday[], today: Date): boolean {
  const todayStr = today.toISOString().slice(0, 10)
  return holidays.some(h => todayStr >= h.start && todayStr <= h.end)
}

export function isLastDropoffOfWeek(today: Date, patMorningDays: string[]): boolean {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const todayName = days[today.getDay()]
  if (!patMorningDays.includes(todayName)) return false

  // Check if there are any more Pat morning days before the weekend
  const todayIdx = today.getDay()  // 0=Sun, 6=Sat
  for (let d = todayIdx + 1; d <= 5; d++) {  // Mon–Fri only
    if (patMorningDays.includes(days[d])) return false
  }
  return true
}

// ─── Birthday flags ──────────────────────────────────────────────────────────

export function buildBirthdayFlags(
  birthdays: Array<{ name: string; date: string }>,
  today: Date,
  advanceDays: number
): Birthday[] {
  const upcoming: Birthday[] = []

  for (const b of birthdays) {
    // Normalise to current year
    const thisYear = new Date(b.date)
    thisYear.setFullYear(today.getFullYear())

    let days = daysBetween(today, thisYear)

    // If already passed this year, check next year
    if (days < 0) {
      thisYear.setFullYear(today.getFullYear() + 1)
      days = daysBetween(today, thisYear)
    }

    if (days > 0 && days <= advanceDays) {
      upcoming.push({ name: b.name, date: thisYear.toISOString().slice(0, 10), days_away: days })
    }
  }

  return upcoming.sort((a, b) => a.days_away - b.days_away)
}

// ─── Plan expiry ─────────────────────────────────────────────────────────────

export function buildPlanExpiryWarning(
  blockEnd: string,
  today: Date,
  warningDays: number
): string | null {
  const end = new Date(blockEnd)
  const days = daysBetween(today, end)
  if (days >= 0 && days <= warningDays) {
    return `Fitness plan expires in ${days} day${days === 1 ? '' : 's'} — commit a new fitness-plan.yaml`
  }
  return null
}
