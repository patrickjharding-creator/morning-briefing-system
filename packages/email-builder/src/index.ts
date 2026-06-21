import type { BriefingData, ParentingPeriod } from '@morning-briefing/shared'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmt12h(iso: string): string {
  const d = new Date(iso)
  const h = d.getHours()
  const m = d.getMinutes()
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 || 12
  return m === 0 ? `${h12}${ampm}` : `${h12}:${m.toString().padStart(2, '0')}${ampm}`
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

// ─── CSS ─────────────────────────────────────────────────────────────────────

const CSS = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; margin: 0; padding: 20px; }
  .container { max-width: 640px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; }
  .header { background: #1a1a1a; color: #ffffff; padding: 24px 28px 20px; }
  .header h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.3px; }
  .header .date { margin: 4px 0 0; font-size: 13px; color: #999; }
  .opening { background: #f9f9f9; border-left: 3px solid #1a1a1a; padding: 14px 28px; font-size: 15px; color: #333; font-style: italic; }
  .section { padding: 20px 28px; border-bottom: 1px solid #f0f0f0; }
  .section:last-child { border-bottom: none; }
  .section-title { font-size: 11px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #999; margin: 0 0 12px; }
  .item { margin-bottom: 8px; font-size: 14px; color: #333; line-height: 1.5; }
  .item:last-child { margin-bottom: 0; }
  .flag { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 4px; margin-bottom: 10px; }
  .flag-race { background: #fff3cd; color: #856404; }
  .flag-holiday { background: #d1ecf1; color: #0c5460; }
  .flag-birthday { background: #f8d7da; color: #721c24; }
  .flag-warning { background: #fff3cd; color: #856404; }
  .time { font-size: 12px; color: #999; margin-right: 6px; }
  .duties { font-size: 12px; color: #777; margin-top: 2px; }
  .sophie { color: #6c757d; font-style: italic; }
  .metric-row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 10px; }
  .metric { flex: 1; min-width: 80px; background: #f9f9f9; border-radius: 6px; padding: 10px 12px; }
  .metric-label { font-size: 11px; color: #999; margin-bottom: 2px; }
  .metric-value { font-size: 18px; font-weight: 600; color: #1a1a1a; }
  .metric-sub { font-size: 11px; color: #999; margin-top: 2px; }
  .session { background: #f9f9f9; border-radius: 6px; padding: 12px 14px; margin-bottom: 10px; }
  .session-type { font-size: 11px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; color: #666; margin-bottom: 4px; }
  .session-notes { font-size: 13px; color: #444; }
  .news-item { margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid #f5f5f5; }
  .news-item:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
  .news-topic { font-size: 10px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #999; margin-right: 6px; }
  .philosopher { text-align: center; padding: 24px 28px; background: #f9f9f9; }
  .philosopher blockquote { font-size: 16px; font-style: italic; color: #333; margin: 0 0 8px; line-height: 1.6; }
  .philosopher cite { font-size: 12px; color: #999; }
  .draft { background: #f9f9f9; border: 1px solid #e0e0e0; border-radius: 6px; padding: 14px; margin-bottom: 12px; }
  .draft-meta { font-size: 12px; color: #999; margin-bottom: 8px; }
  .draft-body { font-size: 13px; color: #333; white-space: pre-wrap; margin-bottom: 12px; }
  .draft-actions { display: flex; gap: 8px; }
  .btn { display: inline-block; padding: 6px 16px; border-radius: 4px; font-size: 13px; font-weight: 600; text-decoration: none; }
  .btn-approve { background: #1a1a1a; color: #ffffff; }
  .btn-reject { background: #f5f5f5; color: #666; border: 1px solid #ddd; }
  .goal-bar { margin-bottom: 8px; }
  .goal-label { font-size: 12px; color: #666; margin-bottom: 4px; }
  .goal-track { background: #f0f0f0; border-radius: 4px; height: 6px; }
  .goal-fill { height: 6px; border-radius: 4px; background: #1a1a1a; }
  .empty { font-size: 13px; color: #bbb; font-style: italic; }
`

// ─── Section renderers ────────────────────────────────────────────────────────

function renderWeather(data: BriefingData['weather']): string {
  if (!data.periods.length) return '<p class="empty">Weather unavailable</p>'

  const periods = data.periods.map(p => `
    <div class="item">
      <strong>${esc(p.label)}</strong> — ${esc(p.condition)},
      ${p.temp_min_c}–${p.temp_max_c}°C
      ${p.rain_mm > 0 ? `, ${p.rain_mm}mm rain` : ''}
      ${p.wind_kmh > 20 ? `, ${p.wind_kmh} km/h wind` : ''}
    </div>
  `).join('')

  const advisory = data.advisory
    ? `<div class="item" style="color:#856404;background:#fff3cd;padding:8px 10px;border-radius:4px;margin-top:8px;">⚠️ ${esc(data.advisory)}</div>`
    : ''

  return periods + advisory
}

function renderAppointments(data: BriefingData): string {
  const flags: string[] = []

  if (data.parenting.school_holiday_flag) {
    flags.push(`<span class="flag flag-holiday">${esc(data.parenting.school_holiday_flag)}</span>`)
  }
  if (data.parenting.last_dropoff_flag) {
    flags.push(`<span class="flag flag-holiday">${esc(data.parenting.last_dropoff_flag)}</span>`)
  }
  data.birthdays.filter(b => b.days_away > 0).forEach(b => {
    flags.push(`<span class="flag flag-birthday">🎂 ${esc(b.name)}'s birthday in ${b.days_away} day${b.days_away === 1 ? '' : 's'}</span>`)
  })

  const flagHtml = flags.length ? `<div style="margin-bottom:10px;">${flags.join(' ')}</div>` : ''

  const events = data.appointments.map(e => `
    <div class="item">
      ${e.all_day ? '' : `<span class="time">${fmt12h(e.start)}</span>`}
      <strong>${esc(e.title)}</strong>
      ${e.location ? `<span style="color:#999"> · ${esc(e.location)}</span>` : ''}
    </div>
  `).join('')

  const parenting = renderParenting(data.parenting.pat_periods, data.parenting.is_school_day)

  if (!events && !parenting && !flagHtml) {
    return flagHtml + '<p class="empty">Nothing scheduled</p>'
  }

  return flagHtml + events + (parenting ? `<div style="margin-top:12px;">${parenting}</div>` : '')
}

function renderParenting(periods: ParentingPeriod[], isSchoolDay: boolean): string {
  if (!periods.length) return ''

  const rows = periods.map(p => {
    if (p.assignee === 'sophie') {
      return `<div class="item sophie">
        <span class="time">${p.time_start}</span>
        Sophie — ${p.duties.map(d => d.replace(/_/g, ' ')).join(', ')}
      </div>`
    }
    const duties = p.duties.map(d => d.replace(/_/g, ' ')).join(', ')
    return `<div class="item">
      <span class="time">${p.time_start}–${p.time_end}</span>
      <strong>${capitalize(p.period)}</strong>
      <div class="duties">${esc(duties)}</div>
    </div>`
  }).join('')

  return `<div style="margin-top:4px;padding-top:10px;border-top:1px solid #f0f0f0;">
    <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#bbb;margin-bottom:8px;">Kids</div>
    ${rows}
  </div>`
}

function renderTodo(data: BriefingData): string {
  const parts: string[] = []

  if (data.reminders.length) {
    const items = data.reminders.map(r =>
      `<div class="item">${r.overdue ? '⚠️ ' : ''}${esc(r.title)}</div>`
    ).join('')
    parts.push(`<div style="margin-bottom:14px;"><div class="section-title" style="margin-bottom:6px;">Due today</div>${items}</div>`)
  }

  if (data.suggested_actions.length) {
    const items = data.suggested_actions.map(a => `<div class="item">· ${esc(a)}</div>`).join('')
    parts.push(`<div style="margin-bottom:14px;"><div class="section-title" style="margin-bottom:6px;">Suggested actions</div>${items}</div>`)
  }

  if (data.drafts.length) {
    const draftHtml = data.drafts.map(d => `
      <div class="draft">
        <div class="draft-meta">To: ${esc(d.to)} · Re: ${esc(d.subject)}</div>
        <div class="draft-body">${esc(d.body)}</div>
        <div class="draft-actions">
          <a class="btn btn-approve" href="{{APPROVAL_URL}}/approve/${esc(d.id)}">Approve &amp; Send</a>
          <a class="btn btn-reject" href="{{APPROVAL_URL}}/reject/${esc(d.id)}">Reject</a>
        </div>
      </div>
    `).join('')
    parts.push(`<div><div class="section-title" style="margin-bottom:8px;">Correspondence to issue</div>${draftHtml}</div>`)
  }

  return parts.length ? parts.join('') : '<p class="empty">Nothing to action</p>'
}

function renderFitness(data: BriefingData['fitness']): string {
  const { recovery, planned_session, last_activity, weekly_progress, goals } = data
  const parts: string[] = []

  if (data.race_countdown) {
    parts.push(`<div class="flag flag-race" style="margin-bottom:12px;">🏁 ${esc(data.race_countdown)}</div>`)
  }
  if (data.plan_expiry_warning) {
    parts.push(`<div class="flag flag-warning" style="margin-bottom:12px;">⚠️ ${esc(data.plan_expiry_warning)}</div>`)
  }

  // Recovery metrics
  parts.push(`<div class="metric-row">
    <div class="metric">
      <div class="metric-label">HRV</div>
      <div class="metric-value">${recovery.hrv_value ?? '—'}</div>
      <div class="metric-sub">${esc(recovery.hrv_status)}</div>
    </div>
    <div class="metric">
      <div class="metric-label">Sleep</div>
      <div class="metric-value">${recovery.sleep_duration_hr > 0 ? `${recovery.sleep_duration_hr}h` : '—'}</div>
      <div class="metric-sub">of ${goals.sleep_target_hr}h target</div>
    </div>
    <div class="metric">
      <div class="metric-label">Body Battery</div>
      <div class="metric-value">${recovery.body_battery ?? '—'}</div>
    </div>
    <div class="metric">
      <div class="metric-label">Resting HR</div>
      <div class="metric-value">${recovery.resting_hr ?? '—'}</div>
      <div class="metric-sub">bpm</div>
    </div>
  </div>`)

  // Today's session
  if (planned_session) {
    const detail = [
      planned_session.duration_min ? `${planned_session.duration_min} min` : null,
      planned_session.distance_km ? `${planned_session.distance_km} km` : null,
      planned_session.distance_m ? `${planned_session.distance_m} m` : null,
      planned_session.rpe ? `RPE ${planned_session.rpe}` : null,
    ].filter(Boolean).join(' · ')

    parts.push(`<div class="session">
      <div class="session-type">${esc(planned_session.discipline)} · ${esc(planned_session.type.replace(/_/g, ' '))}${detail ? ` · ${detail}` : ''}</div>
      <div class="session-notes">${esc(planned_session.notes)}</div>
    </div>`)
  } else {
    parts.push(`<div class="session"><div class="session-type">Rest day</div></div>`)
  }

  // Haiku commentary
  if (data.commentary) {
    parts.push(`<div class="item" style="color:#666;font-style:italic;margin-top:4px;">${esc(data.commentary)}</div>`)
  }

  // Last activity
  if (last_activity) {
    const detail = [
      `${last_activity.duration_min} min`,
      last_activity.distance_km ? `${last_activity.distance_km} km` : null,
      last_activity.avg_hr ? `avg ${last_activity.avg_hr} bpm` : null,
    ].filter(Boolean).join(' · ')
    parts.push(`<div class="item" style="margin-top:12px;font-size:13px;color:#999;">Last: ${esc(last_activity.discipline)} ${esc(last_activity.date)} — ${detail}</div>`)
  }

  // Weekly progress
  parts.push(`<div style="margin-top:12px;">
    <div class="goal-label">This week: ${weekly_progress.completed} of ${weekly_progress.planned} sessions</div>
    <div class="goal-track"><div class="goal-fill" style="width:${Math.min(100, weekly_progress.planned ? Math.round(weekly_progress.completed / weekly_progress.planned * 100) : 0)}%"></div></div>
  </div>`)

  // Goals
  if (goals.weight_current_kg) {
    const pct = Math.min(100, Math.round((1 - (goals.weight_current_kg - goals.weight_target_kg) / 10) * 100))
    parts.push(`<div style="margin-top:10px;">
      <div class="goal-label">Weight: ${goals.weight_current_kg} kg → ${goals.weight_target_kg} kg target</div>
      <div class="goal-track"><div class="goal-fill" style="width:${pct}%"></div></div>
    </div>`)
  }

  return parts.join('')
}

function renderNews(bullets: BriefingData['news']): string {
  if (!bullets.length) return '<p class="empty">News unavailable</p>'
  return bullets.map(b => `
    <div class="news-item">
      <span class="news-topic">${esc(b.topic)}</span>${esc(b.headline)}
    </div>
  `).join('')
}

function renderPhilosopher(data: BriefingData['philosopher']): string {
  if (!data) return '<p class="empty">—</p>'
  return `
    <blockquote>"${esc(data.quote)}"</blockquote>
    <cite>— ${esc(data.author)}</cite>
  `
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

// ─── Main renderer ────────────────────────────────────────────────────────────

export function buildEmail(data: BriefingData, approvalUrl: string): string {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Morning Briefing — ${esc(data.date)}</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="container">

    <div class="header">
      <h1>Morning Briefing</h1>
      <p class="date">${formatDate(data.date)}</p>
    </div>

    ${data.opening_line ? `<div class="opening">${esc(data.opening_line)}</div>` : ''}

    <div class="section">
      <p class="section-title">Weather</p>
      ${renderWeather(data.weather)}
    </div>

    <div class="section">
      <p class="section-title">Appointments &amp; Commitments</p>
      ${renderAppointments(data)}
    </div>

    <div class="section">
      <p class="section-title">To-Do</p>
      ${renderTodo(data)}
    </div>

    <div class="section">
      <p class="section-title">Fitness</p>
      ${renderFitness(data.fitness)}
    </div>

    <div class="section">
      <p class="section-title">Daily 5</p>
      ${renderNews(data.news)}
    </div>

    <div class="philosopher">
      <p class="section-title">Today's Philosopher</p>
      ${renderPhilosopher(data.philosopher)}
    </div>

  </div>
</body>
</html>`

  return html.replace(/\{\{APPROVAL_URL\}\}/g, approvalUrl)
}
