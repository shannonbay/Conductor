/**
 * Pure functions: the web app's overview turned into cards, goal-name
 * matching, alert diffing and the small formatters the pane uses.
 */
import type { GoalCard, Item, Schedule, Snapshot, Update } from '../types'

/** One goal as GET /api/goals/overview returns it (the fields used here). */
export type OverviewGoal = {
  id: string
  name: string
  objective: string
  status: string
  next_run_at: string | null
  schedule?: Schedule | null
  one_off?: boolean
  /** Missing from a server older than per-goal models. */
  model?: string | null
  instructions?: string
  autonomy?: Record<string, string>
  tool_map?: Record<string, string>
  open_run: { id: string; status: string } | null
  /** `waiting`: a run's tool call waits for the person's permission answer (from the guard plugin's reports). */
  activity?: { state: 'running' | 'queued' | 'paused' | 'idle'; text: string; at: string | null; waiting?: { tool: string; since: string } }
  runs: { id: string; status: string; trigger: string; summary: string | null; started_at: string; ended_at: string | null; agent_id?: string | null; tokens?: number; model?: string | null; untrusted?: string | null }[]
  /** False for a card: runs, memory, open items, instructions and tool rules left out. */
  detail?: boolean
  needs_you_count?: number
  needs_you: OverviewItem[]
  open_items: OverviewItem[]
  open_item_count: number
  health: { passed: boolean; value: number | null }[]
  memory: { id: string; kind: string; text: string; pinned: boolean }[]
  suggestions: { category: string; approved_in_a_row: number }[]
  /** Missing from a server older than watches. */
  watches?: { name: string; every_minutes: number; runs: string; last_fired_at: string | null; failing: boolean; error: string | null }[]
  watch_count?: number
  watch_failing?: boolean
}

type OverviewItem = { id: string; goal: string; action?: { category?: string; summary?: string } | null; asks_person?: boolean }

export const EMPTY: Snapshot = { reachable: false, error: null, goals: [], fetchedAt: 0, etag: null, hold: null }

function toItem(t: OverviewItem): Item {
  return { id: t.id, title: t.goal, category: t.action?.category ?? null, summary: t.action?.summary ?? null, ...(t.asks_person && { asksPerson: true }) }
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
    detail: g.detail !== false,
    needsYouCount: g.needs_you_count ?? g.needs_you.length,
    openItems: g.open_items.map(toItem),
    openItemCount: g.open_item_count,
    openRun: g.open_run ? { id: g.open_run.id, status: g.open_run.status } : null,
    runs: g.runs.map((r) => ({ id: r.id, status: r.status, trigger: r.trigger, summary: r.summary, startedAt: r.started_at, endedAt: r.ended_at, agentId: r.agent_id ?? null, tokens: r.tokens ?? 0, model: r.model ?? null, untrusted: r.untrusted ?? null })),
    nextRunAt: g.next_run_at,
    schedule: g.schedule ?? null,
    oneOff: g.one_off ?? false,
    model: g.model ?? null,
    instructions: g.instructions ?? '',
    autonomy: g.autonomy ?? {},
    toolMap: g.tool_map ?? {},
    health: latest ? { passed: latest.passed, value: latest.value } : null,
    trend: g.health.map((check) => check.value).filter((v): v is number => v !== null).reverse(),
    memory: g.memory.map((m) => ({ id: m.id, kind: m.kind, text: m.text, pinned: m.pinned })),
    suggestions: g.suggestions.map((s) => ({ category: s.category, approvedInARow: s.approved_in_a_row })),
    watches: (g.watches ?? []).map((w) => ({ name: w.name, everyMinutes: w.every_minutes, runs: w.runs, lastFiredAt: w.last_fired_at, failing: w.failing, error: w.error })),
    watchCount: g.watch_count ?? g.watches?.length ?? 0,
    watchFailing: g.watch_failing ?? (g.watches ?? []).some((w) => w.failing),
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
 * Where to answer a run's permission prompt. Claude Code asks only in the
 * session that runs the call, and nothing in the pane can answer it (a plugin
 * may not make permission decisions), so say which session that is: this one
 * (`mine`: this session started the run), the standing session (`standing`:
 * it holds the scheduler lease, so it started the run), or another window.
 * Cancel run, below on the card, is the one way to turn it down from here.
 */
export function permissionWhere(mine: boolean, standing: boolean): string {
  if (mine) return 'Answer the prompt in this window, or Cancel run.'
  if (standing) return 'Answer it in the "Quarterdeck goals" chat (Claude app or claude.ai/code), or Cancel run.'
  return 'Answer it in the window running this goal (or the Claude app), or Cancel run.'
}

/**
 * Nothing here needs the person: nothing waiting for them, no run going, the
 * last run didn't fail, the health check and the watches aren't failing and
 * there is no suggestion. The pane draws such a goal as one line until it is expanded.
 */
export function isQuiet(g: GoalCard): boolean {
  const run = lastRun(g)
  return g.needsYou.length === 0
    && g.needsYouCount === 0
    && !g.openRun
    && !(run && isFailed(run.status))
    && !(g.health && !g.health.passed)
    && !g.watchFailing
    && g.suggestions.length === 0
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
  if (!s.reachable) return 'Quarterdeck: offline'
  if (s.goals.length === 0) return undefined
  const waiting = s.goals.reduce((n, g) => n + g.needsYou.length, 0)
  const asking = s.goals.filter((g) => g.openRun?.status === 'running' && g.activity.waiting).map((g) => g.name)
  const running = s.goals.filter((g) => g.openRun?.status === 'running' && !g.activity.waiting).map((g) => g.name)
  const parts = [
    waiting > 0 ? `${waiting} need${waiting === 1 ? 's' : ''} you` : null,
    asking.length > 0 ? `${asking.join(', ')} waiting for your permission` : null,
    running.length > 0 ? `${running.join(', ')} running` : null,
  ].filter(Boolean)
  return `Quarterdeck: ${parts.length > 0 ? parts.join(' · ') : 'all clear'}`
}

/** A compact plain-text summary of every goal, for the model. */
export function summarize(goals: GoalCard[], now: number): string {
  if (goals.length === 0) return 'No Quarterdeck goals exist yet.'
  return goals.map((g) => {
    const run = lastRun(g)
    const lines = [
      `## ${g.name} (id ${g.id}, ${g.status === 'retired' ? 'done' : g.status}${g.oneOff ? ', one-off' : ''})`,
      `Objective: ${g.objective}`,
      g.activity.text ? `Now: ${g.activity.text}` : null,
      g.openRun ? `Run ${g.openRun.status} now.` : `Last run: ${run ? `${run.status} ${ago(run.endedAt ?? run.startedAt, now)}${runCost(run) ? ` (${runCost(run)})` : ''}${run.summary ? ` — ${run.summary}` : ''}` : 'none'}.`,
      g.health ? `Health: ${g.health.passed ? 'passing' : 'failing'}${g.health.value !== null ? ` (${g.health.value})` : ''}.` : null,
      `Open items: ${g.openItemCount}.`,
      g.needsYou.length === 0
        ? 'Nothing waiting for approval.'
        : `Waiting for you:\n${g.needsYou.map((i) => `- item ${i.id}: ${i.title}${i.asksPerson ? ' [a question for you: answer with answer_item, or approve_item when done]' : ''}${i.category ? ` [${i.category}]` : ''}${i.summary ? ` — ${i.summary}` : ''}`).join('\n')}`,
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
      ? `Recent runs:\n${g.runs.map((r) => `- ${r.status} (${r.trigger}) ${ago(r.endedAt ?? r.startedAt, now)}${r.untrusted ? ` [read outside content (${r.untrusted}): auto actions needed approval]` : ''}${r.summary ? ` — ${r.summary}` : ''}`).join('\n')}`
      : null,
    g.instructions.trim() ? `Instructions: ${g.instructions.trim()}` : null,
    `Schedule: ${g.oneOff ? 'one-off' : scheduleLabel(g.schedule)}`,
    `Model: ${goalModelLabel(g.model)}`,
    g.watches.length > 0
      ? `Watches (a run starts when one sees a new line):\n${g.watches.map((w) => `- ${w.name}: every ${w.everyMinutes} min, runs ${w.runs}${w.failing ? ` [failing: ${w.error ?? 'no message'}]` : ''}${w.lastFiredAt ? `, last saw something new ${ago(w.lastFiredAt, now)}` : ''}`).join('\n')}`
      : null,
    `Autonomy (unlisted categories: propose): ${Object.entries(g.autonomy).map(([c, m]) => `${c}=${m}`).join(', ') || 'none set'}`,
    Object.keys(g.toolMap).length ? `Tool rules: ${Object.entries(g.toolMap).map(([p, c]) => `${p} → ${c}`).join(', ')}` : null,
    allowRulesText(g),
    g.memory.length > 0 ? `Memory:\n${g.memory.map((m) => `- ${m.id} [${m.kind}${m.pinned ? ', pinned' : ''}] ${m.text}`).join('\n')}` : null,
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

export const SCHEDULE_USAGE = 'every 30m | 6h | 30d | 2 weeks | daily | weekly | monthly [between 08:00-20:00] | cron <5 fields> | one-off | off'

const UNIT_MINUTES: Record<string, number> = {
  m: 1, min: 1, mins: 1, minute: 1, minutes: 1, h: 60, hr: 60, hrs: 60, hour: 60, hours: 60,
  d: 1440, day: 1440, days: 1440, w: 10080, wk: 10080, wks: 10080, week: 10080, weeks: 10080,
}

/** Words for common intervals ("monthly" is every 30 days). */
const WORD_INTERVALS: Record<string, string> = {
  hourly: '1h', daily: '1d', 'every day': '1d', nightly: '1d', weekly: '1w', 'every week': '1w',
  fortnightly: '2w', biweekly: '2w', monthly: '30d', 'every month': '30d', 'every hour': '1h',
}

/** "every 6h", "every 30m between 08:00-20:00", "cron 0 9 * * 1-5" or "off": a schedule, null (on demand), or why not. */
export function parseSchedule(text: string): { schedule: Schedule | null; oneOff?: boolean } | { error: string } {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ')
  if (t === 'off' || t === 'manual' || t === 'none') return { schedule: null }
  if (t === 'one-off' || t === 'oneoff' || t === 'one off' || t === 'once') return { schedule: null, oneOff: true }
  if (t.startsWith('cron ')) {
    const expr = text.trim().replace(/^cron\s+/i, '').trim()
    return expr.split(/\s+/).length === 5
      ? { schedule: { kind: 'cron', expr } }
      : { error: 'A cron expression has 5 fields (minute hour day month weekday), e.g. "cron 0 9 * * 1-5".' }
  }
  // "every 30d", "30d", "30 days", "every 2 weeks", "weekly", each with optional active hours
  const words = Object.entries(WORD_INTERVALS).find(([w]) => t === w || t.startsWith(`${w} between `))
  const spelled = words ? `${words[1]}${t.slice(words[0].length)}` : t
  const m = /^(?:every )?(\d+) ?([a-z]+)(?: between (\d{1,2}):(\d{2}) ?- ?(\d{1,2}):(\d{2}))?$/.exec(spelled)
  if (!m) return { error: `Say when it runs: ${SCHEDULE_USAGE}.` }
  const unit = UNIT_MINUTES[m[2]!]
  if (!unit) return { error: 'Use minutes, hours, days or weeks for the interval, e.g. "every 6h" or "30d".' }
  const minutes = Number(m[1]) * unit
  if (minutes < 5) return { error: 'Goals run at most every 5 minutes.' }
  const schedule: Schedule = { kind: 'interval', minutes }
  if (m[3] !== undefined) {
    const hours = [Number(m[3]), Number(m[5])]
    const mins = [Number(m[4]), Number(m[6])]
    if (hours.some((hour) => hour > 23) || mins.some((x) => x > 59)) return { error: 'Use 24-hour times, e.g. "between 08:00-20:00".' }
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

/** " · next in 25m", " · next run due now", " · one-off", " · no schedule", or "" while running or paused. */
export function nextRunText(g: Pick<GoalCard, 'status' | 'openRun' | 'nextRunAt' | 'schedule' | 'oneOff'>, now: number): string {
  if (g.status !== 'active' || g.openRun) return ''
  if (g.oneOff) return ' · one-off'
  if (g.nextRunAt) return Date.parse(g.nextRunAt) <= now ? ' · next run due now' : ` · next ${ago(g.nextRunAt, now)}`
  return g.schedule === null ? ' · no schedule' : ''
}

// ── Choosing a schedule ───────────────────────────────────────────────────────

export type ChoiceKey = 'hourly' | '6h' | 'daily' | 'weekly' | 'one-off' | 'on-demand' | 'custom'
export type ScheduleChoice = { key: ChoiceKey; label: string; schedule: Schedule | null; oneOff: boolean; /** How a typed answer was read, when a model read it. */ read?: string }
export type ModelTier = 'haiku' | 'sonnet' | 'opus'
export type Suggestion = {
  choice: Exclude<ChoiceKey, 'on-demand'>
  reason: string
  /** A short name for a goal created without one. */
  title?: string
  /** The model its runs should use, and why; absent when the small model gave none (new goals then get NEW_GOAL_MODEL). */
  model?: ModelTier
  modelReason?: string
}

/** The choices offered when a goal is created or given a schedule. */
export const SCHEDULE_CHOICES: readonly ScheduleChoice[] = [
  { key: 'hourly', label: 'Every hour', schedule: { kind: 'interval', minutes: 60 }, oneOff: false },
  { key: '6h', label: 'Every 6 hours', schedule: { kind: 'interval', minutes: 360 }, oneOff: false },
  { key: 'daily', label: 'Daily', schedule: { kind: 'interval', minutes: 1440 }, oneOff: false },
  { key: 'weekly', label: 'Weekly', schedule: { kind: 'interval', minutes: 10080 }, oneOff: false },
  { key: 'one-off', label: 'One-off: run once now', schedule: null, oneOff: true },
  { key: 'on-demand', label: 'Only when I run it', schedule: null, oneOff: false },
]

const SUGGESTED = ' (suggested)'

/** The alternatives offered after the suggestion, in this order (the question takes four options). */
const ALTERNATIVES: ChoiceKey[] = ['daily', 'weekly', 'one-off', 'hourly', '6h']

/** Four labels: the suggestion first and marked, then the most common alternatives. Anything else is typed. */
export function choiceOptions(suggested: ChoiceKey): string[] {
  const first = SCHEDULE_CHOICES.find((c) => c.key === suggested)!
  const rest = ALTERNATIVES.filter((k) => k !== suggested).slice(0, 3).map((k) => SCHEDULE_CHOICES.find((c) => c.key === k)!.label)
  return [first.label + SUGGESTED, ...rest]
}

/**
 * The choice an answer names. A typed answer is read like /goal-schedule
 * ("every 12h", "cron 0 9 * * 1-5", "off"). Null when dismissed or unreadable.
 */
export function choiceFromAnswer(answer: string | null): ScheduleChoice | null {
  const read = readAnswer(answer)
  return read && 'choice' in read ? read.choice : null
}

/** An answer read: the choice it names, why a typed one can't be read, or null when dismissed. */
export function readAnswer(answer: string | null): { choice: ScheduleChoice } | { error: string } | null {
  if (!answer || /^cancel$/i.test(answer.trim())) return null
  const label = answer.endsWith(SUGGESTED) ? answer.slice(0, -SUGGESTED.length) : answer
  const listed = SCHEDULE_CHOICES.find((c) => c.label === label)
  if (listed) return { choice: listed }
  const typed = parseSchedule(answer)
  if ('error' in typed) return { error: typed.error }
  const text = typed.oneOff ? 'one-off' : scheduleLabel(typed.schedule)
  return { choice: { key: 'custom', label: text, schedule: typed.schedule, oneOff: typed.oneOff ?? false } }
}

const KEYWORDS: [RegExp, Suggestion][] = [
  [/\b(once|one[- ]?off|install|set ?up|setup|migrate|migration|upgrade|fix|bootstrap)\b/, { choice: 'one-off', reason: 'it reads like a single task' }],
  [/\b(inbox|triage|alerts?|notifications?|on[- ]call|incidents?)\b/, { choice: 'hourly', reason: 'new things arrive all the time' }],
  [/\b(weekly|reports?|digest|summary|summaries|review)\b/, { choice: 'weekly', reason: 'it sums up a period' }],
  [/\b(monitor|watch|track|keep an eye)\w*/, { choice: '6h', reason: 'it watches for changes' }],
  [/\b(maintain|keep|check|update|sync|backup|back up|clean|tidy|current)\w*/, { choice: 'daily', reason: 'it is ongoing upkeep' }],
]

/** The fallback suggestion: keyword rules, leaning towards a daily schedule. */
export function suggestByKeywords(name: string, objective: string): Suggestion {
  const text = `${name} ${objective}`.toLowerCase().replace(/[-_]/g, ' ')
  for (const [re, suggestion] of KEYWORDS) if (re.test(text)) return suggestion
  return { choice: 'daily', reason: 'goals are ongoing unless they are clearly one-offs' }
}

const MODEL_TIERS: readonly ModelTier[] = ['haiku', 'sonnet', 'opus']

/**
 * The small model's answer: {"choice": ..., "reason": ..., "model": ..., "model_reason": ...},
 * possibly wrapped in prose or a code fence. A missing or unknown model is left out, not a failure.
 */
export function parseSuggestion(text: string): Suggestion | null {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!json) return null
  try {
    const v = JSON.parse(json) as { choice?: unknown; reason?: unknown; title?: unknown; model?: unknown; model_reason?: unknown }
    const choice = SCHEDULE_CHOICES.find((c) => c.key === v.choice && c.key !== 'on-demand')
    if (!choice) return null
    const sentence = (s: unknown) => (typeof s === 'string' && s.trim() ? s.trim().replace(/\.$/, '') : '')
    const reason = sentence(v.reason) || 'suggested from its objective'
    const title = typeof v.title === 'string' ? cleanTitle(v.title) : ''
    const named = typeof v.model === 'string' ? v.model.trim().toLowerCase() : ''
    const model = MODEL_TIERS.find((m) => m === named)
    const modelReason = model ? sentence(v.model_reason) : ''
    return { choice: choice.key as Suggestion['choice'], reason, ...(title && { title }), ...(model && { model }), ...(modelReason && { modelReason }) }
  } catch {
    return null
  }
}

// ── Goal titles ───────────────────────────────────────────────────────────────

const TITLE_MAX = 40

/** A title as a goal name: one line, no quotes or trailing full stop, at most 40 characters. */
export function cleanTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim().replace(/^["'`]+|["'`.]+$/g, '').trim()
  return t.length > TITLE_MAX ? clip(t, TITLE_MAX) : t
}

const FILLER = new Set(['a', 'an', 'the', 'my', 'our', 'to', 'please', 'and', 'of', 'for', 'in', 'on', 'that', 'so', 'it', 'is'])

/** A title from the objective's first words, for when the model can't suggest one. */
export function fallbackTitle(objective: string): string {
  const words = objective.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter((w) => w && !FILLER.has(w.toLowerCase()))
  const title = words.slice(0, 5).join(' ')
  return cleanTitle(title ? title[0]!.toUpperCase() + title.slice(1) : 'New goal')
}

/**
 * /goal-new's argument: "<name>: <objective>" when the part before the first
 * colon is short enough to be a name (up to 5 words, 40 characters), otherwise
 * all of it is the objective and the name is suggested.
 */
export function splitGoalArgs(args: string): { name: string | null; objective: string } {
  const text = args.trim()
  const at = text.indexOf(':')
  if (at > 0) {
    const name = text.slice(0, at).trim()
    const objective = text.slice(at + 1).trim()
    if (objective && name.length <= TITLE_MAX && name.split(/\s+/).length <= 5) return { name, objective }
  }
  return { name: null, objective: text }
}

// ── Discussing and changing goals ─────────────────────────────────────────────

/**
 * The prompt that brings a goal (or one of its runs) into the conversation to
 * talk it over. The person's own question, when they typed one, takes the
 * place of the usual one.
 */
export function discussPrompt(g: GoalCard, run?: GoalCard['runs'][number], question?: string): string {
  const how = 'Read its settings, items, runs and memory with goal_detail. If we agree on changes, make them with update_goal or set_schedule: they ask me to confirm.'
  const asked = question?.trim()
  if (!run) {
    return asked
      ? `Let's talk about my goal "${g.name}" (id ${g.id}). ${how}\n\nMy question: ${asked}`
      : `Let's talk about my goal "${g.name}" (id ${g.id}). ${how} What's working, what isn't, and what would you change?`
  }
  const when = `${run.status} (${run.trigger}), ${run.endedAt ?? run.startedAt}`
  const transcript = run.agentId
    ? ` Its agent was ${run.agentId}: its transcript (agent-${run.agentId}.jsonl, under ~/.claude/projects) shows what it actually did.`
    : ''
  if (asked) {
    return `Let's talk about this run of my goal "${g.name}" (goal ${g.id}, run ${run.id}): ${when}.\n\nIts summary: ${run.summary ?? '(none)'}\n\n${`${transcript} ${how}`.trim()}\n\nMy question: ${asked}`
  }
  return `Let's talk about this run of my goal "${g.name}" (goal ${g.id}, run ${run.id}): ${when}.\n\nIts summary: ${run.summary ?? '(none)'}\n\n${isFailed(run.status) ? 'Why did it fail, and what should change so it doesn\'t again?' : 'Is this what should have happened, and what should change?'}${transcript} ${how}`
}

// ── Allow rules for Claude Code ───────────────────────────────────────────────

/** Quarterdeck's own server, under both of its names (plugin-provided and added by hand). */
const OWN_SERVER_PREFIXES = ['mcp__plugin_quarterdeck-goals_quarterdeck__', 'mcp__quarterdeck__']

/**
 * The Claude Code allow rules that let a goal's `auto` tools run without a
 * permission prompt: one per tool rule whose category is auto. The guard only
 * refuses; whether a tool runs unasked is Claude Code's to say, so the person
 * adds these themselves. A tool rule Claude Code can't take as an allow rule
 * (a glob outside `mcp__<server>__`, such as `mcp__*`) is listed in `skipped`.
 */
export function allowRules(g: Pick<GoalCard, 'autonomy' | 'toolMap'>): { rules: string[]; skipped: string[] } {
  const rules = new Set<string>()
  const skipped: string[] = []
  for (const [pattern, category] of Object.entries(g.toolMap)) {
    if (g.autonomy[category] !== 'auto') continue
    const own = OWN_SERVER_PREFIXES.find((p) => pattern.startsWith(p))
    const names = own ? OWN_SERVER_PREFIXES.map((p) => p + pattern.slice(own.length)) : [pattern]
    for (const name of names) {
      const star = name.indexOf('*')
      const server = /^mcp__([^*]+?)__/.exec(name)
      // Claude Code takes a glob in an allow rule only after a literal mcp__<server>__
      if (star >= 0 && !(server && star >= server[0].length)) {
        if (!skipped.includes(pattern)) skipped.push(pattern)
        continue
      }
      rules.add(name)
    }
  }
  return { rules: [...rules].sort(), skipped }
}

/** The prompt behind the pane's "Ask Claude to add them": Claude shows the change and waits for a yes. */
export function allowRulesPrompt(g: Pick<GoalCard, 'id' | 'name'>, rules: string[]): string {
  return [
    `My Quarterdeck goal "${g.name}" (id ${g.id}) lets its runs use these tools without asking me first, but Claude Code still asks me before each call. Please add these allow rules to my Claude Code settings:`,
    '',
    ...rules.map((r) => `- \`${r}\``),
    '',
    'Use my user settings (~/.claude/settings.json) unless I say otherwise: a goal run starts in whichever Claude Code window is running goals. An allow rule applies to everything in Claude Code, not only goal runs, so say in a sentence what each one lets through. Keep everything already in the file. Show me the exact change and wait for my yes before you write it.',
  ].join('\n')
}

/** The goal's allow rules for goal_detail, or null when it has none. */
function allowRulesText(g: Pick<GoalCard, 'autonomy' | 'toolMap'>): string | null {
  const { rules, skipped } = allowRules(g)
  if (rules.length === 0 && skipped.length === 0) return null
  return [
    rules.length > 0 ? `Claude Code allow rules for its auto tools (without them Claude Code asks before each call, unless the session is in auto mode): ${rules.join(', ')}` : null,
    skipped.length > 0 ? `Tool rules Claude Code can't take as allow rules: ${skipped.join(', ')}` : null,
  ].filter(Boolean).join('\n')
}

/** The prompt that asks Claude to install a published update (the pane's "Ask Claude to install it"). */
export function updatePrompt(u: Update): string {
  return [
    `Quarterdeck ${u.latest} is available (I have ${u.installed}). Please install it:`,
    '',
    '1. `claude plugin marketplace update quarterdeck`',
    '2. `claude plugin update quarterdeck-goals@quarterdeck`',
    '3. `claude plugin update quarterdeck-guard@quarterdeck`',
    '',
    "Tell me what each one answered. If they worked, remind me to run /reload-plugins in every open Claude Code session (only I can type that), and that goal runs wait in a session until it has. If one failed, say why and don't try anything else without asking me.",
  ].join('\n')
}

export type GoalChanges = {
  name?: string
  objective?: string
  instructions?: string
  autonomy?: Record<string, string | null>
  tool_map?: Record<string, string | null>
  add_memory?: { kind: string; text: string; pinned?: boolean }[]
  forget_memory?: string[]
  /** Watch name → what it runs; null removes it. */
  watches?: Record<string, WatchChange | null>
  status?: 'active' | 'paused'
  /** The model its runs use; null: the session's. */
  model?: string | null
}

/** A watch as update_goal takes it: a command to run, or a tool to call with its input. */
export type WatchChange = { command?: string; tool?: string; input?: Record<string, unknown>; match?: string; every_minutes?: number }

/** How often a watch checks when it isn't said (the server's default). */
export const WATCH_DEFAULT_MINUTES = 5

/** True for an objective about reacting to things as they happen ("when a new issue is opened…"): a watch would suit it. */
export function soundsEventDriven(objective: string): boolean {
  return /\b(when(ever)?|as soon as|each time|every time)\b.{0,60}\b(new|opens?|opened|arrives?|appears?|posted|published|changes?|is (created|added|merged|released))\b|\bnew (issues?|prs?|pull requests?|releases?|posts?|commits?|emails?|messages?|files?)\b/i.test(objective)
}

/** The changes as the person reads them before confirming: one line each, from what is to what will be. */
export function describeGoalChanges(g: GoalCard, c: GoalChanges): string[] {
  const lines: string[] = []
  if (c.name && c.name !== g.name) lines.push(`Name: "${g.name}" → "${c.name}"`)
  if (c.objective && c.objective !== g.objective) lines.push(`Objective → ${c.objective}`)
  if (c.instructions !== undefined && c.instructions !== g.instructions) lines.push(c.instructions.trim() ? `Instructions → ${c.instructions}` : 'Instructions: cleared')
  for (const [cat, mode] of Object.entries(c.autonomy ?? {})) lines.push(`${cat}: ${g.autonomy[cat] ?? 'propose'} → ${mode ?? 'propose (default)'}`)
  for (const [pat, cat] of Object.entries(c.tool_map ?? {})) lines.push(cat === null ? `Tool rule removed: ${pat}` : `Tool rule: ${pat} → ${cat}${cat === 'untrusted' ? ' (reads outside content: auto actions then need approval for the rest of the run)' : ''}`)
  for (const m of c.add_memory ?? []) lines.push(`Remember (${m.kind}${m.pinned ? ', pinned' : ''}): ${m.text}`)
  for (const id of c.forget_memory ?? []) lines.push(`Forget: ${g.memory.find((m) => m.id === id)?.text ?? id}`)
  // A watch's command runs unattended: the person reads all of it, never a clipped one
  for (const [name, w] of Object.entries(c.watches ?? {})) {
    const had = g.watches.some((x) => x.name === name.trim())
    if (w === null) lines.push(`Watch removed: ${name}`)
    else if (w.tool) lines.push(`${had ? 'Watch changed' : 'New watch'} "${name.trim()}": every ${w.every_minutes ?? WATCH_DEFAULT_MINUTES} min this tool is called without asking you, and a run starts when its answer has something it hasn't before: ${w.tool} ${JSON.stringify(w.input ?? {})}${w.match ? ` (read with ${w.match})` : ''}`)
    else lines.push(`${had ? 'Watch changed' : 'New watch'} "${name.trim()}": every ${w.every_minutes ?? WATCH_DEFAULT_MINUTES} min this command runs on your computer, and a run starts when it prints a line it hasn't before: ${w.command ?? ''}`)
  }
  if (c.model !== undefined && (c.model || null) !== g.model) lines.push(`Model: ${goalModelLabel(g.model)} → ${goalModelLabel(c.model || null)}`)
  if (c.status && c.status !== g.status) lines.push(c.status === 'paused' ? 'Pause the goal' : 'Resume the goal')
  return lines
}

/** When a hold ends, as a short local time ("8:10 pm", or with the date if not today). */
export function holdUntilText(until: string, now: number): string {
  const d = new Date(until)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

/** "48k tokens": the new tokens a run used (no cache reads); '' when unknown. */
export function runTokens(run: { tokens?: number }): string {
  const t = run.tokens ?? 0
  if (t <= 0) return ''
  return `${t >= 1_000_000 ? `${(t / 1_000_000).toFixed(1)}M` : t >= 1000 ? `${Math.round(t / 1000)}k` : t} tokens`
}

/** "Opus 5.5" for claude-opus-5-5, "Sonnet" for sonnet; anything else as it is. */
export function modelName(model: string): string {
  const m = /(haiku|sonnet|opus|fable)(?:-(\d{1,2})(?!\d)(?:[-.](\d{1,2})(?!\d))?)?/i.exec(model)
  if (!m) return model
  const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()
  return m[2] ? `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : family
}

/** A goal's model setting as the person reads it. */
export function goalModelLabel(model: string | null): string {
  return model ? modelName(model) : "the session's model"
}

/** The pane's model choices, in the order asked; "Session's model" is null. At most 4 ($.ui.ask's limit). */
export const MODEL_CHOICES: { label: string; model: string | null }[] = [
  { label: "Session's model", model: null },
  { label: 'Haiku', model: 'haiku' },
  { label: 'Sonnet', model: 'sonnet' },
  { label: 'Opus', model: 'opus' },
]

/**
 * The model a new goal gets when nothing suggests another (the small model
 * gave none, or wasn't there): routine runs don't need the largest model, and
 * a goal can be changed when one does.
 */
export const NEW_GOAL_MODEL: ModelTier = 'sonnet'

/** " Its runs use Haiku (it only checks and reports)." for the message after a goal is created. */
export function newGoalModelText(model: string, reason?: string): string {
  return ` Its runs use ${modelName(model)}${reason ? ` (${reason})` : ''}; change that in the Goals pane.`
}

/**
 * The person's answer to the model question: a choice, or a model id typed
 * under Other. null when dismissed or cancelled (nothing changes).
 */
export function readModelAnswer(answer: string | null): { model: string | null } | null {
  const a = (answer ?? '').trim()
  if (!a || /^cancel$/i.test(a)) return null
  const choice = MODEL_CHOICES.find((c) => c.label.toLowerCase() === a.toLowerCase())
  if (choice) return { model: choice.model }
  if (/^(inherit|default|session)$/i.test(a)) return { model: null }
  return { model: a }
}

/** "Opus 5.5 · 48k tokens · 2m": the model a finished run used, the new tokens (no cache reads) and how long it took; '' when unknown. */
export function runCost(run: { tokens?: number; startedAt: string; endedAt: string | null; model?: string | null }): string {
  const parts: string[] = []
  if (run.model) parts.push(modelName(run.model))
  const tokens = runTokens(run)
  if (tokens) parts.push(tokens)
  if (run.endedAt) {
    const s = Math.max(0, Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000))
    parts.push(s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`)
  }
  return parts.join(' · ')
}

/**
 * True when Claude Code refused one of this plugin's own writes because it
 * needs the person's approval, which a plugin's call can't ask for. That
 * happens in plan mode, where every call that isn't a read becomes an ask.
 */
export function planModeBlocked(message: string): boolean {
  return /needs a person's approval/i.test(message)
}
