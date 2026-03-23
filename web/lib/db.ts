import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { runMigrations } from './migrate'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProjectRow {
  id: string
  name: string
  description: string | null
  status: 'active' | 'archived'
  working_dir: string
  focus_task_id: string | null
  created_at: string
  updated_at: string
}

export interface Task {
  id: string
  project_id: string
  goal: string
  plan: string[]
  step: number
  status: 'active' | 'pending' | 'completed' | 'abandoned'
  result: string | null
  abandon_reason: string | null
  state: Record<string, unknown>
  depends_on: string[] | null
  locked_by: string | null
  locked_at: string | null
  requires_approval: boolean
  approved_by: string | null
  approved_at: string | null
  created_by: 'human' | 'agent'
  assigned_to: 'human' | 'agent' | null
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

export interface TreeNode extends Task {
  children: TreeNode[]
}

export interface AgentSession {
  id: string
  project_id: string
  root_task_id: string
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  autonomy_level: 'full' | 'approve_decompositions' | 'approve_steps' | 'manual'
  model: string
  input_tokens: number
  output_tokens: number
  total_cost: number
  error: string | null
  started_at: string
  ended_at: string | null
}

export interface Event {
  id: string
  project_id: string
  task_id: string
  event_type: string
  actor: 'human' | 'agent'
  session_id: string | null
  payload: Record<string, unknown>
  created_at: string
}

// ─── DB singleton ─────────────────────────────────────────────────────────────

function getDbPath(): string {
  const envPath = process.env.CONDUCTOR_DB
  if (envPath) return envPath
  return join(homedir(), '.conductor', 'tasks.db')
}

let _db: ReturnType<typeof Database> | null = null

export function getDb(): ReturnType<typeof Database> {
  if (!_db) {
    const dbPath = getDbPath()
    if (dbPath !== ':memory:') {
      mkdirSync(join(dbPath, '..'), { recursive: true })
    }
    _db = new Database(dbPath)
    _db.pragma('journal_mode = WAL')
    _db.pragma('foreign_keys = ON')
    runMigrations(_db)
  }
  return _db
}

/** Reset the singleton — used in tests to get a fresh connection after clearAllData */
export function resetDb(): void {
  _db = null
}

// ─── Serialization helpers ────────────────────────────────────────────────────

function deserializeTask(row: Record<string, unknown>): Task {
  return {
    ...row,
    plan: JSON.parse(row.plan as string),
    state: JSON.parse(row.state as string),
    depends_on: row.depends_on ? JSON.parse(row.depends_on as string) : null,
    requires_approval: Boolean(row.requires_approval),
  } as Task
}

// ─── Projects ─────────────────────────────────────────────────────────────────

export function listProjects(status: 'active' | 'archived' | 'all' = 'active'): ProjectRow[] {
  const db = getDb()
  if (status === 'all') {
    return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as ProjectRow[]
  }
  return db.prepare('SELECT * FROM projects WHERE status = ? ORDER BY updated_at DESC').all(status) as ProjectRow[]
}

export function getProject(id: string): ProjectRow | undefined {
  const db = getDb()
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
}

export function insertProject(project: ProjectRow): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO projects (id, name, description, status, working_dir, focus_task_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(project.id, project.name, project.description, project.status, project.working_dir, project.focus_task_id, project.created_at, project.updated_at)
}

export function updateProject(id: string, fields: Partial<Omit<ProjectRow, 'id'>>): void {
  const db = getDb()
  const entries = Object.entries(fields)
  if (entries.length === 0) return
  const setClauses = entries.map(([k]) => `${k} = ?`).join(', ')
  db.prepare(`UPDATE projects SET ${setClauses} WHERE id = ?`).run(...entries.map(([, v]) => v), id)
}

export function touchProject(id: string): void {
  updateProject(id, { updated_at: new Date().toISOString() })
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

export function getTask(projectId: string, taskId: string): Task | undefined {
  const db = getDb()
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND project_id = ?').get(taskId, projectId) as Record<string, unknown> | undefined
  return row ? deserializeTask(row) : undefined
}

export function getChildren(projectId: string, parentId: string): Task[] {
  const db = getDb()
  const prefix = parentId === '' ? '' : `${parentId}.`
  const pattern = `${prefix}%`
  const parentDepth = parentId === '' ? 0 : parentId.split('.').length
  const rows = db.prepare('SELECT * FROM tasks WHERE project_id = ? AND id LIKE ?').all(projectId, pattern) as Record<string, unknown>[]
  return rows
    .filter((r) => (r.id as string).split('.').length === parentDepth + 1)
    .map(deserializeTask)
}

export function getSiblings(projectId: string, taskId: string): Task[] {
  const db = getDb()
  const parts = taskId.split('.')
  const parentId = parts.length === 1 ? null : parts.slice(0, -1).join('.')
  let rows: Record<string, unknown>[]
  if (!parentId) {
    rows = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id NOT LIKE '%.%' AND id != ?").all(projectId, taskId) as Record<string, unknown>[]
  } else {
    rows = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id LIKE ? AND id NOT LIKE ? AND id != ?")
      .all(projectId, `${parentId}.%`, `${parentId}.%.%`, taskId) as Record<string, unknown>[]
  }
  return rows.map(deserializeTask)
}

export function getTreeStats(projectId: string): TreeStats {
  const db = getDb()
  const rows = db.prepare('SELECT status, COUNT(*) as count FROM tasks WHERE project_id = ? GROUP BY status').all(projectId) as { status: string; count: number }[]
  const map: Record<string, number> = {}
  for (const row of rows) map[row.status] = row.count
  return {
    total_tasks: Object.values(map).reduce((a, b) => a + b, 0),
    active: map['active'] ?? 0,
    completed: map['completed'] ?? 0,
    pending: map['pending'] ?? 0,
    abandoned: map['abandoned'] ?? 0,
  }
}

export function nextChildId(projectId: string, parentId: string | null): string {
  const db = getDb()
  if (!parentId) {
    const row = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE project_id = ? AND id NOT LIKE '%.%'").get(projectId) as { count: number }
    return String(row.count + 1)
  }
  const row = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE project_id = ? AND id LIKE ? AND id NOT LIKE ?')
    .get(projectId, `${parentId}.%`, `${parentId}.%.%`) as { count: number }
  return `${parentId}.${row.count + 1}`
}

export function countAllTasks(projectId: string): number {
  const db = getDb()
  const row = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE project_id = ?').get(projectId) as { count: number }
  return row.count
}

export function insertTask(task: Omit<Task, 'locked_by' | 'locked_at' | 'requires_approval' | 'approved_by' | 'approved_at' | 'created_by' | 'assigned_to' | 'notes'> & Partial<Pick<Task, 'locked_by' | 'locked_at' | 'requires_approval' | 'approved_by' | 'approved_at' | 'created_by' | 'assigned_to' | 'notes'>>): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO tasks (
      id, project_id, goal, plan, step, status, result, abandon_reason,
      state, depends_on, locked_by, locked_at, requires_approval,
      approved_by, approved_at, created_by, assigned_to, notes,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?
    )
  `).run(
    task.id,
    task.project_id,
    task.goal,
    JSON.stringify(task.plan),
    task.step,
    task.status,
    task.result ?? null,
    task.abandon_reason ?? null,
    JSON.stringify(task.state),
    task.depends_on ? JSON.stringify(task.depends_on) : null,
    task.locked_by ?? null,
    task.locked_at ?? null,
    task.requires_approval ? 1 : 0,
    task.approved_by ?? null,
    task.approved_at ?? null,
    task.created_by ?? 'human',
    task.assigned_to ?? null,
    task.notes ?? null,
    task.created_at,
    task.updated_at,
  )
}

export function updateTask(projectId: string, taskId: string, fields: Partial<Task>): void {
  const db = getDb()
  const serialized: Record<string, unknown> = { ...fields }
  if ('plan' in fields) serialized['plan'] = JSON.stringify(fields.plan)
  if ('state' in fields) serialized['state'] = JSON.stringify(fields.state)
  if ('depends_on' in fields) serialized['depends_on'] = fields.depends_on ? JSON.stringify(fields.depends_on) : null
  if ('requires_approval' in fields) serialized['requires_approval'] = fields.requires_approval ? 1 : 0
  const entries = Object.entries(serialized)
  if (entries.length === 0) return
  const setClauses = entries.map(([k]) => `${k} = ?`).join(', ')
  db.prepare(`UPDATE tasks SET ${setClauses} WHERE id = ? AND project_id = ?`).run(...entries.map(([, v]) => v), taskId, projectId)
}

// ─── UI-specific task operations ──────────────────────────────────────────────

/**
 * Returns all tasks for a project as a nested tree structure.
 * Root tasks are tasks whose ID has no dots (e.g. "1").
 */
export function getFullTree(projectId: string): TreeNode[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY id').all(projectId) as Record<string, unknown>[]
  const tasks = rows.map(deserializeTask)

  const byId = new Map<string, TreeNode>()
  for (const t of tasks) byId.set(t.id, { ...t, children: [] })

  const roots: TreeNode[] = []
  for (const node of byId.values()) {
    const parts = node.id.split('.')
    if (parts.length === 1) {
      roots.push(node)
    } else {
      const parentId = parts.slice(0, -1).join('.')
      const parent = byId.get(parentId)
      if (parent) parent.children.push(node)
    }
  }
  return roots
}

/**
 * Deletes a task and all its descendants (LIKE prefix query).
 */
export function deleteTaskTree(projectId: string, taskId: string): void {
  const db = getDb()
  db.prepare("DELETE FROM tasks WHERE project_id = ? AND (id = ? OR id LIKE ?)").run(projectId, taskId, `${taskId}.%`)
}

/**
 * Acquires write locks on a task and all its descendants for the given session.
 */
export function lockSubtree(sessionId: string, projectId: string, rootTaskId: string): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare("UPDATE tasks SET locked_by = ?, locked_at = ? WHERE project_id = ? AND (id = ? OR id LIKE ?)")
    .run(sessionId, now, projectId, rootTaskId, `${rootTaskId}.%`)
}

/**
 * Releases write locks held by the given session.
 */
export function unlockSubtree(sessionId: string, projectId: string): void {
  const db = getDb()
  db.prepare("UPDATE tasks SET locked_by = NULL, locked_at = NULL WHERE project_id = ? AND locked_by = ?")
    .run(projectId, sessionId)
}

// ─── Agent sessions ───────────────────────────────────────────────────────────

export function createSession(session: Omit<AgentSession, 'input_tokens' | 'output_tokens' | 'total_cost' | 'error' | 'ended_at'> & Partial<Pick<AgentSession, 'input_tokens' | 'output_tokens' | 'total_cost' | 'error' | 'ended_at'>>): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO agent_sessions (id, project_id, root_task_id, status, autonomy_level, model, input_tokens, output_tokens, total_cost, error, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.id,
    session.project_id,
    session.root_task_id,
    session.status,
    session.autonomy_level,
    session.model,
    session.input_tokens ?? 0,
    session.output_tokens ?? 0,
    session.total_cost ?? 0,
    session.error ?? null,
    session.started_at,
    session.ended_at ?? null,
  )
}

export function updateSession(id: string, fields: Partial<AgentSession>): void {
  const db = getDb()
  const entries = Object.entries(fields)
  if (entries.length === 0) return
  const setClauses = entries.map(([k]) => `${k} = ?`).join(', ')
  db.prepare(`UPDATE agent_sessions SET ${setClauses} WHERE id = ?`).run(...entries.map(([, v]) => v), id)
}

export function getActiveSession(projectId: string): AgentSession | undefined {
  const db = getDb()
  return db.prepare("SELECT * FROM agent_sessions WHERE project_id = ? AND status IN ('running', 'paused') ORDER BY started_at DESC LIMIT 1")
    .get(projectId) as AgentSession | undefined
}

export function getSession(id: string): AgentSession | undefined {
  const db = getDb()
  return db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as AgentSession | undefined
}

// ─── Event log ────────────────────────────────────────────────────────────────

export function insertEvent(event: Omit<Event, 'created_at'> & { created_at?: string }): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO events (id, project_id, task_id, event_type, actor, session_id, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.project_id,
    event.task_id,
    event.event_type,
    event.actor,
    event.session_id ?? null,
    JSON.stringify(event.payload),
    event.created_at ?? new Date().toISOString(),
  )
}

export function getEvents(projectId: string, taskId?: string): Event[] {
  const db = getDb()
  let rows: Record<string, unknown>[]
  if (taskId) {
    rows = db.prepare('SELECT * FROM events WHERE project_id = ? AND task_id = ? ORDER BY created_at DESC').all(projectId, taskId) as Record<string, unknown>[]
  } else {
    rows = db.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Record<string, unknown>[]
  }
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload as string) } as Event))
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

export function clearAllData(): void {
  const db = getDb()
  db.exec('DELETE FROM events; DELETE FROM agent_sessions; DELETE FROM tasks; DELETE FROM projects;')
}
