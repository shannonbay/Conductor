/**
 * Persistent goals — storage. A goal is a plan with kind = 'goal' plus a row
 * in `goals`; its work items are ordinary tasks. See specs/persistent-goals.md.
 */
import type { Database } from './sqlite.js'
import { randomUUID } from 'crypto'
import { insertPlan, getPlan } from './queries.js'
import {
  DEFAULT_GOAL_LIMITS,
  type Goal, type GoalLimits, type GoalMemory, type GoalRun, type GoalTrigger, type IntervalConfig,
  type MemoryKind, type MemorySource, type NewGoal, type NewPlan, type PlanRow, type RunStatus, type TriggerKind,
} from './types.js'

type Row = Record<string, unknown>

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`

// ── Goals ─────────────────────────────────────────────────────────────────────

function deserializeGoal(r: Row): Goal {
  return {
    ...r,
    autonomy: JSON.parse((r.autonomy as string) || '{}'),
    limits: { ...DEFAULT_GOAL_LIMITS, ...JSON.parse((r.limits as string) || '{}') },
    tool_map: JSON.parse((r.tool_map as string) || '{}'),
    health_command: (r.health_command as string | null | undefined) ?? null,
    health_every_minutes: (r.health_every_minutes as number | undefined) ?? 60,
    health_triggers_run: r.health_triggers_run === undefined ? true : Boolean(r.health_triggers_run),
    last_health_at: (r.last_health_at as string | null | undefined) ?? null,
    one_off: Boolean(r.one_off),
  } as Goal
}

/** Creates the plan (kind 'goal') and its goal row together. */
export function createGoal(db: Database, plan: NewPlan, goal: Omit<NewGoal, 'plan_id'>, interval?: IntervalConfig): Goal {
  db.transaction(() => {
    insertPlan(db, { ...plan, kind: 'goal' })
    db.prepare(`
      INSERT INTO goals (plan_id, objective, instructions, status, autonomy, limits, item_retention_days, last_run_at, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      plan.id,
      goal.objective,
      goal.instructions ?? '',
      goal.status ?? 'active',
      JSON.stringify(goal.autonomy ?? {}),
      JSON.stringify({ ...DEFAULT_GOAL_LIMITS, ...goal.limits }),
      goal.item_retention_days ?? 7,
      null,
      interval ? new Date().toISOString() : null,
    )
    if (interval) setIntervalTrigger(db, plan.id, interval)
    if (goal.one_off) db.prepare('UPDATE goals SET one_off = 1 WHERE plan_id = ?').run(plan.id)
  })()
  return getGoal(db, plan.id)!
}

export function getGoal(db: Database, planId: string): Goal | undefined {
  const row = db.prepare('SELECT * FROM goals WHERE plan_id = ?').get(planId) as Row | undefined
  return row ? deserializeGoal(row) : undefined
}

export function listGoals(db: Database, status?: Goal['status']): { plan: PlanRow; goal: Goal }[] {
  const rows = (status
    ? db.prepare('SELECT * FROM goals WHERE status = ?').all(status)
    : db.prepare('SELECT * FROM goals').all()) as Row[]
  return rows
    .map((r) => ({ plan: getPlan(db, r.plan_id as string)!, goal: deserializeGoal(r) }))
    .filter((g) => g.plan)
}

export function updateGoal(
  db: Database,
  planId: string,
  fields: Partial<Omit<Goal, 'plan_id' | 'limits'>> & { limits?: Partial<GoalLimits> },
): void {
  const current = getGoal(db, planId)
  if (!current) throw new Error(`Goal ${planId} not found`)
  const serialized: Row = { ...fields }
  if (fields.autonomy) serialized.autonomy = JSON.stringify(fields.autonomy)
  if (fields.tool_map) serialized.tool_map = JSON.stringify(fields.tool_map)
  if ('health_triggers_run' in fields) serialized.health_triggers_run = fields.health_triggers_run ? 1 : 0
  if ('one_off' in fields) serialized.one_off = fields.one_off ? 1 : 0
  if (fields.limits) serialized.limits = JSON.stringify({ ...current.limits, ...fields.limits })
  const entries = Object.entries(serialized)
  if (!entries.length) return
  db.prepare(`UPDATE goals SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE plan_id = ?`)
    .run(...entries.map(([, v]) => v), planId)
}

// ── Triggers ──────────────────────────────────────────────────────────────────

function deserializeTrigger(r: Row): GoalTrigger {
  return { ...r, config: JSON.parse(r.config as string), enabled: Boolean(r.enabled) } as GoalTrigger
}

export function listTriggers(db: Database, planId: string): GoalTrigger[] {
  return (db.prepare('SELECT * FROM goal_triggers WHERE plan_id = ?').all(planId) as Row[]).map(deserializeTrigger)
}

export function getIntervalTrigger(db: Database, planId: string): (GoalTrigger & { config: IntervalConfig }) | undefined {
  return listTriggers(db, planId).find((t) => t.kind === 'interval') as (GoalTrigger & { config: IntervalConfig }) | undefined
}

/** Phase 1 has at most one interval trigger per goal; null removes it. */
export function setIntervalTrigger(db: Database, planId: string, config: IntervalConfig | null): void {
  const existing = getIntervalTrigger(db, planId)
  if (!config) {
    if (existing) db.prepare('DELETE FROM goal_triggers WHERE id = ?').run(existing.id)
    return
  }
  if (!(config.minutes >= 1)) throw new Error('Interval must be at least 1 minute.')
  if (config.active_hours && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(config.active_hours)) {
    throw new Error('active_hours must look like "08:00-20:00".')
  }
  if (existing) {
    db.prepare('UPDATE goal_triggers SET config = ?, enabled = 1 WHERE id = ?').run(JSON.stringify(config), existing.id)
  } else {
    db.prepare('INSERT INTO goal_triggers (id, plan_id, kind, config, enabled) VALUES (?, ?, ?, ?, 1)')
      .run(newId('trg'), planId, 'interval', JSON.stringify(config))
  }
}

// ── Runs ──────────────────────────────────────────────────────────────────────

export function insertRun(db: Database, planId: string, trigger: TriggerKind, status: RunStatus = 'queued', skipReason?: string): GoalRun {
  const now = new Date().toISOString()
  const run: GoalRun = {
    id: newId('run'), plan_id: planId, trigger, status, session_id: null, cc_session_id: null, holder: null, agent_id: null, summary: null,
    skip_reason: skipReason ?? null, items_created: 0, items_resolved: 0, started_at: now,
    ended_at: status === 'skipped' ? now : null,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, model: null,
  }
  db.prepare(`
    INSERT INTO goal_runs (id, plan_id, trigger, status, session_id, summary, skip_reason, items_created, items_resolved, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(run.id, run.plan_id, run.trigger, run.status, null, null, run.skip_reason, 0, 0, run.started_at, run.ended_at)
  return run
}

export function getRun(db: Database, runId: string): GoalRun | undefined {
  return db.prepare('SELECT * FROM goal_runs WHERE id = ?').get(runId) as GoalRun | undefined
}

export function updateRun(db: Database, runId: string, fields: Partial<Omit<GoalRun, 'id' | 'plan_id'>>): void {
  const entries = Object.entries(fields)
  if (!entries.length) return
  db.prepare(`UPDATE goal_runs SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...entries.map(([, v]) => v), runId)
}

/** Runs newest first. */
export function listRuns(db: Database, planId: string, limit = 20, opts: { includeSkipped?: boolean } = {}): GoalRun[] {
  const where = opts.includeSkipped === false ? "AND status != 'skipped'" : ''
  return db.prepare(`SELECT * FROM goal_runs WHERE plan_id = ? ${where} ORDER BY started_at DESC, rowid DESC LIMIT ?`)
    .all(planId, limit) as GoalRun[]
}

/** The queued or running run for a goal, if any. */
export function getOpenRun(db: Database, planId: string): GoalRun | undefined {
  return db.prepare("SELECT * FROM goal_runs WHERE plan_id = ? AND status IN ('queued', 'running') ORDER BY started_at LIMIT 1")
    .get(planId) as GoalRun | undefined
}

export function countRunsSince(db: Database, planId: string, sinceIso: string): number {
  return (db.prepare("SELECT COUNT(*) n FROM goal_runs WHERE plan_id = ? AND status != 'skipped' AND started_at >= ?")
    .get(planId, sinceIso) as { n: number }).n
}

// ── Memory ────────────────────────────────────────────────────────────────────

function deserializeMemory(r: Row): GoalMemory {
  return { ...r, pinned: Boolean(r.pinned), active: Boolean(r.active) } as GoalMemory
}

export function insertMemory(
  db: Database,
  m: { plan_id: string; kind: MemoryKind; text: string; source: MemorySource; source_ref?: string | null; pinned?: boolean },
): GoalMemory {
  const text = m.text.trim()
  if (!text) throw new Error('Memory text is required.')
  const row = {
    id: newId('mem'), plan_id: m.plan_id, kind: m.kind, text, source: m.source,
    source_ref: m.source_ref ?? null, pinned: m.pinned ? 1 : 0, active: 1,
    created_at: new Date().toISOString(), last_used_at: null,
  }
  db.prepare(`
    INSERT INTO goal_memory (id, plan_id, kind, text, source, source_ref, pinned, active, created_at, last_used_at)
    VALUES (@id, @plan_id, @kind, @text, @source, @source_ref, @pinned, @active, @created_at, @last_used_at)
  `).run(row)
  return deserializeMemory(row)
}

export function getMemory(db: Database, id: string): GoalMemory | undefined {
  const r = db.prepare('SELECT * FROM goal_memory WHERE id = ?').get(id) as Row | undefined
  return r ? deserializeMemory(r) : undefined
}

export function listMemory(db: Database, planId: string, opts: { activeOnly?: boolean } = {}): GoalMemory[] {
  const rows = db.prepare(`SELECT * FROM goal_memory WHERE plan_id = ? ${opts.activeOnly ? 'AND active = 1' : ''} ORDER BY created_at, rowid`)
    .all(planId) as Row[]
  return rows.map(deserializeMemory)
}

export function updateMemory(db: Database, id: string, fields: Partial<Pick<GoalMemory, 'kind' | 'text' | 'pinned' | 'active' | 'last_used_at'>>): void {
  const serialized: Row = { ...fields }
  if ('pinned' in fields) serialized.pinned = fields.pinned ? 1 : 0
  if ('active' in fields) serialized.active = fields.active ? 1 : 0
  if (typeof fields.text === 'string') {
    if (!fields.text.trim()) throw new Error('Memory text is required.')
    serialized.text = fields.text.trim()
  }
  const entries = Object.entries(serialized)
  if (!entries.length) return
  db.prepare(`UPDATE goal_memory SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...entries.map(([, v]) => v), id)
}

export function deleteMemory(db: Database, id: string): void {
  db.prepare('DELETE FROM goal_memory WHERE id = ?').run(id)
}

/** The tables that hold a goal's rows, children before the plan itself. */
const GOAL_TABLES = [
  'goal_tool_calls', 'goal_health', 'goal_memory', 'goal_runs', 'goal_triggers', 'verifications',
  'events', 'transcript_messages', 'agent_sessions', 'tasks', 'goals',
]

/**
 * Deletes a goal for good: its items, runs, memory, schedule, health checks,
 * guard decisions and history. Refused while a run is going (cancel it first).
 */
export function deleteGoal(db: Database, planId: string): { name: string } {
  const plan = db.prepare("SELECT name, kind FROM plans WHERE id = ?").get(planId) as { name: string; kind: string } | undefined
  if (!plan || plan.kind !== 'goal') throw new Error(`Goal ${planId} not found.`)
  const running = db.prepare("SELECT 1 FROM goal_runs WHERE plan_id = ? AND status IN ('queued', 'running')").get(planId)
  if (running) throw new Error('This goal has a run in progress: cancel it first, then delete the goal.')
  db.transaction(() => {
    for (const table of GOAL_TABLES) db.prepare(`DELETE FROM ${table} WHERE plan_id = ?`).run(planId)
    db.prepare('DELETE FROM plans WHERE id = ?').run(planId)
  })()
  return { name: plan.name }
}
