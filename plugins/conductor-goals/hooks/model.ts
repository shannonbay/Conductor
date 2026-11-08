/**
 * Pure functions: the web app's overview turned into cards, goal-name
 * matching, alert diffing and the small formatters the pane uses.
 */
import type { GoalCard, Item, Schedule, Snapshot } from '../types'

/** One goal as GET /api/goals/overview returns it (the fields used here). */
export type OverviewGoal = {
  id: string
  name: string
  objective: string
  status: string
  next_run_at: string | null
  schedule?: Schedule | null
  open_run: { id: string; status: string } | null
  activity?: { state: 'running' | 'queued' | 'paused' | 'idle'; text: string; at: string | null }
  runs: { id: string; status: string; trigger: string; summary: string | null; started_at: string; ended_at: string | null }[]
  needs_you: OverviewItem[]
  open_items: OverviewItem[]
  open_item_count: number
  health: { passed: boolean; value: number | null }[]
  memory: { id: string; kind: string; text: string; pinned: boolean }[]
  suggestions: { category: string; approved_in_a_row: number }[]
}

type OverviewItem = { id: string; goal: string; action?: { category?: string; summary?: string } | null }

export const EMPTY: Snapshot = { reachable: false, error: null, goals: [], fetchedAt: 0, etag: null }

function toItem(t: OverviewItem): Item {
  return { id: t.id, title: t.goal, category: t.action?.category ?? null, summary: t.action?.summary ?? null }
}

export function toCard(g: OverviewGoal): GoalCard {
  const latest = g.health[0]
  return {
    id: g.id,
    name: g.name,
    objective: g.objective,
    status: g.status,
    // An older web app sends no activity: say nothing rather than guess.
    activity: g.activity ?? { state: g.status === 'paused' ? 'paused' : 'idle', text: '', at: null },
    needsYou: g.needs_you.map(toItem),
    openItems: g.open_items.map(toItem),
    openItemCount: g.open_item_count,
    openRun: g.open_run ? { id: g.open_run.id, status: g.open_run.status } : null,
    runs: g.runs.map((r) => ({ id: r.id, status: r.status, trigger: r.trigger, summary: r.summary, startedAt: r.started_at, endedAt: r.ended_at })),
    nextRunAt: g.next_run_at,
    schedule: g.schedule ?? null,
    health: latest ? { passed: latest.passed, value: latest.value } : null,
    trend: g.health.map((h) => h.value).filter((v): v is number => v !== null).reverse(),
    memory: g.memory.map((m) => ({ id: m.id, kind: m.kind, text: m.text, pinned: m.pinned })),
    suggestions: g.suggestions.map((s) => ({ category: s.category, approvedInARow: s.approved_in_a_row })),
  }
}

/** The last finished run (not queued or running). */
export function lastRun(g: GoalCard) {
  return g.runs.find((r) => r.status !== 'queued' && r.status !== 'running') ?? null
}

export function isFailed(status: string): boolean {
  return status === 'failed' || status === 'timed_out'
}

/**
 * Finds a goal by name: exact, then prefix, then substring, ignoring case.
 * More than one match at the first level that matches is ambiguous.
 */
export function findGoal(goals: GoalCard[], query: string): { goal: GoalCard } | { matches: GoalCard[] } {
  const q = query.trim().toLowerCase()
  if (!q) return { matches: [] }
  const byId = goals.find((g) => g.id === query.trim())
  if (byId) return { goal: byId }
  for (const test of [(n: string) => n === q, (n: string) => n.startsWith(q), (n: string) => n.includes(q)]) {
    const hits = goals.filter((g) => test(g.name.toLowerCase()))
    if (hits.length === 1) return { goal: hits[0]! }
    if (hits.length > 1) return { matches: hits }
  }
  return { matches: [] }
}

/** A message for a goal name that matched none or several goals. */
export function noMatch(goals: GoalCard[], query: string, matches: GoalCard[]): string {
  if (matches.length > 1) return `"${query.trim()}" matches ${matches.map((g) => g.name).join(', ')}. Be more specific.`
  if (goals.length === 0) return 'There are no goals yet.'
  return `No goal matches "${query.trim()}". Goals: ${goals.map((g) => g.name).join(', ')}.`
}

/** What has been announced: proposals by "<goal>/<item>", failed runs by id. */
export type Seen = { items: string[]; failures: string[] }

export type Alerts = {
  proposals: { goal: GoalCard; item: Item }[]
  failures: { goal: GoalCard; run: { id: string; summary: string | null } }[]
  seen: Seen
}

/** New proposals and failed runs since `seen`; none on the first read (`seen` null). */
export function diffAlerts(seen: Seen | null, goals: GoalCard[]): Alerts {
  const items = goals.flatMap((goal) => goal.needsYou.map((item) => ({ key: `${goal.id}/${item.id}`, goal, item })))
  const failed = goals.flatMap((goal) => {
    const run = lastRun(goal)
    return run && isFailed(run.status) ? [{ goal, run }] : []
  })
  const next: Seen = { items: items.map((x) => x.key), failures: failed.map((f) => f.run.id) }
  if (!seen) return { proposals: [], failures: [], seen: next }
  return {
    proposals: items.filter((x) => !seen.items.includes(x.key)).map(({ goal, item }) => ({ goal, item })),
    failures: failed.filter((f) => !seen.failures.includes(f.run.id)),
    seen: next,
  }
}

/** The status line text; undefined clears it (no goals). */
export function statusText(s: Snapshot): string | undefined {
  if (!s.reachable) return 'Conductor: offline'
  if (s.goals.length === 0) return undefined
  const waiting = s.goals.reduce((n, g) => n + g.needsYou.length, 0)
  const running = s.goals.filter((g) => g.openRun?.status === 'running').map((g) => g.name)
  const parts = [
    waiting > 0 ? `${waiting} need${waiting === 1 ? 's' : ''} you` : null,
    running.length > 0 ? `${running.join(', ')} running` : null,
  ].filter(Boolean)
  return `Conductor: ${parts.length > 0 ? parts.join(' · ') : 'all clear'}`
}

/** A compact plain-text summary of every goal, for the model. */
export function summarize(goals: GoalCard[], now: number): string {
  if (goals.length === 0) return 'No Conductor goals exist yet.'
  return goals.map((g) => {
    const run = lastRun(g)
    const lines = [
      `## ${g.name} (id ${g.id}, ${g.status})`,
      `Objective: ${g.objective}`,
      g.activity.text ? `Now: ${g.activity.text}` : null,
      g.openRun ? `Run ${g.openRun.status} now.` : `Last run: ${run ? `${run.status} ${ago(run.endedAt ?? run.startedAt, now)}${run.summary ? ` — ${run.summary}` : ''}` : 'none'}.`,
      g.health ? `Health: ${g.health.passed ? 'passing' : 'failing'}${g.health.value !== null ? ` (${g.health.value})` : ''}.` : null,
      `Open items: ${g.openItemCount}.`,
      g.needsYou.length === 0
        ? 'Nothing waiting for approval.'
        : `Waiting for approval:\n${g.needsYou.map((i) => `- item ${i.id}: ${i.title}${i.category ? ` [${i.category}]` : ''}${i.summary ? ` — ${i.summary}` : ''}`).join('\n')}`,
    ]
    return lines.filter(Boolean).join('\n')
  }).join('\n\n')
}

/** One goal in detail, for the model. */
export function describe(g: GoalCard, now: number): string {
  return [
    summarize([g], now),
    g.openItems.length > 0
      ? `Open items${g.openItemCount > g.openItems.length ? ` (first ${g.openItems.length} of ${g.openItemCount})` : ''}:\n${g.openItems.map((i) => `- item ${i.id}: ${i.title}`).join('\n')}`
      : null,
    g.runs.length > 0
      ? `Recent runs:\n${g.runs.map((r) => `- ${r.status} (${r.trigger}) ${ago(r.endedAt ?? r.startedAt, now)}${r.summary ? ` — ${r.summary}` : ''}`).join('\n')}`
      : null,
    g.memory.length > 0 ? `Memory:\n${g.memory.map((m) => `- [${m.kind}] ${m.text}`).join('\n')}` : null,
  ].filter(Boolean).join('\n\n')
}

/** `text` cut to `columns` characters, ending in … when cut. */
export function clip(text: string, columns: number): string {
  const chars = [...text]
  if (chars.length <= columns) return text
  return columns <= 1 ? '…'.slice(0, columns) : `${chars.slice(0, columns - 1).join('').trimEnd()}…`
}

const BARS = '▁▂▃▄▅▆▇█'
export function spark(values: number[]): string {
  if (values.length < 2) return ''
  const shown = values.slice(-12)
  const min = Math.min(...shown)
  const span = Math.max(...shown) - min || 1
  return shown.map((v) => BARS[Math.round(((v - min) / span) * (BARS.length - 1))]).join('')
}

export function ago(iso: string | null, now: number): string {
  if (!iso) return '—'
  const s = Math.round((now - Date.parse(iso)) / 1000)
  if (s < 0) {
    const m = Math.round(-s / 60)
    return m < 1 ? 'in <1m' : m < 60 ? `in ${m}m` : m < 1440 ? `in ${Math.round(m / 60)}h` : `in ${Math.round(m / 1440)}d`
  }
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// ── Schedules ─────────────────────────────────────────────────────────────────

export const SCHEDULE_USAGE = 'every 30m | every 6h | every 1d [between 08:00-20:00] | cron <5 fields> | off'

const UNIT_MINUTES: Record<string, number> = { m: 1, min: 1, mins: 1, minute: 1, minutes: 1, h: 60, hr: 60, hrs: 60, hour: 60, hours: 60, d: 1440, day: 1440, days: 1440 }

/** "every 6h", "every 30m between 08:00-20:00", "cron 0 9 * * 1-5" or "off": a schedule, null (on demand), or why not. */
export function parseSchedule(text: string): { schedule: Schedule | null } | { error: string } {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ')
  if (t === 'off' || t === 'manual' || t === 'none') return { schedule: null }
  if (t.startsWith('cron ')) {
    const expr = text.trim().replace(/^cron\s+/i, '').trim()
    return expr.split(/\s+/).length === 5
      ? { schedule: { kind: 'cron', expr } }
      : { error: 'A cron expression has 5 fields (minute hour day month weekday), e.g. "cron 0 9 * * 1-5".' }
  }
  const m = /^every (\d+) ?([a-z]+)(?: between (\d{1,2}):(\d{2}) ?- ?(\d{1,2}):(\d{2}))?$/.exec(t)
  if (!m) return { error: `Say when it runs: ${SCHEDULE_USAGE}.` }
  const unit = UNIT_MINUTES[m[2]!]
  if (!unit) return { error: 'Use m, h or d for the interval, e.g. "every 6h".' }
  const minutes = Number(m[1]) * unit
  if (minutes < 5) return { error: 'Goals run at most every 5 minutes.' }
  const schedule: Schedule = { kind: 'interval', minutes }
  if (m[3] !== undefined) {
    const hours = [Number(m[3]), Number(m[5])]
    const mins = [Number(m[4]), Number(m[6])]
    if (hours.some((h) => h > 23) || mins.some((x) => x > 59)) return { error: 'Use 24-hour times, e.g. "between 08:00-20:00".' }
    const pad = (n: number) => String(n).padStart(2, '0')
    schedule.active_hours = `${pad(hours[0]!)}:${pad(mins[0]!)}-${pad(hours[1]!)}:${pad(mins[1]!)}`
  }
  return { schedule }
}

/** "every 6h", "every 30m, 08:00–20:00", "cron 0 9 * * 1-5", or "on demand". */
export function scheduleLabel(s: Schedule | null): string {
  if (!s) return 'on demand'
  if (s.kind === 'cron') return `cron ${s.expr}`
  const every = s.minutes % 1440 === 0 ? `${s.minutes / 1440}d` : s.minutes % 60 === 0 ? `${s.minutes / 60}h` : `${s.minutes}m`
  return `every ${every}${s.active_hours ? `, ${s.active_hours.replace('-', '–')}` : ''}`
}

/** " · next in 25m", " · next run due now", " · no schedule (/goal-schedule)", or "" while running or paused. */
export function nextRunText(g: Pick<GoalCard, 'status' | 'openRun' | 'nextRunAt' | 'schedule'>, now: number): string {
  if (g.status !== 'active' || g.openRun) return ''
  if (g.nextRunAt) return Date.parse(g.nextRunAt) <= now ? ' · next run due now' : ` · next ${ago(g.nextRunAt, now)}`
  return g.schedule === null ? ' · no schedule (/goal-schedule)' : ''
}
