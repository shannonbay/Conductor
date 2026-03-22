import Database from 'better-sqlite3'
import os from 'os'
import path from 'path'
import { mkdirSync } from 'fs'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProjectRow {
  id: string
  name: string
  description: string | null
  status: string
  focus_task_id: string | null
  created_at: string
  updated_at: string
}

export interface TaskRow {
  id: string
  project_id: string
  goal: string
  plan: string       // JSON string[]
  step: number
  status: string
  result: string | null
  abandon_reason: string | null
  state: string      // JSON object
  depends_on: string | null  // JSON string[] | null
  created_at: string
  updated_at: string
}

export interface Task {
  id: string
  project_id: string
  goal: string
  plan: string[]
  step: number
  status: string
  result: string | null
  abandon_reason: string | null
  state: Record<string, unknown>
  depends_on: string[] | null
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

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  focus_task_id TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT NOT NULL,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  goal           TEXT NOT NULL,
  plan           TEXT NOT NULL,
  step           INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active',
  result         TEXT,
  abandon_reason TEXT,
  state          TEXT NOT NULL DEFAULT '{}',
  depends_on     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_project    ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_projects_status  ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);
`)

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseTask(row: TaskRow): Task {
  return {
    ...row,
    plan: JSON.parse(row.plan) as string[],
    state: JSON.parse(row.state) as Record<string, unknown>,
    depends_on: row.depends_on ? JSON.parse(row.depends_on) as string[] : null,
  }
}

export function getProject(id: string): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
}

export function getTask(projectId: string, taskId: string): Task | undefined {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND project_id = ?').get(taskId, projectId) as TaskRow | undefined
  return row ? parseTask(row) : undefined
}

export function getChildren(projectId: string, parentId: string): Task[] {
  const prefix = parentId + '.'
  const depth = parentId.split('.').length + 1
  const rows = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id LIKE ?").all(projectId, prefix + '%') as TaskRow[]
  return rows
    .filter(r => r.id.split('.').length === depth)
    .map(parseTask)
}

export function getSiblings(projectId: string, taskId: string): Task[] {
  const segments = taskId.split('.')
  if (segments.length === 1) {
    // Root-level siblings: other tasks with no dot in id
    const rows = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id != ? AND id NOT LIKE '%.%'").all(projectId, taskId) as TaskRow[]
    return rows.map(parseTask)
  }
  const parentId = segments.slice(0, -1).join('.')
  return getChildren(projectId, parentId).filter(t => t.id !== taskId)
}

export function getTreeStats(projectId: string): TreeStats {
  const rows = db.prepare('SELECT status, COUNT(*) as count FROM tasks WHERE project_id = ? GROUP BY status').all(projectId) as { status: string; count: number }[]
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

export function nextChildId(projectId: string, parentId: string): string {
  const count = (db.prepare("SELECT COUNT(*) as count FROM tasks WHERE project_id = ? AND id LIKE ?").get(projectId, parentId + '.%') as { count: number }).count
  // Filter to direct children only (one level deeper)
  const directChildren = getChildren(projectId, parentId)
  return parentId + '.' + (directChildren.length + 1)
}

export function touchProject(projectId: string): void {
  db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), projectId)
}

export function listProjects(status: 'active' | 'archived' | 'all'): ProjectRow[] {
  if (status === 'all') {
    return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as ProjectRow[]
  }
  return db.prepare('SELECT * FROM projects WHERE status = ? ORDER BY updated_at DESC').all(status) as ProjectRow[]
}

export function insertProject(project: ProjectRow): void {
  db.prepare(`
    INSERT INTO projects (id, name, description, status, focus_task_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(project.id, project.name, project.description, project.status, project.focus_task_id, project.created_at, project.updated_at)
}

export function updateProject(id: string, fields: Partial<Omit<ProjectRow, 'id'>>): void {
  const entries = Object.entries(fields)
  if (entries.length === 0) return
  const sets = entries.map(([k]) => `${k} = ?`).join(', ')
  const values = entries.map(([, v]) => v)
  db.prepare(`UPDATE projects SET ${sets} WHERE id = ?`).run(...values, id)
}

export function insertTask(task: Task): void {
  db.prepare(`
    INSERT INTO tasks (id, project_id, goal, plan, step, status, result, abandon_reason, state, depends_on, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.project_id,
    task.goal,
    JSON.stringify(task.plan),
    task.step,
    task.status,
    task.result,
    task.abandon_reason,
    JSON.stringify(task.state),
    task.depends_on ? JSON.stringify(task.depends_on) : null,
    task.created_at,
    task.updated_at,
  )
}

export function updateTask(projectId: string, taskId: string, fields: Partial<Omit<Task, 'id' | 'project_id'>>): void {
  const serialized: Record<string, unknown> = { ...fields }
  if ('plan' in serialized) serialized.plan = JSON.stringify(serialized.plan)
  if ('state' in serialized) serialized.state = JSON.stringify(serialized.state)
  if ('depends_on' in serialized) serialized.depends_on = serialized.depends_on ? JSON.stringify(serialized.depends_on) : null

  const entries = Object.entries(serialized)
  if (entries.length === 0) return
  const sets = entries.map(([k]) => `${k} = ?`).join(', ')
  const values = entries.map(([, v]) => v)
  db.prepare(`UPDATE tasks SET ${sets} WHERE id = ? AND project_id = ?`).run(...values, taskId, projectId)
}

export function countAllTasks(projectId: string): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE project_id = ?').get(projectId) as { count: number }
  return row.count
}

export function clearAllData(): void {
  db.exec('DELETE FROM tasks; DELETE FROM projects;')
}
