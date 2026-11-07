/**
 * Web database layer. Schema, migrations and the task/plan queries shared with
 * the MCP server live in @conductor/core; this file binds them to a lazily
 * opened connection and adds the UI-only queries (sessions, events, locks…).
 */
import * as core from '@conductor/core'
import { deserializeTask, type Event, type NewEvent, type NewPlan, type NewTask, type PlanRow, type Task } from '@conductor/core'

export type { Event, NewEvent, NewPlan, NewTask, PlanRow, Task, TreeStats } from '@conductor/core'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TreeNode extends Task {
  children: TreeNode[]
}

export interface AgentSession {
  id: string
  plan_id: string
  root_task_id: string
  nickname: string
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

export interface TranscriptMessage {
  id: string
  session_id: string
  plan_id: string
  role: 'user' | 'assistant'
  content: unknown[]
  turn_index: number
  created_at: string
}

// ─── DB singleton ─────────────────────────────────────────────────────────────

let _db: core.Database | null = null

export function getDb(): core.Database {
  if (!_db) _db = core.openDatabase()
  return _db
}

/** Reset the singleton — used in tests to get a fresh connection after clearAllData */
export function resetDb(): void {
  _db = null
}

// ─── Plans and tasks (shared with MCP via @conductor/core) ────────────────────

export const listPlans = (status: 'active' | 'archived' | 'all' = 'active') => core.listPlans(getDb(), status)
export const getPlan = (id: string) => core.getPlan(getDb(), id)
export const getPlanRevision = (id: string) => core.getPlanRevision(getDb(), id)
export const insertPlan = (plan: NewPlan) => core.insertPlan(getDb(), plan)
export const updatePlan = (id: string, fields: Partial<Omit<PlanRow, 'id' | 'revision'>>) => core.updatePlan(getDb(), id, fields)
export const touchPlan = (id: string) => core.touchPlan(getDb(), id)

export const getTask = (planId: string, taskId: string) => core.getTask(getDb(), planId, taskId)
export const getChildren = (planId: string, parentId: string) => core.getChildren(getDb(), planId, parentId)
export const getSiblings = (planId: string, taskId: string) => core.getSiblings(getDb(), planId, taskId)
export const getTreeStats = (planId: string) => core.getTreeStats(getDb(), planId)
export const nextChildId = (planId: string, parentId: string | null) => core.nextChildId(getDb(), planId, parentId)
export const countAllTasks = (planId: string) => core.countAllTasks(getDb(), planId)
export const insertTask = (task: NewTask) => core.insertTask(getDb(), task)
export const updateTask = (planId: string, taskId: string, fields: Partial<Task>) => core.updateTask(getDb(), planId, taskId, fields)
export const deleteTaskTree = (planId: string, taskId: string) => core.deleteTaskTree(getDb(), planId, taskId)

// ─── UI-specific task operations ──────────────────────────────────────────────

/**
 * Returns all tasks for a plan as a nested tree structure.
 * Root tasks are tasks whose ID has no dots (e.g. "1").
 */
export function getFullTree(planId: string): TreeNode[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM tasks WHERE plan_id = ? ORDER BY id').all(planId) as Record<string, unknown>[]
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

export function deletePlan(id: string): void {
  const db = getDb()
  // Delete in dependency order: events and sessions reference the plan via FK
  db.prepare('DELETE FROM events WHERE plan_id = ?').run(id)
  db.prepare('DELETE FROM agent_sessions WHERE plan_id = ?').run(id)
  db.prepare('DELETE FROM tasks WHERE plan_id = ?').run(id)
  db.prepare('DELETE FROM plans WHERE id = ?').run(id)
}

/**
 * Acquires write locks on a task and all its descendants for the given session.
 */
export function lockSubtree(sessionId: string, planId: string, rootTaskId: string): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare("UPDATE tasks SET locked_by = ?, locked_at = ? WHERE plan_id = ? AND (id = ? OR id LIKE ?)")
    .run(sessionId, now, planId, rootTaskId, `${rootTaskId}.%`)
}

/**
 * Releases write locks held by the given session.
 */
export function unlockSubtree(sessionId: string, planId: string): void {
  const db = getDb()
  db.prepare("UPDATE tasks SET locked_by = NULL, locked_at = NULL WHERE plan_id = ? AND locked_by = ?")
    .run(planId, sessionId)
}

// ─── Agent sessions ───────────────────────────────────────────────────────────

export function createSession(session: Omit<AgentSession, 'input_tokens' | 'output_tokens' | 'total_cost' | 'error' | 'ended_at'> & Partial<Pick<AgentSession, 'input_tokens' | 'output_tokens' | 'total_cost' | 'error' | 'ended_at'>>): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO agent_sessions (id, plan_id, root_task_id, nickname, status, autonomy_level, model, input_tokens, output_tokens, total_cost, error, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.id,
    session.plan_id,
    session.root_task_id,
    session.nickname ?? '',
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

export function getActiveSession(planId: string): AgentSession | undefined {
  const db = getDb()
  return db.prepare("SELECT * FROM agent_sessions WHERE plan_id = ? AND status IN ('running', 'paused') ORDER BY started_at DESC LIMIT 1")
    .get(planId) as AgentSession | undefined
}

export function getSession(id: string): AgentSession | undefined {
  const db = getDb()
  return db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as AgentSession | undefined
}

export function getAllActiveSessions(): AgentSession[] {
  const db = getDb()
  return db.prepare("SELECT * FROM agent_sessions WHERE status IN ('running', 'paused') ORDER BY started_at DESC").all() as AgentSession[]
}

// ─── Event log ────────────────────────────────────────────────────────────────

export const insertEvent = (event: NewEvent) => core.insertEvent(getDb(), event)

export const getEvents = (planId: string, taskId?: string, limit?: number): Event[] =>
  core.getEvents(getDb(), planId, { taskId, limit })

// ─── Transcript messages ──────────────────────────────────────────────────────

export function insertTranscriptMessage(msg: Omit<TranscriptMessage, 'created_at'> & { created_at?: string }): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO transcript_messages (id, session_id, plan_id, role, content, turn_index, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.id,
    msg.session_id,
    msg.plan_id,
    msg.role,
    JSON.stringify(msg.content),
    msg.turn_index,
    msg.created_at ?? new Date().toISOString(),
  )
}

export function getTranscriptMessages(sessionId: string): TranscriptMessage[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM transcript_messages WHERE session_id = ? ORDER BY turn_index ASC').all(sessionId) as Record<string, unknown>[]
  return rows.map((r) => ({ ...r, content: JSON.parse(r.content as string) } as TranscriptMessage))
}

export function getSessionsForPlan(planId: string): AgentSession[] {
  const db = getDb()
  return db.prepare('SELECT * FROM agent_sessions WHERE plan_id = ? ORDER BY started_at DESC').all(planId) as AgentSession[]
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

export const clearAllData = () => core.clearAllData(getDb())
