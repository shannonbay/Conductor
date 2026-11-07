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
  /** Result of the latest verify-command run, or null if never run. */
  last_check_passed: boolean | null
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

// ─── Persistent goals (shared with MCP via @conductor/core) ───────────────────

export { GoalError, isProposal, DEFAULT_GOAL_LIMITS } from '@conductor/core'
export type { Goal, GoalRun, GoalMemory, GoalTrigger, IntervalConfig, AutonomyMode, TickDecision } from '@conductor/core'
export const createGoal = (plan: NewPlan, goal: Omit<core.NewGoal, 'plan_id'>, interval?: core.IntervalConfig) => core.createGoal(getDb(), plan, goal, interval)
export const getGoal = (planId: string) => core.getGoal(getDb(), planId)
export const listGoals = (status?: core.Goal['status']) => core.listGoals(getDb(), status)
export const updateGoal = (planId: string, fields: Parameters<typeof core.updateGoal>[2]) => core.updateGoal(getDb(), planId, fields)
export const getIntervalTrigger = (planId: string) => core.getIntervalTrigger(getDb(), planId)
export const setIntervalTrigger = (planId: string, config: core.IntervalConfig | null) => core.setIntervalTrigger(getDb(), planId, config)
export const insertRun = (planId: string, trigger: core.TriggerKind, status?: core.RunStatus, skipReason?: string) => core.insertRun(getDb(), planId, trigger, status, skipReason)
export const getRun = (runId: string) => core.getRun(getDb(), runId)
export const updateRun = (runId: string, fields: Parameters<typeof core.updateRun>[2]) => core.updateRun(getDb(), runId, fields)
export const listRuns = (planId: string, limit?: number) => core.listRuns(getDb(), planId, limit)
export const getOpenRun = (planId: string) => core.getOpenRun(getDb(), planId)
export const queueRun = (planId: string) => core.queueRun(getDb(), planId, 'manual')
export const startRun = (runId: string, sessionId: string | null) => core.startRun(getDb(), runId, sessionId)
export const failRun = (runId: string, status: 'failed' | 'timed_out', reason: string) => core.failRun(getDb(), runId, status, reason)
export const decideTick = (planId: string, now?: Date) => core.decideTick(getDb(), planId, now)
export const nextIntervalRun = (planId: string, from?: Date) => core.nextIntervalRun(getDb(), planId, from)
export const recordSkip = (planId: string, trigger: core.TriggerKind, reason: string, now?: Date) => core.recordSkip(getDb(), planId, trigger, reason, now)
export const archiveResolved = (planId: string, now?: Date) => core.archiveResolved(getDb(), planId, now)
export const listMemory = (planId: string) => core.listMemory(getDb(), planId)
export const getMemory = (id: string) => core.getMemory(getDb(), id)
export const insertMemory = (m: Parameters<typeof core.insertMemory>[1]) => core.insertMemory(getDb(), m)
export const updateMemory = (id: string, fields: Parameters<typeof core.updateMemory>[2]) => core.updateMemory(getDb(), id, fields)
export const deleteMemory = (id: string) => core.deleteMemory(getDb(), id)

/** Work items of a goal that are not archived, in tree order. */
export function getGoalItems(planId: string): Task[] {
  const rows = getDb().prepare('SELECT * FROM tasks WHERE plan_id = ? AND archived_at IS NULL').all(planId) as Record<string, unknown>[]
  return rows.map(deserializeTask).sort((a, b) => core.compareTaskIds(a.id, b.id))
}

/** Approved/rejected counts per action category — evidence for promoting a category to auto. */
export function getApprovalStats(planId: string): Record<string, { approved: number; rejected: number }> {
  const rows = getDb().prepare(`
    SELECT json_extract(t.state, '$.action.category') AS category, v.passed, COUNT(*) AS n
    FROM verifications v JOIN tasks t ON t.plan_id = v.plan_id AND t.id = v.task_id
    WHERE v.plan_id = ? AND v.gate = 'approval' AND json_extract(t.state, '$.action.category') IS NOT NULL
    GROUP BY category, v.passed
  `).all(planId) as { category: string; passed: number; n: number }[]
  const stats: Record<string, { approved: number; rejected: number }> = {}
  for (const r of rows) {
    stats[r.category] ??= { approved: 0, rejected: 0 }
    if (r.passed) stats[r.category].approved += r.n
    else stats[r.category].rejected += r.n
  }
  return stats
}

// ─── Verification gates (shared with MCP via @conductor/core) ─────────────────

export { GateError } from '@conductor/core'
export type { Blocker, CommandResult, GateStatus, Verification } from '@conductor/core'
export const getGateStatus = (task: Task) => core.getGateStatus(getDb(), task)
export const getVerifications = (planId: string, taskId: string, limit?: number) => core.getVerifications(getDb(), planId, taskId, limit)
/** Completion check for a human in the UI: criteria waived, counts as approval, command enforced. */
export const checkHumanCompletion = (plan: PlanRow, task: Task) => core.checkCompletion(getDb(), plan, task, { actor: 'human' })
export const runChecks = (plan: PlanRow, task: Task) => core.runChecks(getDb(), plan, task, 'human')
export const approveTask = (planId: string, taskId: string) => core.approveTask(getDb(), planId, taskId)
export const rejectTask = (planId: string, taskId: string, feedback: string) => core.rejectTask(getDb(), planId, taskId, feedback)
export const overrideCompletion = (planId: string, taskId: string, reason: string) => core.overrideCompletion(getDb(), planId, taskId, reason)

// ─── UI-specific task operations ──────────────────────────────────────────────

/**
 * Returns all tasks for a plan as a nested tree structure.
 * Root tasks are tasks whose ID has no dots (e.g. "1").
 */
export function getFullTree(planId: string): TreeNode[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM tasks WHERE plan_id = ?').all(planId) as Record<string, unknown>[]
  // Tree order ("1.2" before "1.10"), not string order
  const tasks = rows.map(deserializeTask).sort((a, b) => core.compareTaskIds(a.id, b.id))

  // Latest verify-command result per task, for the tree's pass/fail badge
  const lastChecks = new Map(
    (db.prepare(`
      SELECT task_id, passed FROM verifications v
      WHERE plan_id = ? AND gate = 'command'
        AND rowid = (SELECT rowid FROM verifications WHERE plan_id = v.plan_id AND task_id = v.task_id AND gate = 'command'
                     ORDER BY created_at DESC, rowid DESC LIMIT 1)
    `).all(planId) as { task_id: string; passed: number }[]).map((r) => [r.task_id, Boolean(r.passed)]),
  )

  const byId = new Map<string, TreeNode>()
  for (const t of tasks) byId.set(t.id, { ...t, last_check_passed: lastChecks.get(t.id) ?? null, children: [] })

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
