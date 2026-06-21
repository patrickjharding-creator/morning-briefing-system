import type { ParentingData, ParentingPeriod } from '@morning-briefing/shared'
import { isSchoolHoliday, buildSchoolHolidayFlag, isLastDropoffOfWeek } from './smart-dates'

interface Schedule {
  parties: Record<string, { display_name: string; role?: string; arrives?: string; duties?: string[] }>
  periods: Record<string, { time_start: string; time_end: string; duties: string[] }>
  weekly_pattern: Record<string, Record<string, string>>
  exceptions: Array<{ date: string; overrides: Record<string, string>; note?: string }>
  school_holidays: Array<{ start: string; end: string; note: string }>
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']

export function buildParentingData(schedule: Schedule, today: Date): ParentingData {
  const todayName = DAYS[today.getDay()]
  const todayStr = today.toISOString().slice(0, 10)
  const isWeekday = WEEKDAYS.includes(todayName)

  // Apply weekly pattern then overlay exceptions
  const pattern = { ...schedule.weekly_pattern[todayName] }
  const exception = schedule.exceptions.find(e => e.date === todayStr)
  if (exception) {
    Object.assign(pattern, exception.overrides)
  }

  const schoolHoliday = isSchoolHoliday(schedule.school_holidays, today)
  const schoolHolidayFlag = buildSchoolHolidayFlag(schedule.school_holidays, today)

  // Determine if today is a school day (weekday, not holiday)
  const isSchoolDay = isWeekday && !schoolHoliday

  // Find periods where Pat is responsible
  const patPeriods: ParentingPeriod[] = []

  for (const [periodName, assignee] of Object.entries(pattern)) {
    if (assignee !== 'pat') continue

    const periodDef = schedule.periods[periodName]
    if (!periodDef) continue

    patPeriods.push({
      period: periodName as ParentingPeriod['period'],
      time_start: periodDef.time_start,
      time_end: periodDef.time_end,
      assignee: 'pat',
      duties: isSchoolDay
        ? periodDef.duties
        : periodDef.duties.filter(d => !['drop_off', 'pick_up', 'pack_lunch'].includes(d)),
    })
  }

  // Add Sophie periods as context (so the briefing can surface "Sophie covers X")
  for (const [periodName, assignee] of Object.entries(pattern)) {
    if (assignee !== 'sophie') continue

    const periodDef = schedule.periods[periodName]
    const sophieParty = schedule.parties['sophie']
    if (!periodDef || !sophieParty) continue

    patPeriods.push({
      period: periodName as ParentingPeriod['period'],
      time_start: sophieParty.arrives ?? periodDef.time_start,
      time_end: periodDef.time_end,
      assignee: 'sophie',
      duties: sophieParty.duties ?? periodDef.duties,
      sophie_note: `Sophie arrives ${sophieParty.arrives ?? periodDef.time_start}`,
    })
  }

  // Sort by period order
  const ORDER = ['morning', 'afternoon', 'evening', 'night']
  patPeriods.sort((a, b) => ORDER.indexOf(a.period) - ORDER.indexOf(b.period))

  // Last drop-off of week flag
  const patMorningDays = Object.entries(schedule.weekly_pattern)
    .filter(([, periods]) => periods['morning'] === 'pat')
    .map(([day]) => day)

  const lastDropoffFlag =
    isSchoolDay && isLastDropoffOfWeek(today, patMorningDays)
      ? 'Last school drop-off of the week'
      : null

  return {
    is_school_day: isSchoolDay,
    is_school_holiday: schoolHoliday,
    pat_periods: patPeriods,
    school_holiday_flag: schoolHolidayFlag,
    last_dropoff_flag: lastDropoffFlag,
  }
}
