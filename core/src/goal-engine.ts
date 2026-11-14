/**
 * Persistent goals — behaviour: work items, the run brief, run lifecycle,
 * retention, and the scheduler's decisions. Storage lives in goals.ts.
 */
import type { Database } from './sqlite.js'
import { getPlan, getTask, insertTask, nextChildId, compareTaskIds, deserializeTask } from './queries.js'
import { isProposal } from './gates.js'
import {
  countRunsSince, getGoal, getOpenRun, getRun, insertRun, listMemory, listRuns, markRunUntrusted, updateMemory, updateRun, updateGoal,
} from './goals.js'
import { getSchedule, nextScheduledRun } from './schedule.js'
import { listHealth } from './health.js'
import { releaseWatchEvents, takeWatchEvents, type WatchNews } from './watches.js'
import type { AutonomyMode, Goal, GoalRun, Task, TriggerKind } from './types.js'

export class GoalError extends Error {}

/** How many characters of memory a brief may include (pinned memories always are). */
export const MEMORY_BRIEF_CHARS = 4000

export function autonomyFor(goal: Goal, category: string): AutonomyMode {
  return goal.autonomy[category] ?? 'propose'
}

function mustGetGoal(db: Database, planId: string): Goal {
  const goal = getGoal(db, planId)
  if (!goal) throw new GoalError(`Plan ${planId} is not a persistent goal.`)
  return goal
}

// ── Work items ────────────────────────────────────────────────────────────────

export interface ProposedAction {
  category: string
  summary: string
  params?: Record<string, unknown>
}

export interface AddItemInput {
  goal: string
  external_ref?: string
  /** An action to propose (or record, when its category is 'auto'). */
  action?: ProposedAction
  status?: 'pending' | 'active'
  result?: string
  notes?: string
  /**
   * Something only the person can give or do (a choice, information, connecting
   * a service, allowing a site): the item waits under Needs you, like a proposal,
   * until they answer it or mark it done.
   */
  ask_person?: boolean
}

export interface AddItemResult {
  task: Task
  /** True when an item with this external_ref already existed (it is returned unchanged). */
  existing: boolean
  /** The autonomy mode applied to the item's action, if any. */
  mode?: AutonomyMode
  /** Set when an `auto` action became a proposal because the run has read untrusted content (what it read). */
  untrusted?: string
  /** Set when the action's category is new to the goal but looks like ones it already has (same first segment). */
  similar_categories?: string[]
}

// ── Known action categories ──────────────────────────────────────────────────

export interface KnownCategory {
  category: string
  mode: AutonomyMode
  /** How many of the goal's items have used it. */
  uses: number
  /** The summary of the latest item that used it. */
  example?: string
}

/**
 * The action categories a goal already knows: its autonomy keys plus those its
 * items have used, most used first. Runs reuse these so the same action keeps
 * one name (and its approvals count toward the "Switch to auto" suggestion).
 */
export function knownCategories(db: Database, planId: string): KnownCategory[] {
  const goal = mustGetGoal(db, planId)
  const rows = db.prepare(`
    SELECT json_extract(state, '$.action.category') category, COUNT(*) uses,
      (SELECT json_extract(t2.state, '$.action.summary') FROM tasks t2
        WHERE t2.plan_id = t.plan_id AND json_extract(t2.state, '$.action.category') = json_extract(t.state, '$.action.category')
        ORDER BY t2.created_at DESC LIMIT 1) example
    FROM tasks t WHERE plan_id = ? AND json_extract(state, '$.action.category') IS NOT NULL
    GROUP BY category
  `).all(planId) as { category: string; uses: number; example: string | null }[]
  const byName = new Map<string, KnownCategory>()
  for (const r of rows) byName.set(r.category, { category: r.category, mode: autonomyFor(goal, r.category), uses: r.uses, ...(r.example && { example: r.example }) })
  for (const [category, mode] of Object.entries(goal.autonomy)) if (!byName.has(category)) byName.set(category, { category, mode, uses: 0 })
  return [...byName.values()].sort((a, b) => b.uses - a.uses || a.category.localeCompare(b.category))
}

/** Known categories that look like the same kind of action as a new one: the same first segment (`github.push` ~ `github.pr`). */
export function similarCategories(known: KnownCategory[], category: string): string[] {
  if (known.some((k) => k.category === category)) return []
  const head = category.split(/[._:/-]/)[0]!.toLowerCase()
  return known.filter((k) => k.category.split(/[._:/-]/)[0]!.toLowerCase() === head).map((k) => k.category)
}

/**
 * Adds a work item to a goal. Deduplicates by external_ref (including archived
 * items), enforces the per-run item cap, and applies the goal's autonomy:
 *   off     → refused
 *   propose → item waits for human approval (requires_approval, review requested now)
 *   auto    → item recorded as already done (the agent has taken the action),
 *             or a proposal once the run has read untrusted content (guard.ts)
 */
export function addItem(db: Database, planId: string, runId: string | null, input: AddItemInput): AddItemResult {
  const goal = mustGetGoal(db, planId)
  if (goal.status === 'retired') throw new GoalError('This goal is retired.')

  if (input.external_ref) {
    const row = db.prepare('SELECT * FROM tasks WHERE plan_id = ? AND external_ref = ?').get(planId, input.external_ref) as Record<string, unknown> | undefined
    if (row) return { task: deserializeTask(row), existing: true }
  }

  if (runId) {
    const created = (db.prepare('SELECT COUNT(*) n FROM tasks WHERE plan_id = ? AND run_id = ?').get(planId, runId) as { n: number }).n
    if (created >= goal.limits.max_items_per_run) {
      throw new GoalError(`This run already created ${created} items (limit ${goal.limits.max_items_per_run}). Finish with end_run; the rest can wait for the next run.`)
    }
  }

  const now = new Date().toISOString()
  const id = nextChildId(db, planId, null)
  const base = {
    id, plan_id: planId, goal: input.goal, result: input.result ?? null, abandon_reason: null,
    depends_on: null, notes: input.notes ?? null, run_id: runId, external_ref: input.external_ref ?? null,
    created_by: 'agent' as const, created_at: now, updated_at: now,
  }

  if (!input.action) {
    if (input.ask_person) {
      insertTask(db, { ...base, status: 'active', state: { asks_person: true }, requires_approval: true, review_requested_at: now })
    } else {
      insertTask(db, { ...base, status: input.status ?? 'pending', state: {} })
    }
    return { task: getTask(db, planId, id)!, existing: false }
  }

  if (input.action.category === 'untrusted') {
    throw new GoalError('"untrusted" is the tool-rule category for tools that read outside content, not an action category. Use the category of the action itself.')
  }
  const goalMode = autonomyFor(goal, input.action.category)
  const similar = similarCategories(knownCategories(db, planId), input.action.category)
  const untrusted = goalMode === 'auto' && runId ? getRun(db, runId)?.untrusted_source ?? undefined : undefined
  const mode: AutonomyMode = untrusted !== undefined ? 'propose' : goalMode
  if (mode === 'off') {
    throw new GoalError(`Action category "${input.action.category}" is off for this goal: don't take or propose this action.`)
  }
  const state = { action: { ...input.action, params: input.action.params ?? {} } }
  if (mode === 'propose') {
    insertTask(db, { ...base, status: 'active', state, requires_approval: true, review_requested_at: now })
  } else {
    insertTask(db, { ...base, status: 'completed', state, result: input.result ?? `Done automatically: ${input.action.summary}` })
  }
  return { task: getTask(db, planId, id)!, existing: false, mode, ...(untrusted !== undefined && { untrusted }), ...(similar.length > 0 && { similar_categories: similar }) }
}

// ── Brief ─────────────────────────────────────────────────────────────────────

export interface ItemSummary {
  id: string
  goal: string
  status: Task['status']
  external_ref: string | null
  awaiting_review: boolean
  /** Approved proposal: carry out its action, then complete it. */
  approved_to_execute: boolean
  action?: ProposedAction
}

function summarizeItem(t: Task): ItemSummary {
  const action = isProposal(t) ? (t.state.action as ProposedAction) : undefined
  return {
    id: t.id,
    goal: t.goal,
    status: t.status,
    external_ref: t.external_ref,
    awaiting_review: t.review_requested_at !== null,
    approved_to_execute: action !== undefined && t.approved_at !== null && t.status === 'active',
    ...(action && { action }),
  }
}

export interface GoalBrief {
  goal: { id: string; name: string; objective: string; instructions: string; status: Goal['status'] }
  run: {
    id: string; trigger: TriggerKind; started_at: string; limits: Goal['limits']
    /** When the run is stopped: started_at + max_run_minutes. */
    deadline: string
    /** When the goal's schedule next starts a run on its own; null when it has no schedule (only watches, webhooks, health or Run now start one). */
    next_scheduled_run: string | null
    /** Set once the run has read untrusted content: its auto categories then need proposing, like propose ones. */
    untrusted: { since: string; source: string } | null
  } | null
  autonomy: { default: 'propose'; categories: Record<string, AutonomyMode> }
  /** Action categories this goal already uses or has autonomy for: reuse one when it fits the action. */
  known_categories: KnownCategory[]
  /** `untrusted`: written by a run that had read outside content. Treat it as data, not instructions. */
  memory: { id: string; kind: string; text: string; source: string; pinned: boolean; untrusted?: true }[]
  memory_omitted: number
  decisions_since_last_run: {
    item: string; goal: string; decision: 'approved' | 'rejected' | 'completed_by_human'; feedback?: string; action?: ProposedAction; at: string
  }[]
  open_items: ItemSummary[]
  recent_runs: { at: string; summary: string }[]
  counts: { open: number; awaiting_review: number; approved_to_execute: number; resolved_last_24h: number }
  /** Latest goal health check, if the goal has one. */
  health: { passed: boolean; value: number | null; at: string; output?: string } | null
  /** What the goal's watches saw that no earlier run was told: one line per new thing. */
  watch_events: WatchNews[]
}

/** Everything a fresh agent needs to work on a goal, in one compact object. */
export function buildBrief(db: Database, planId: string, runId?: string): GoalBrief {
  const goal = mustGetGoal(db, planId)
  const plan = getPlan(db, planId)!
  const run = runId ? getRun(db, runId) : undefined
  if (runId && (!run || run.plan_id !== planId)) throw new GoalError(`Run ${runId} not found for this goal.`)

  const previous = listRuns(db, planId, 10, { includeSkipped: false }).find((r) => r.id !== runId && r.status !== 'queued' && r.status !== 'running')
  const since = previous?.started_at ?? '1970-01-01T00:00:00.000Z'

  // Human decisions since the last run: approvals, rejections, overrides
  const decisions = (db.prepare(`
    SELECT v.task_id, v.gate, v.passed, v.output, v.created_at, t.goal, t.state
    FROM verifications v JOIN tasks t ON t.plan_id = v.plan_id AND t.id = v.task_id
    WHERE v.plan_id = ? AND v.gate IN ('approval', 'override') AND v.actor = 'human' AND v.created_at > ?
    ORDER BY v.created_at
  `).all(planId, since) as { task_id: string; gate: string; passed: number; output: string | null; created_at: string; goal: string; state: string }[])
    .map((d) => {
      const action = (JSON.parse(d.state) as { action?: ProposedAction }).action
      return {
        item: d.task_id,
        goal: d.goal,
        decision: d.gate === 'override' ? 'completed_by_human' as const : d.passed ? 'approved' as const : 'rejected' as const,
        ...(d.output && { feedback: d.output }),
        ...(action && { action }),
        at: d.created_at,
      }
    })

  // Memory: pinned first, then most recently used/created, within the budget
  const active = listMemory(db, planId, { activeOnly: true })
  const ordered = [
    ...active.filter((m) => m.pinned),
    ...active.filter((m) => !m.pinned).sort((a, b) => (b.last_used_at ?? b.created_at).localeCompare(a.last_used_at ?? a.created_at)),
  ]
  const memory: typeof ordered = []
  let chars = 0
  for (const m of ordered) {
    if (!m.pinned && chars + m.text.length > MEMORY_BRIEF_CHARS) continue
    memory.push(m)
    chars += m.text.length
  }
  const nowIso = new Date().toISOString()
  for (const m of memory) updateMemory(db, m.id, { last_used_at: nowIso })

  const items = (db.prepare("SELECT * FROM tasks WHERE plan_id = ? AND archived_at IS NULL AND status IN ('pending', 'active')").all(planId) as Record<string, unknown>[])
    .map(deserializeTask)
    .map(summarizeItem)
    .sort((a, b) => Number(b.approved_to_execute) - Number(a.approved_to_execute) || compareTaskIds(a.id, b.id))

  // Watch lines are outside text (issue titles, email subjects): handing them to the run marks it
  const watchEvents = takeWatchEvents(db, planId, runId)
  if (run && watchEvents.length) markRunUntrusted(db, run.id, 'watch events')
  // So is memory a marked run wrote: otherwise injected text could wait one run and act unchecked
  const taintedMemory = memory.find((m) => m.untrusted_source)
  if (run && taintedMemory) markRunUntrusted(db, run.id, `memory ${taintedMemory.id} (written after ${taintedMemory.untrusted_source})`)
  const marked = run ? getRun(db, run.id) : undefined

  const dayAgo = new Date(Date.now() - 86_400_000).toISOString()
  const resolved24h = (db.prepare("SELECT COUNT(*) n FROM tasks WHERE plan_id = ? AND status IN ('completed', 'abandoned') AND updated_at >= ?").get(planId, dayAgo) as { n: number }).n

  return {
    goal: { id: planId, name: plan.name, objective: goal.objective, instructions: goal.instructions, status: goal.status },
    run: run ? {
      id: run.id, trigger: run.trigger, started_at: run.started_at, limits: goal.limits,
      deadline: new Date(Date.parse(run.started_at) + goal.limits.max_run_minutes * 60_000).toISOString(),
      next_scheduled_run: nextScheduledRun(db, planId, new Date(run.started_at)),
      untrusted: marked?.untrusted_at && marked.untrusted_source ? { since: marked.untrusted_at, source: marked.untrusted_source } : null,
    } : null,
    autonomy: { default: 'propose', categories: goal.autonomy },
    known_categories: knownCategories(db, planId),
    memory: memory.map((m) => ({ id: m.id, kind: m.kind, text: m.text, source: m.source, pinned: m.pinned, ...(m.untrusted_source && { untrusted: true as const }) })),
    memory_omitted: active.length - memory.length,
    decisions_since_last_run: decisions,
    open_items: items,
    recent_runs: listRuns(db, planId, 10, { includeSkipped: false })
      .filter((r) => r.id !== runId && r.summary)
      .slice(0, 3)
      .map((r) => ({ at: r.started_at, summary: r.summary! })),
    counts: {
      open: items.length,
      awaiting_review: items.filter((i) => i.awaiting_review).length,
      approved_to_execute: items.filter((i) => i.approved_to_execute).length,
      resolved_last_24h: resolved24h,
    },
    health: (() => {
      const [h] = listHealth(db, planId, 1)
      return h ? { passed: h.passed, value: h.value, at: h.created_at, ...(!h.passed && h.output && { output: h.output.slice(-500) }) } : null
    })(),
    watch_events: watchEvents,
  }
}

// ── Run lifecycle ─────────────────────────────────────────────────────────────

/** Queues a manual run, or returns the goal's already queued/running run. */
export function queueRun(db: Database, planId: string, trigger: TriggerKind = 'manual'): GoalRun {
  const goal = mustGetGoal(db, planId)
  if (goal.status !== 'active') throw new GoalError(`Goal is ${goal.status}; resume it before running.`)
  return getOpenRun(db, planId) ?? insertRun(db, planId, trigger, 'queued')
}

export function startRun(db: Database, runId: string, sessionId: string | null): GoalRun {
  const run = getRun(db, runId)
  if (!run) throw new GoalError(`Run ${runId} not found.`)
  updateRun(db, runId, { status: 'running', session_id: sessionId, started_at: new Date().toISOString() })
  updateGoal(db, run.plan_id, { last_run_at: new Date().toISOString() })
  return getRun(db, runId)!
}

/** The longest goal status a run can set: it sits in the goal's one-line summary. */
export const STATUS_NOTE_MAX = 40

/** Control characters, zero-width and text-direction marks: they could hide or reorder what the pane shows. */
function isHidden(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f)
    || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
}

/**
 * A run's goal status as the pane shows it: plain text on one line (control
 * characters and escape sequences dropped, whitespace collapsed), capped at
 * STATUS_NOTE_MAX characters. Empty means clear it.
 */
export function cleanStatusNote(text: string): string {
  const plain = [...text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')] // ANSI escape sequences
    .map((c) => (isHidden(c.codePointAt(0)!) ? ' ' : c)) // control and direction characters
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...plain]
  return chars.length > STATUS_NOTE_MAX ? `${chars.slice(0, STATUS_NOTE_MAX - 1).join('').trimEnd()}…` : plain
}

/**
 * Finishes a run with the agent's summary, counts its items, and archives old resolved items.
 * `status`, when given, becomes the goal's status (an empty one clears it); left out, the goal keeps the one it has.
 */
export function endRun(db: Database, runId: string, summary: string, status?: string): GoalRun {
  const run = getRun(db, runId)
  if (!run) throw new GoalError(`Run ${runId} not found.`)
  if (run.status !== 'running' && run.status !== 'queued') throw new GoalError(`Run ${runId} already ended (${run.status}).`)
  if (!summary.trim()) throw new GoalError('A summary is required: what you did, what is waiting, what you learned.')
  const now = new Date().toISOString()
  const created = (db.prepare('SELECT COUNT(*) n FROM tasks WHERE plan_id = ? AND run_id = ?').get(run.plan_id, runId) as { n: number }).n
  const resolved = (db.prepare("SELECT COUNT(*) n FROM tasks WHERE plan_id = ? AND status IN ('completed', 'abandoned') AND updated_at >= ?")
    .get(run.plan_id, run.started_at) as { n: number }).n
  updateRun(db, runId, { status: 'completed', summary: summary.trim(), ended_at: now, items_created: created, items_resolved: resolved })
  if (status !== undefined) {
    const note = cleanStatusNote(status)
    updateGoal(db, run.plan_id, note
      ? { status_note: note, status_note_at: now, status_note_untrusted: run.untrusted_source ?? null }
      : { status_note: null, status_note_at: null, status_note_untrusted: null })
  }
  archiveResolved(db, run.plan_id)
  finishIfDone(db, run.plan_id)
  return getRun(db, runId)!
}

/** Open items: pending, or active (which includes proposals waiting for review and approved ones not yet carried out). */
export function countOpenItems(db: Database, planId: string): number {
  return (db.prepare("SELECT COUNT(*) n FROM tasks WHERE plan_id = ? AND archived_at IS NULL AND status IN ('pending', 'active')")
    .get(planId) as { n: number }).n
}

/** A one-off goal whose run left nothing open is done: it retires (the pane lists it under Done). */
export function finishIfDone(db: Database, planId: string): boolean {
  const goal = getGoal(db, planId)
  if (!goal?.one_off || goal.status !== 'active' || countOpenItems(db, planId) > 0) return false
  updateGoal(db, planId, { status: 'retired', next_run_at: null })
  return true
}

/** Marks a run failed or timed out; partial work stays. No-op if it already ended. */
export function failRun(db: Database, runId: string, status: 'failed' | 'timed_out', reason: string): void {
  const run = getRun(db, runId)
  if (!run || (run.status !== 'running' && run.status !== 'queued')) return
  updateRun(db, runId, { status, ended_at: new Date().toISOString(), summary: run.summary ?? reason })
  // What its watches reported goes to the next run instead
  releaseWatchEvents(db, runId)
}

/** Hides resolved items older than the goal's retention period. Returns how many were archived. */
export function archiveResolved(db: Database, planId: string, now: Date = new Date()): number {
  const goal = getGoal(db, planId)
  if (!goal) return 0
  const cutoff = new Date(now.getTime() - goal.item_retention_days * 86_400_000).toISOString()
  return db.prepare(`
    UPDATE tasks SET archived_at = ?
    WHERE plan_id = ? AND archived_at IS NULL AND status IN ('completed', 'abandoned') AND updated_at < ?
  `).run(now.toISOString(), planId, cutoff).changes
}

// ── Scheduler decisions ───────────────────────────────────────────────────────

/** True if `date` (local time) falls inside "HH:MM-HH:MM"; windows may wrap past midnight. */
export function withinActiveHours(activeHours: string | undefined, date: Date): boolean {
  if (!activeHours) return true
  const [start, end] = activeHours.split('-').map((s) => {
    const [h, m] = s.split(':').map(Number)
    return h * 60 + m
  })
  const minutes = date.getHours() * 60 + date.getMinutes()
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

export type TickDecision =
  | { action: 'none' }
  /** Due but outside active hours: move next_run_at forward without recording anything. */
  | { action: 'defer'; next_run_at: string }
  | { action: 'skip'; trigger: TriggerKind; reason: string; queuedRunId?: string }
  | { action: 'start'; trigger: TriggerKind; queuedRunId?: string }

/** Decides what the scheduler should do for one goal right now. */
export function decideTick(db: Database, planId: string, now: Date = new Date()): TickDecision {
  const goal = getGoal(db, planId)
  if (!goal || goal.status !== 'active') return { action: 'none' }

  const open = getOpenRun(db, planId)
  if (open?.status === 'running') return { action: 'none' }

  const schedule = getSchedule(db, planId)
  const queued = open?.status === 'queued' ? open : undefined
  const scheduleDue = Boolean(schedule && goal.next_run_at && goal.next_run_at <= now.toISOString())
  if (!queued && !scheduleDue) return { action: 'none' }

  if (!queued && schedule?.kind === 'interval' && !withinActiveHours(schedule.active_hours, now)) {
    return { action: 'defer', next_run_at: new Date(now.getTime() + schedule.minutes * 60_000).toISOString() }
  }

  const kind: TriggerKind = queued ? queued.trigger : schedule!.kind
  const runsToday = countRunsSince(db, planId, new Date(now.getTime() - 86_400_000).toISOString())
    - (queued ? 1 : 0) // a queued run is counted already
  if (runsToday >= goal.limits.max_runs_per_day) {
    return { action: 'skip', trigger: kind, reason: `daily run limit reached (${goal.limits.max_runs_per_day})`, queuedRunId: queued?.id }
  }
  return { action: 'start', trigger: kind, queuedRunId: queued?.id }
}

/** next_run_at after a run starts (or is skipped), from the goal's interval or cron schedule; null for manual-only goals. */
export function nextIntervalRun(db: Database, planId: string, from: Date = new Date()): string | null {
  return nextScheduledRun(db, planId, from)
}

/** Records a skipped run, at most once per hour per reason, so the timeline stays readable. */
export function recordSkip(db: Database, planId: string, trigger: TriggerKind, reason: string, now: Date = new Date()): GoalRun | null {
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString()
  const recent = db.prepare("SELECT 1 FROM goal_runs WHERE plan_id = ? AND status = 'skipped' AND skip_reason = ? AND started_at >= ?")
    .get(planId, reason, hourAgo)
  return recent ? null : insertRun(db, planId, trigger, 'skipped', reason)
}
