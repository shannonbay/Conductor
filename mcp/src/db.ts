import Database from 'better-sqlite3'
import os from 'os'
import path from 'path'
import { mkdirSync } from 'fs'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PlanRow {
  id: string
  name: string
  description: string | null
  status: string
  working_dir: string
  focus_task_id: string | null
  created_at: string
  updated_at: string
}

export interface TaskRow {
  id: string
  plan_id: string
  goal: string
  status: string
  result: string | null
  abandon_reason: string | null
  state: string      // JSON object
  depends_on: string | null  // JSON string[] | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface Task {
  id: string
  plan_id: string
  goal: string
  status: string
  result: string | null
  abandon_reason: string | null
  state: Record<string, unknown>
  depends_on: string[] | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface TreeStats {
  total_tasks: number
  active: number
  completed: number
  pending: number
  abandoned: number
}

// ── DB init ───────────────────────────────────────────────────────────────────

const dbPath = process.env.CONDUCTOR_DB ?? path.join(os.homedir(), '.conductor', 'tasks.db')
mkdirSync(path.dirname(dbPath), { recursive: true })

const db = new Database(dbPath)

db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// Rename legacy tables for existing databases (idempotent)
try { db.exec('ALTER TABLE projects RENAME TO plans') } catch { /* already renamed */ }
try { db.exec('ALTER TABLE tasks RENAME COLUMN project_id TO plan_id') } catch { /* already renamed */ }

db.exec(`
CREATE TABLE IF NOT EXISTS plans (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  working_dir   TEXT,
  focus_task_id TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT NOT NULL,
  plan_id        TEXT NOT NULL REFERENCES plans(id),
  goal           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  result         TEXT,
  abandon_reason TEXT,
  state          TEXT NOT NULL DEFAULT '{}',
  depends_on     TEXT,
  notes          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (id, plan_id)
);

DROP INDEX IF EXISTS idx_tasks_project;
DROP INDEX IF EXISTS idx_projects_status;
DROP INDEX IF EXISTS idx_projects_updated;
CREATE INDEX IF NOT EXISTS idx_tasks_plan    ON tasks(plan_id);
CREATE INDEX IF NOT EXISTS idx_plans_status  ON plans(status);
CREATE INDEX IF NOT EXISTS idx_plans_updated ON plans(updated_at DESC);
`)

// Drop legacy columns from existing databases (SQLite 3.35+)
for (const col of ['plan', 'step']) {
  try { db.exec(`ALTER TABLE tasks DROP COLUMN ${col}`) } catch { /* already gone */ }
}

// Add columns introduced after initial schema (idempotent)
try { db.exec('ALTER TABLE tasks ADD COLUMN notes TEXT') } catch { /* already exists */ }

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseTask(row: TaskRow): Task {
  return {
    ...row,
    state: JSON.parse(row.state) as Record<string, unknown>,
    depends_on: row.depends_on ? JSON.parse(row.depends_on) as string[] : null,
    notes: row.notes ?? null,
  }
}

export function getPlan(id: string): PlanRow | undefined {
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined
}

export function getTask(planId: string, taskId: string): Task | undefined {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND plan_id = ?').get(taskId, planId) as TaskRow | undefined
  return row ? parseTask(row) : undefined
}

export function getChildren(planId: string, parentId: string): Task[] {
  const prefix = parentId + '.'
  const depth = parentId.split('.').length + 1
  const rows = db.prepare("SELECT * FROM tasks WHERE plan_id = ? AND id LIKE ?").all(planId, prefix + '%') as TaskRow[]
  return rows
    .filter(r => r.id.split('.').length === depth)
    .map(parseTask)
}

export function getSiblings(planId: string, taskId: string): Task[] {
  const segments = taskId.split('.')
  if (segments.length === 1) {
    // Root-level siblings: other tasks with no dot in id
    const rows = db.prepare("SELECT * FROM tasks WHERE plan_id = ? AND id != ? AND id NOT LIKE '%.%'").all(planId, taskId) as TaskRow[]
    return rows.map(parseTask)
  }
  const parentId = segments.slice(0, -1).join('.')
  return getChildren(planId, parentId).filter(t => t.id !== taskId)
}

export function getTreeStats(planId: string): TreeStats {
  const rows = db.prepare('SELECT status, COUNT(*) as count FROM tasks WHERE plan_id = ? GROUP BY status').all(planId) as { status: string; count: number }[]
  const stats: TreeStats = { total_tasks: 0, active: 0, completed: 0, pending: 0, abandoned: 0 }
  for (const row of rows) {
    stats.total_tasks += row.count
    if (row.status === 'active') stats.active = row.count
    else if (row.status === 'completed') stats.completed = row.count
    else if (row.status === 'pending') stats.pending = row.count
    else if (row.status === 'abandoned') stats.abandoned = row.count
  }
  return stats
}

export function nextChildId(planId: string, parentId: string): string {
  const count = (db.prepare("SELECT COUNT(*) as count FROM tasks WHERE plan_id = ? AND id LIKE ?").get(planId, parentId + '.%') as { count: number }).count
  // Filter to direct children only (one level deeper)
  const directChildren = getChildren(planId, parentId)
  return parentId + '.' + (directChildren.length + 1)
}

export function touchPlan(planId: string): void {
  db.prepare("UPDATE plans SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), planId)
}

export function listPlans(status: 'active' | 'archived' | 'all'): PlanRow[] {
  if (status === 'all') {
    return db.prepare('SELECT * FROM plans ORDER BY updated_at DESC').all() as PlanRow[]
  }
  return db.prepare('SELECT * FROM plans WHERE status = ? ORDER BY updated_at DESC').all(status) as PlanRow[]
}

export function insertPlan(plan: PlanRow): void {
  db.prepare(`
    INSERT INTO plans (id, name, description, status, working_dir, focus_task_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(plan.id, plan.name, plan.description, plan.status, plan.working_dir, plan.focus_task_id, plan.created_at, plan.updated_at)
}

export function updatePlan(id: string, fields: Partial<Omit<PlanRow, 'id'>>): void {
  const entries = Object.entries(fields)
  if (entries.length === 0) return
  const sets = entries.map(([k]) => `${k} = ?`).join(', ')
  const values = entries.map(([, v]) => v)
  db.prepare(`UPDATE plans SET ${sets} WHERE id = ?`).run(...values, id)
}

export function insertTask(task: Task): void {
  db.prepare(`
    INSERT INTO tasks (id, plan_id, goal, status, result, abandon_reason, state, depends_on, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.plan_id,
    task.goal,
    task.status,
    task.result,
    task.abandon_reason,
    JSON.stringify(task.state),
    task.depends_on ? JSON.stringify(task.depends_on) : null,
    task.notes ?? null,
    task.created_at,
    task.updated_at,
  )
}

export function updateTask(planId: string, taskId: string, fields: Partial<Omit<Task, 'id' | 'plan_id'>>): void {
  const serialized: Record<string, unknown> = { ...fields }
  if ('state' in serialized) serialized.state = JSON.stringify(serialized.state)
  if ('depends_on' in serialized) serialized.depends_on = serialized.depends_on ? JSON.stringify(serialized.depends_on) : null

  const entries = Object.entries(serialized)
  if (entries.length === 0) return
  const sets = entries.map(([k]) => `${k} = ?`).join(', ')
  const values = entries.map(([, v]) => v)
  db.prepare(`UPDATE tasks SET ${sets} WHERE id = ? AND plan_id = ?`).run(...values, taskId, planId)
}

export function countAllTasks(planId: string): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE plan_id = ?').get(planId) as { count: number }
  return row.count
}

export function getRootTasks(planId: string): Task[] {
  const rows = db.prepare("SELECT * FROM tasks WHERE plan_id = ? AND id NOT LIKE '%.%'").all(planId) as TaskRow[]
  return rows.map(parseTask)
}

export function clearAllData(): void {
  db.exec('DELETE FROM tasks; DELETE FROM plans;')
}

export function runTransaction<T>(fn: () => T): T {
  return db.transaction(fn)()
}
