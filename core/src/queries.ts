import type { Database } from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type {
  Event, GateKind, NewEvent, NewPlan, NewTask, NewVerification, PlanRow, Task, TreeStats, Verification,
} from './types.js'

type Row = Record<string, unknown>

export function deserializeTask(row: Row): Task {
  return {
    ...row,
    state: JSON.parse(row.state as string),
    depends_on: row.depends_on ? JSON.parse(row.depends_on as string) : null,
    notes: (row.notes as string | null | undefined) ?? null,
    requires_approval: Boolean(row.requires_approval),
    acceptance_criteria: row.acceptance_criteria ? JSON.parse(row.acceptance_criteria as string) : null,
    verify_command: (row.verify_command as string | null | undefined) ?? null,
    verify_timeout_s: (row.verify_timeout_s as number | null | undefined) ?? null,
    review_requested_at: (row.review_requested_at as string | null | undefined) ?? null,
  } as Task
}

/** Builds `SET a = ?, b = ?` from a fields object. Keys are column names from typed callers. */
function setClause(fields: Row): { sql: string; values: unknown[] } {
  const entries = Object.entries(fields)
  return {
    sql: entries.map(([k]) => `${k} = ?`).join(', '),
    values: entries.map(([, v]) => v),
  }
}

// ── Plans ─────────────────────────────────────────────────────────────────────

export function listPlans(db: Database, status: 'active' | 'archived' | 'all' = 'active'): PlanRow[] {
  if (status === 'all') {
    return db.prepare('SELECT * FROM plans ORDER BY updated_at DESC').all() as PlanRow[]
  }
  return db.prepare('SELECT * FROM plans WHERE status = ? ORDER BY updated_at DESC').all(status) as PlanRow[]
}

export function getPlan(db: Database, id: string): PlanRow | undefined {
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined
}

export function getPlanRevision(db: Database, id: string): number | undefined {
  const row = db.prepare('SELECT revision FROM plans WHERE id = ?').get(id) as { revision: number } | undefined
  return row?.revision
}

export function insertPlan(db: Database, plan: NewPlan): void {
  db.prepare(`
    INSERT INTO plans (id, name, description, status, working_dir, focus_task_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(plan.id, plan.name, plan.description, plan.status, plan.working_dir, plan.focus_task_id ?? null, plan.created_at, plan.updated_at)
}

export function updatePlan(db: Database, id: string, fields: Partial<Omit<PlanRow, 'id' | 'revision'>>): void {
  const { sql, values } = setClause(fields)
  if (!sql) return
  db.prepare(`UPDATE plans SET ${sql} WHERE id = ?`).run(...values, id)
}

export function touchPlan(db: Database, id: string): void {
  updatePlan(db, id, { updated_at: new Date().toISOString() })
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export function getTask(db: Database, planId: string, taskId: string): Task | undefined {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND plan_id = ?').get(taskId, planId) as Row | undefined
  return row ? deserializeTask(row) : undefined
}

/** Orders task IDs as tree addresses: "1.2" < "1.10", parents before children. */
export function compareTaskIds(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return pa.length - pb.length
}

/** Every task in a plan, in tree order. */
export function getAllTasks(db: Database, planId: string): Task[] {
  const rows = db.prepare('SELECT * FROM tasks WHERE plan_id = ?').all(planId) as Row[]
  return rows.map(deserializeTask).sort((a, b) => compareTaskIds(a.id, b.id))
}

export function getRootTasks(db: Database, planId: string): Task[] {
  const rows = db.prepare("SELECT * FROM tasks WHERE plan_id = ? AND id NOT LIKE '%.%'").all(planId) as Row[]
  return rows.map(deserializeTask)
}

/** Direct children of parentId. Pass '' for root tasks. */
export function getChildren(db: Database, planId: string, parentId: string): Task[] {
  if (parentId === '') return getRootTasks(db, planId)
  const rows = db.prepare('SELECT * FROM tasks WHERE plan_id = ? AND id LIKE ? AND id NOT LIKE ?')
    .all(planId, `${parentId}.%`, `${parentId}.%.%`) as Row[]
  return rows.map(deserializeTask)
}

export function getSiblings(db: Database, planId: string, taskId: string): Task[] {
  const parts = taskId.split('.')
  const parentId = parts.slice(0, -1).join('.')
  return getChildren(db, planId, parentId).filter((t) => t.id !== taskId)
}

export function getTreeStats(db: Database, planId: string): TreeStats {
  const rows = db.prepare('SELECT status, COUNT(*) as count FROM tasks WHERE plan_id = ? GROUP BY status')
    .all(planId) as { status: string; count: number }[]
  const by: Record<string, number> = {}
  for (const r of rows) by[r.status] = r.count
  return {
    total_tasks: rows.reduce((sum, r) => sum + r.count, 0),
    active: by.active ?? 0,
    completed: by.completed ?? 0,
    pending: by.pending ?? 0,
    abandoned: by.abandoned ?? 0,
  }
}

export function countAllTasks(db: Database, planId: string): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE plan_id = ?').get(planId) as { count: number }
  return row.count
}

/**
 * Next free child ID under parentId (null for a root task).
 * Uses max index + 1, not count + 1: deleted children leave gaps, and
 * count + 1 would then collide with an existing ID.
 */
export function nextChildId(db: Database, planId: string, parentId: string | null): string {
  const siblings = getChildren(db, planId, parentId ?? '')
  const maxIndex = siblings.reduce((max, t) => Math.max(max, Number(t.id.split('.').pop())), 0)
  return parentId ? `${parentId}.${maxIndex + 1}` : String(maxIndex + 1)
}

export function insertTask(db: Database, task: NewTask): void {
  db.prepare(`
    INSERT INTO tasks (
      id, plan_id, goal, status, result, abandon_reason, state, depends_on, notes,
      locked_by, locked_at, requires_approval, approved_by, approved_at, created_by, assigned_to,
      acceptance_criteria, verify_command, verify_timeout_s, review_requested_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.plan_id,
    task.goal,
    task.status,
    task.result ?? null,
    task.abandon_reason ?? null,
    JSON.stringify(task.state),
    task.depends_on ? JSON.stringify(task.depends_on) : null,
    task.notes ?? null,
    task.locked_by ?? null,
    task.locked_at ?? null,
    task.requires_approval ? 1 : 0,
    task.approved_by ?? null,
    task.approved_at ?? null,
    task.created_by ?? 'human',
    task.assigned_to ?? null,
    task.acceptance_criteria?.length ? JSON.stringify(task.acceptance_criteria) : null,
    task.verify_command ?? null,
    task.verify_timeout_s ?? null,
    task.review_requested_at ?? null,
    task.created_at,
    task.updated_at,
  )
}

export function updateTask(db: Database, planId: string, taskId: string, fields: Partial<Omit<Task, 'id' | 'plan_id'>>): void {
  const serialized: Row = { ...fields }
  if ('state' in fields) serialized.state = JSON.stringify(fields.state)
  if ('depends_on' in fields) serialized.depends_on = fields.depends_on ? JSON.stringify(fields.depends_on) : null
  if ('requires_approval' in fields) serialized.requires_approval = fields.requires_approval ? 1 : 0
  if ('acceptance_criteria' in fields) {
    serialized.acceptance_criteria = fields.acceptance_criteria?.length ? JSON.stringify(fields.acceptance_criteria) : null
  }
  const { sql, values } = setClause(serialized)
  if (!sql) return
  db.prepare(`UPDATE tasks SET ${sql} WHERE id = ? AND plan_id = ?`).run(...values, taskId, planId)
}

/** Deletes a task and all its descendants. */
export function deleteTaskTree(db: Database, planId: string, taskId: string): void {
  db.prepare('DELETE FROM tasks WHERE plan_id = ? AND (id = ? OR id LIKE ?)').run(planId, taskId, `${taskId}.%`)
}

// ── Event log ─────────────────────────────────────────────────────────────────

export function insertEvent(db: Database, event: NewEvent): void {
  db.prepare(`
    INSERT INTO events (id, plan_id, task_id, event_type, actor, session_id, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.plan_id,
    event.task_id,
    event.event_type,
    event.actor,
    event.session_id ?? null,
    JSON.stringify(event.payload),
    event.created_at ?? new Date().toISOString(),
  )
}

export interface EventQuery {
  /** Only events for this task (plus its descendants when subtree is true). */
  taskId?: string
  subtree?: boolean
  /** Newest N events. */
  limit?: number
}

/** Events for a plan, newest first. */
export function getEvents(db: Database, planId: string, query: EventQuery = {}): Event[] {
  const where = ['plan_id = ?']
  const params: unknown[] = [planId]
  if (query.taskId) {
    if (query.subtree) {
      where.push('(task_id = ? OR task_id LIKE ?)')
      params.push(query.taskId, `${query.taskId}.%`)
    } else {
      where.push('task_id = ?')
      params.push(query.taskId)
    }
  }
  const limit = query.limit && query.limit > 0 ? ` LIMIT ${Math.floor(query.limit)}` : ''
  const rows = db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC${limit}`)
    .all(...params) as Row[]
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload as string) } as Event))
}

// ── Verifications (gate evidence) ─────────────────────────────────────────────

export function insertVerification(db: Database, v: NewVerification): Verification {
  const row: Verification = {
    id: randomUUID(),
    command: null,
    exit_code: null,
    output: null,
    evidence: null,
    duration_ms: null,
    created_at: new Date().toISOString(),
    ...v,
  }
  db.prepare(`
    INSERT INTO verifications (id, plan_id, task_id, gate, passed, actor, command, exit_code, output, evidence, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.plan_id, row.task_id, row.gate, row.passed ? 1 : 0, row.actor,
    row.command, row.exit_code, row.output, row.evidence ? JSON.stringify(row.evidence) : null,
    row.duration_ms, row.created_at,
  )
  return row
}

function deserializeVerification(r: Row): Verification {
  return {
    ...r,
    passed: Boolean(r.passed),
    evidence: r.evidence ? JSON.parse(r.evidence as string) : null,
  } as Verification
}

/** A task's check results, newest first. */
export function getVerifications(db: Database, planId: string, taskId: string, limit = 50): Verification[] {
  const rows = db.prepare('SELECT * FROM verifications WHERE plan_id = ? AND task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(planId, taskId, limit) as Row[]
  return rows.map(deserializeVerification)
}

/** The most recent result for one gate of a task. */
export function getLatestVerification(db: Database, planId: string, taskId: string, gate: GateKind): Verification | undefined {
  const row = db.prepare('SELECT * FROM verifications WHERE plan_id = ? AND task_id = ? AND gate = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(planId, taskId, gate) as Row | undefined
  return row ? deserializeVerification(row) : undefined
}

// ── Test helpers ──────────────────────────────────────────────────────────────

export function clearAllData(db: Database): void {
  db.exec('DELETE FROM verifications; DELETE FROM transcript_messages; DELETE FROM events; DELETE FROM agent_sessions; DELETE FROM tasks; DELETE FROM plans;')
}
