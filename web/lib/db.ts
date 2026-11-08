/**
 * Web database layer. Schema, migrations and the task/plan queries shared with
 * the MCP server live in @conductor/core; this file binds them to a lazily
 * opened connection and adds the web-only queries (goal views, events).
 */
import * as core from '@conductor/core'
import { type Event, type NewEvent, type NewPlan, type NewTask, type PlanRow, type Task } from '@conductor/core'

export type { Event, NewEvent, NewPlan, NewTask, PlanRow, Task, TreeStats } from '@conductor/core'

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
export const listRuns = (planId: string, limit?: number, opts?: { includeSkipped?: boolean }) => core.listRuns(getDb(), planId, limit, opts)
export const getOpenRun = (planId: string) => core.getOpenRun(getDb(), planId)
export const queueRun = (planId: string, trigger: core.TriggerKind = 'manual') => core.queueRun(getDb(), planId, trigger)
export const startRun = (runId: string, sessionId: string | null) => core.startRun(getDb(), runId, sessionId)
export const failRun = (runId: string, status: 'failed' | 'timed_out', reason: string) => core.failRun(getDb(), runId, status, reason)
export const decideTick = (planId: string, now?: Date) => core.decideTick(getDb(), planId, now)
export const nextIntervalRun = (planId: string, from?: Date) => core.nextIntervalRun(getDb(), planId, from)
export const recordSkip = (planId: string, trigger: core.TriggerKind, reason: string, now?: Date) => core.recordSkip(getDb(), planId, trigger, reason, now)
export const archiveResolved = (planId: string, now?: Date) => core.archiveResolved(getDb(), planId, now)
export const listMemory = (planId: string, opts?: { activeOnly?: boolean }) => core.listMemory(getDb(), planId, opts)
export type { Schedule, HealthResult, ToolCallRecord } from '@conductor/core'
export const getSchedule = (planId: string) => core.getSchedule(getDb(), planId)
export const setSchedule = (planId: string, schedule: core.Schedule | null) => core.setSchedule(getDb(), planId, schedule)
export const nextScheduledRun = (planId: string, from?: Date) => core.nextScheduledRun(getDb(), planId, from)
export const getEventTrigger = (planId: string) => core.getEventTrigger(getDb(), planId)
export const enableEventTrigger = (planId: string) => core.enableEventTrigger(getDb(), planId)
export const disableEventTrigger = (planId: string) => core.disableEventTrigger(getDb(), planId)
export const verifyEventSecret = (planId: string, secret: string) => core.verifyEventSecret(getDb(), planId, secret)
export const runHealthCheck = (planId: string) => core.runHealthCheck(getDb(), planId)
export const listHealth = (planId: string, limit?: number) => core.listHealth(getDb(), planId, limit)
export const healthDue = core.healthDue
export const listToolCalls = (planId: string, limit?: number) => core.listToolCalls(getDb(), planId, limit)

/** Number of recent decisions per category, and the suggestion threshold. */
export const PROMOTE_AFTER = core.PROMOTE_AFTER

/** Categories still at "propose" whose last PROMOTE_AFTER decisions were all approvals. */
export const getAutonomySuggestions = (planId: string) => core.getAutonomySuggestions(getDb(), planId)
/** A human approves or rejects an item; approving a goal proposal queues a run. */
export const decideItem = (planId: string, taskId: string, input: Parameters<typeof core.decideItem>[3]) => core.decideItem(getDb(), planId, taskId, input)
export const overviewWithEtag = () => core.overviewWithEtag(getDb())
export const getMemory = (id: string) => core.getMemory(getDb(), id)
export const insertMemory = (m: Parameters<typeof core.insertMemory>[1]) => core.insertMemory(getDb(), m)
export const updateMemory = (id: string, fields: Parameters<typeof core.updateMemory>[2]) => core.updateMemory(getDb(), id, fields)
export const deleteMemory = (id: string) => core.deleteMemory(getDb(), id)

/** Work items of a goal that are not archived, in tree order. */
export const getGoalItems = (planId: string): Task[] => core.getGoalItems(getDb(), planId)

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
export const approveTask = (planId: string, taskId: string) => core.approveTask(getDb(), planId, taskId)
export const rejectTask = (planId: string, taskId: string, feedback: string) => core.rejectTask(getDb(), planId, taskId, feedback)

// ─── Event log ────────────────────────────────────────────────────────────────

export const insertEvent = (event: NewEvent) => core.insertEvent(getDb(), event)

export const getEvents = (planId: string, taskId?: string, limit?: number): Event[] =>
  core.getEvents(getDb(), planId, { taskId, limit })

// ─── Test helpers ─────────────────────────────────────────────────────────────

export const clearAllData = () => core.clearAllData(getDb())
