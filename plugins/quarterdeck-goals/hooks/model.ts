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
  one_off?: boolean
  instructions?: string
  autonomy?: Record<string, string>
  tool_map?: Record<string, string>
  open_run: { id: string; status: string } | null
  activity?: { state: 'running' | 'queued' | 'paused' | 'idle'; text: string; at: string | null }
  runs: { id: string; status: string; trigger: string; summary: string | null; started_at: string; ended_at: string | null; agent_id?: string | null; tokens?: number }[]
  /** False for a card: runs, memory, open items, instructions and tool rules left out. */
  detail?: boolean
  needs_you_count?: number
  needs_you: OverviewItem[]
  open_items: OverviewItem[]
  open_item_count: number
  health: { passed: boolean; value: number | null }[]
  memory: { id: string; kind: string; text: string; pinned: boolean }[]
  suggestions: { category: string; approved_in_a_row: number }[]
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
    runs: g.runs.map((r) => ({ id: r.id, status: r.status, trigger: r.trigger, summary: r.summary, startedAt: r.started_at, endedAt: r.ended_at, agentId: r.agent_id ?? null, tokens: r.tokens ?? 0 })),
    nextRunAt: g.next_run_at,
    schedule: g.schedule ?? null,
    oneOff: g.one_off ?? false,
    instructions: g.instructions ?? '',
    autonomy: g.autonomy ?? {},
    toolMap: g.tool_map ?? {},
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
  if (!s.reachable) return 'Quarterdeck: offline'
  if (s.goals.length === 0) return undefined
  const waiting = s.goals.reduce((n, g) => n + g.needsYou.length, 0)
  const running = s.goals.filter((g) => g.openRun?.status === 'running').map((g) => g.name)
  const parts = [
    waiting > 0 ? `${waiting} need${waiting === 1 ? 's' : ''} you` : null,
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
      ? `Recent runs:\n${g.runs.map((r) => `- ${r.status} (${r.trigger}) ${ago(r.endedAt ?? r.startedAt, now)}${r.summary ? ` — ${r.summary}` : ''}`).join('\n')}`
      : null,
    g.instructions.trim() ? `Instructions: ${g.instructions.trim()}` : null,
    `Schedule: ${g.oneOff ? 'one-off' : scheduleLabel(g.schedule)}`,
    `Autonomy (unlisted categories: propose): ${Object.entries(g.autonomy).map(([c, m]) => `${c}=${m}`).join(', ') || 'none set'}`,
    Object.keys(g.toolMap).length ? `Tool rules: ${Object.entries(g.toolMap).map(([p, c]) => `${p} → ${c}`).join(', ')}` : null,
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
export type Suggestion = { choice: Exclude<ChoiceKey, 'on-demand'>; reason: string; /** A short name for a goal created without one. */ title?: string }

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

/** The small model's answer: {"choice": ..., "reason": ...}, possibly wrapped in prose or a code fence. */
export function parseSuggestion(text: string): Suggestion | null {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!json) return null
  try {
    const v = JSON.parse(json) as { choice?: unknown; reason?: unknown; title?: unknown }
    const choice = SCHEDULE_CHOICES.find((c) => c.key === v.choice && c.key !== 'on-demand')
    if (!choice) return null
    const reason = typeof v.reason === 'string' && v.reason.trim() ? v.reason.trim().replace(/\.$/, '') : 'suggested from its objective'
    const title = typeof v.title === 'string' ? cleanTitle(v.title) : ''
    return { choice: choice.key as Suggestion['choice'], reason, ...(title && { title }) }
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

/** The prompt that brings a goal (or one of its runs) into the conversation to talk it over. */
export function discussPrompt(g: GoalCard, run?: GoalCard['runs'][number]): string {
  const how = 'Read its settings, items, runs and memory with goal_detail. If we agree on changes, make them with update_goal or set_schedule: they ask me to confirm.'
  if (!run) {
    return `Let's talk about my goal "${g.name}" (id ${g.id}). ${how} What's working, what isn't, and what would you change?`
  }
  const when = `${run.status} (${run.trigger}), ${run.endedAt ?? run.startedAt}`
  const transcript = run.agentId
    ? ` Its agent was ${run.agentId}: its transcript (agent-${run.agentId}.jsonl, under ~/.claude/projects) shows what it actually did.`
    : ''
  return `Let's talk about this run of my goal "${g.name}" (goal ${g.id}, run ${run.id}): ${when}.\n\nIts summary: ${run.summary ?? '(none)'}\n\n${isFailed(run.status) ? 'Why did it fail, and what should change so it doesn\'t again?' : 'Is this what should have happened, and what should change?'}${transcript} ${how}`
}

export type GoalChanges = {
  name?: string
  objective?: string
  instructions?: string
  autonomy?: Record<string, string | null>
  tool_map?: Record<string, string | null>
  add_memory?: { kind: string; text: string; pinned?: boolean }[]
  forget_memory?: string[]
  status?: 'active' | 'paused'
}

/** The changes as the person reads them before confirming: one line each, from what is to what will be. */
export function describeGoalChanges(g: GoalCard, c: GoalChanges): string[] {
  const lines: string[] = []
  if (c.name && c.name !== g.name) lines.push(`Name: "${g.name}" → "${c.name}"`)
  if (c.objective && c.objective !== g.objective) lines.push(`Objective → ${c.objective}`)
  if (c.instructions !== undefined && c.instructions !== g.instructions) lines.push(c.instructions.trim() ? `Instructions → ${c.instructions}` : 'Instructions: cleared')
  for (const [cat, mode] of Object.entries(c.autonomy ?? {})) lines.push(`${cat}: ${g.autonomy[cat] ?? 'propose'} → ${mode ?? 'propose (default)'}`)
  for (const [pat, cat] of Object.entries(c.tool_map ?? {})) lines.push(cat === null ? `Tool rule removed: ${pat}` : `Tool rule: ${pat} → ${cat}`)
  for (const m of c.add_memory ?? []) lines.push(`Remember (${m.kind}${m.pinned ? ', pinned' : ''}): ${m.text}`)
  for (const id of c.forget_memory ?? []) lines.push(`Forget: ${g.memory.find((m) => m.id === id)?.text ?? id}`)
  if (c.status && c.status !== g.status) lines.push(c.status === 'paused' ? 'Pause the goal' : 'Resume the goal')
  return lines
}

/** When a hold ends, as a short local time ("8:10 pm", or with the date if not today). */
export function holdUntilText(until: string, now: number): string {
  const d = new Date(until)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

/** "48k tokens · 2m": what a finished run used, and how long it took; '' when unknown. */
export function runCost(run: { tokens?: number; startedAt: string; endedAt: string | null }): string {
  const parts: string[] = []
  const t = run.tokens ?? 0
  if (t > 0) parts.push(`${t >= 1_000_000 ? `${(t / 1_000_000).toFixed(1)}M` : t >= 1000 ? `${Math.round(t / 1000)}k` : t} tokens`)
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
