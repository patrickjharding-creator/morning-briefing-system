import { createDAVClient } from 'tsdav'
import type { CalendarEvent, Birthday, RaceEvent } from '@morning-briefing/shared'
import { buildRaceCountdown } from './smart-dates'

interface Config {
  caldav_url: string
  apple_id: string
  password: string         // iCloud app-specific password from Secrets Manager
  birthdays_in_calendar: boolean
  race_detection: {
    calendar_name: string
    fallback_title_keywords: string[]
  }
  smart_dates: {
    race_warning_weeks: number[]
  }
}

function parseISOorDate(str: string): Date {
  return new Date(str)
}

function isToday(date: Date, today: Date): boolean {
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  )
}

function isThisWeek(date: Date, today: Date): boolean {
  const weekFromNow = new Date(today)
  weekFromNow.setDate(today.getDate() + 7)
  return date >= today && date <= weekFromNow
}

function isBirthdayCalendar(calendarName: string): boolean {
  return calendarName.toLowerCase().includes('birthday') ||
    calendarName.toLowerCase().includes('birthdays')
}

function isRaceCalendar(calendarName: string, racesCalendarName: string): boolean {
  return calendarName.toLowerCase() === racesCalendarName.toLowerCase()
}

function matchesRaceKeyword(title: string, keywords: string[]): boolean {
  const lower = title.toLowerCase()
  return keywords.some(k => lower.includes(k.toLowerCase()))
}

export async function fetchCalendarData(
  config: Config,
  today: Date
): Promise<{
  appointments: CalendarEvent[]
  birthdays: Birthday[]
  races: RaceEvent[]
}> {
  const client = await createDAVClient({
    serverUrl: config.caldav_url,
    credentials: {
      username: config.apple_id,
      password: config.password,
    },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  })

  const calendars = await client.fetchCalendars()

  const startOfToday = new Date(today)
  startOfToday.setHours(0, 0, 0, 0)

  const endOfToday = new Date(today)
  endOfToday.setHours(23, 59, 59, 999)

  // Fetch a 6-month window for races; today only for appointments
  const raceWindowEnd = new Date(today)
  raceWindowEnd.setMonth(today.getMonth() + 6)

  const appointments: CalendarEvent[] = []
  const birthdays: Birthday[] = []
  const races: RaceEvent[] = []

  for (const calendar of calendars) {
    const calName = (calendar.displayName as string | undefined) ?? ''
    const isRaceCal = isRaceCalendar(calName, config.race_detection.calendar_name)
    const isBirthdayCal = config.birthdays_in_calendar && isBirthdayCalendar(calName)

    const timeRange = isRaceCal
      ? { timeRange: { start: today.toISOString(), end: raceWindowEnd.toISOString() } }
      : { timeRange: { start: startOfToday.toISOString(), end: endOfToday.toISOString() } }

    const calObjects = await client.fetchCalendarObjects({
      calendar,
      timeRange: isRaceCal
        ? { start: today.toISOString(), end: raceWindowEnd.toISOString() }
        : { start: startOfToday.toISOString(), end: endOfToday.toISOString() },
    })

    for (const obj of calObjects) {
      if (!obj.data) continue

      const parsed = parseVCalendar(obj.data)
      if (!parsed) continue

      const { title, start, end, allDay, location, notes } = parsed

      const event: CalendarEvent = {
        id: obj.url,
        title,
        start: start.toISOString(),
        end: end.toISOString(),
        all_day: allDay,
        calendar: calName,
        location,
        notes,
      }

      if (isRaceCal || matchesRaceKeyword(title, config.race_detection.fallback_title_keywords)) {
        const countdown = buildRaceCountdown(
          start.toISOString().slice(0, 10),
          title,
          config.smart_dates.race_warning_weeks,
          today
        )
        if (countdown) races.push(countdown)
        continue
      }

      if (isBirthdayCal) {
        const dayNum = Math.round((start.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
        if (dayNum >= 0 && dayNum <= 7) {
          birthdays.push({
            name: title.replace(/[''']s Birthday$/u, '').replace(/ Birthday$/, '').trim(),
            date: start.toISOString().slice(0, 10),
            days_away: dayNum,
          })
        }
        continue
      }

      if (isToday(start, today)) {
        appointments.push(event)
      }
    }
  }

  appointments.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
  birthdays.sort((a, b) => a.days_away - b.days_away)
  races.sort((a, b) => a.days_away - b.days_away)

  return { appointments, birthdays, races }
}

// ─── Minimal iCalendar (VEVENT) parser ───────────────────────────────────────
// tsdav returns raw iCal strings; we extract what we need without a heavy dep.

interface ParsedEvent {
  title: string
  start: Date
  end: Date
  allDay: boolean
  location?: string
  notes?: string
}

function parseVCalendar(ical: string): ParsedEvent | null {
  const lines = ical.replace(/\r\n /g, '').replace(/\r\n/g, '\n').split('\n')

  let inEvent = false
  const props: Record<string, string> = {}

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { inEvent = true; continue }
    if (line === 'END:VEVENT') break
    if (!inEvent) continue

    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue

    const key = line.slice(0, colonIdx).split(';')[0].toUpperCase()
    const value = line.slice(colonIdx + 1)
    props[key] = value
  }

  if (!props['SUMMARY']) return null

  const allDay = !!(props['DTSTART'] && !props['DTSTART'].includes('T'))
  const start = parseICalDate(props['DTSTART'] ?? '')
  const end = parseICalDate(props['DTEND'] ?? props['DTSTART'] ?? '')

  if (!start) return null

  return {
    title: props['SUMMARY'].replace(/\\n/g, ' ').replace(/\\,/g, ','),
    start,
    end: end ?? start,
    allDay,
    location: props['LOCATION']?.replace(/\\n/g, ' '),
    notes: props['DESCRIPTION']?.replace(/\\n/g, '\n'),
  }
}

function parseICalDate(str: string): Date | null {
  if (!str) return null
  // DATE-TIME: 20260621T090000Z or 20260621T090000
  // DATE: 20260621
  const clean = str.replace('Z', '').replace('z', '')
  if (clean.includes('T')) {
    const [datePart, timePart] = clean.split('T')
    const y = parseInt(datePart.slice(0, 4))
    const mo = parseInt(datePart.slice(4, 6)) - 1
    const d = parseInt(datePart.slice(6, 8))
    const h = parseInt(timePart.slice(0, 2))
    const m = parseInt(timePart.slice(2, 4))
    const s = parseInt(timePart.slice(4, 6))
    return str.endsWith('Z') ? new Date(Date.UTC(y, mo, d, h, m, s)) : new Date(y, mo, d, h, m, s)
  } else {
    const y = parseInt(clean.slice(0, 4))
    const mo = parseInt(clean.slice(4, 6)) - 1
    const d = parseInt(clean.slice(6, 8))
    return new Date(y, mo, d)
  }
}
