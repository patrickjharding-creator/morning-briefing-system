import yaml from 'js-yaml'
import type { PlannedSession, FitnessData } from '@morning-briefing/shared'
import { buildPlanExpiryWarning } from './smart-dates'

interface FitnessPlan {
  current_block: {
    name: string
    phase: string
    start: string
    end: string
    goal_race?: {
      name: string
      date: string
      priority: string
      discipline: string
      goal: string
    }
  }
  weekly_template: Record<string, string>
  weeks: Array<{
    week: number
    label: string
    start: string
    sessions: Record<string, SessionDef | 'rest'>
  }>
}

interface SessionDef {
  discipline: string
  type: string
  duration_min?: number
  distance_km?: number
  distance_m?: number
  rpe?: number
  notes: string
  name?: string
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export function parseFitnessPlan(
  yamlContent: string,
  today: Date,
  warningDays: number
): { planned_session: PlannedSession | null; plan_expiry_warning: string | null; weekly_planned_count: number } {
  const plan = yaml.load(yamlContent) as FitnessPlan

  const todayName = DAYS[today.getDay()]
  const todayStr = today.toLocaleDateString('en-CA')

  // Find the week that contains today
  let plannedSession: PlannedSession | null = null
  let weeklyPlannedCount = 0

  for (const week of plan.weeks) {
    const weekStart = new Date(week.start)
    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekStart.getDate() + 6)

    const todayDate = new Date(todayStr)

    if (todayDate >= weekStart && todayDate <= weekEnd) {
      const sessionDef = week.sessions[todayName]

      if (sessionDef && sessionDef !== 'rest' && typeof sessionDef === 'object' && sessionDef.discipline !== 'rest') {
        plannedSession = {
          discipline: sessionDef.discipline,
          type: sessionDef.type,
          duration_min: sessionDef.duration_min,
          distance_km: sessionDef.distance_km,
          distance_m: sessionDef.distance_m,
          rpe: sessionDef.rpe,
          notes: sessionDef.notes,
        }
      }

      // Count non-rest sessions in this week for the planned tally
      weeklyPlannedCount = Object.values(week.sessions).filter(
        s => s !== 'rest' && typeof s === 'object' && (s as SessionDef).discipline !== 'rest'
      ).length
    }
  }

  const planExpiryWarning = buildPlanExpiryWarning(plan.current_block.end, today, warningDays)

  return { planned_session: plannedSession, plan_expiry_warning: planExpiryWarning, weekly_planned_count: weeklyPlannedCount }
}
