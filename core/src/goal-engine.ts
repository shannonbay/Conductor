/**
 * Persistent goals — behaviour: work items, the run brief, run lifecycle,
 * retention, and the scheduler's decisions. Storage lives in goals.ts.
 */
import type { Database } from 'better-sqlite3'
import { getPlan, getTask, insertTask, nextChildId, compareTaskIds, deserializeTask } from './queries.js'
import { isProposal } from './gates.js'
import {
  countRunsSince, getGoal, getIntervalTrigger, getOpenRun, getRun, insertRun, listMemory, listRuns, updateMemory, updateRun, updateGoal,
} from './goals.js'
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
}

export interface AddItemResult {
  task: Task
  /** True when an item with this external_ref already existed (it is returned unchanged). */
  existing: boolean
  /** The autonomy mode applied to the item's action, if any. */
  mode?: AutonomyMode
}

/**
 * Adds a work item to a goal. Deduplicates by external_ref (including archived
 * items), enforces the per-run item cap, and applies the goal's autonomy:
 *   off     → refused
 *   propose → item waits for human approval (requires_approval, review requested now)
 *   auto    → item recorded as already done (the agent has taken the action)
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
    insertTask(db, { ...base, status: input.status ?? 'pending', state: {} })
    return { task: getTask(db, planId, id)!, existing: false }
  }

  const mode = autonomyFor(goal, input.action.category)
  if (mode === 'off') {
    throw new GoalError(`Action category "${input.action.category}" is off for this goal: don't take or propose this action.`)
  }
  const state = { action: { ...input.action, params: input.action.params ?? {} } }
  if (mode === 'propose') {
    insertTask(db, { ...base, status: 'active', state, requires_approval: true, review_requested_at: now })
  } else {
    insertTask(db, { ...base, status: 'completed', state, result: input.result ?? `Done automatically: ${input.action.summary}` })
  }
  return { task: getTask(db, planId, id)!, existing: false, mode }
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
  run: { id: string; trigger: TriggerKind; started_at: string; limits: Goal['limits'] } | null
  autonomy: { default: 'propose'; categories: Record<string, AutonomyMode> }
  memory: { id: string; kind: string; text: string; source: string; pinned: boolean }[]
  memory_omitted: number
  decisions_since_last_run: {
    item: string; goal: string; decision: 'approved' | 'rejected' | 'completed_by_human'; feedback?: string; action?: ProposedAction; at: string
  }[]
  open_items: ItemSummary[]
  recent_runs: { at: string; summary: string }[]
  counts: { open: number; awaiting_review: number; approved_to_execute: number; resolved_last_24h: number }
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

  const dayAgo = new Date(Date.now() - 86_400_000).toISOString()
  const resolved24h = (db.prepare("SELECT COUNT(*) n FROM tasks WHERE plan_id = ? AND status IN ('completed', 'abandoned') AND updated_at >= ?").get(planId, dayAgo) as { n: number }).n

  return {
    goal: { id: planId, name: plan.name, objective: goal.objective, instructions: goal.instructions, status: goal.status },
    run: run ? { id: run.id, trigger: run.trigger, started_at: run.started_at, limits: goal.limits } : null,
    autonomy: { default: 'propose', categories: goal.autonomy },
    memory: memory.map((m) => ({ id: m.id, kind: m.kind, text: m.text, source: m.source, pinned: m.pinned })),
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

/** Finishes a run with the agent's summary, counts its items, and archives old resolved items. */
export function endRun(db: Database, runId: string, summary: string): GoalRun {
  const run = getRun(db, runId)
  if (!run) throw new GoalError(`Run ${runId} not found.`)
  if (run.status !== 'running' && run.status !== 'queued') throw new GoalError(`Run ${runId} already ended (${run.status}).`)
  if (!summary.trim()) throw new GoalError('A summary is required: what you did, what is waiting, what you learned.')
  const now = new Date().toISOString()
  const created = (db.prepare('SELECT COUNT(*) n FROM tasks WHERE plan_id = ? AND run_id = ?').get(run.plan_id, runId) as { n: number }).n
  const resolved = (db.prepare("SELECT COUNT(*) n FROM tasks WHERE plan_id = ? AND status IN ('completed', 'abandoned') AND updated_at >= ?")
    .get(run.plan_id, run.started_at) as { n: number }).n
  updateRun(db, runId, { status: 'completed', summary: summary.trim(), ended_at: now, items_created: created, items_resolved: resolved })
  archiveResolved(db, run.plan_id)
  return getRun(db, runId)!
}

/** Marks a run failed or timed out; partial work stays. No-op if it already ended. */
export function failRun(db: Database, runId: string, status: 'failed' | 'timed_out', reason: string): void {
  const run = getRun(db, runId)
  if (!run || (run.status !== 'running' && run.status !== 'queued')) return
  updateRun(db, runId, { status, ended_at: new Date().toISOString(), summary: run.summary ?? reason })
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

/** Decides what the scheduler should do for one goal right now (channel state is checked by the caller). */
export function decideTick(db: Database, planId: string, now: Date = new Date()): TickDecision {
  const goal = getGoal(db, planId)
  if (!goal || goal.status !== 'active') return { action: 'none' }

  const open = getOpenRun(db, planId)
  if (open?.status === 'running') return { action: 'none' }

  const trigger = getIntervalTrigger(db, planId)
  const queued = open?.status === 'queued' ? open : undefined
  const intervalDue = Boolean(trigger?.enabled && goal.next_run_at && goal.next_run_at <= now.toISOString())
  if (!queued && !intervalDue) return { action: 'none' }

  if (!queued && trigger && !withinActiveHours(trigger.config.active_hours, now)) {
    return { action: 'defer', next_run_at: new Date(now.getTime() + trigger.config.minutes * 60_000).toISOString() }
  }

  const kind: TriggerKind = queued ? queued.trigger : 'interval'
  const runsToday = countRunsSince(db, planId, new Date(now.getTime() - 86_400_000).toISOString())
    - (queued ? 1 : 0) // a queued run is counted already
  if (runsToday >= goal.limits.max_runs_per_day) {
    return { action: 'skip', trigger: kind, reason: `daily run limit reached (${goal.limits.max_runs_per_day})`, queuedRunId: queued?.id }
  }
  return { action: 'start', trigger: kind, queuedRunId: queued?.id }
}

/** next_run_at after a run starts (or is skipped) for an interval goal; null for manual-only goals. */
export function nextIntervalRun(db: Database, planId: string, from: Date = new Date()): string | null {
  const trigger = getIntervalTrigger(db, planId)
  return trigger?.enabled ? new Date(from.getTime() + trigger.config.minutes * 60_000).toISOString() : null
}

/** Records a skipped run, at most once per hour per reason, so the timeline stays readable. */
export function recordSkip(db: Database, planId: string, trigger: TriggerKind, reason: string, now: Date = new Date()): GoalRun | null {
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString()
  const recent = db.prepare("SELECT 1 FROM goal_runs WHERE plan_id = ? AND status = 'skipped' AND skip_reason = ? AND started_at >= ?")
    .get(planId, reason, hourAgo)
  return recent ? null : insertRun(db, planId, trigger, 'skipped', reason)
}
