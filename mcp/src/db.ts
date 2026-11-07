/**
 * MCP database layer: binds the shared @conductor/core queries to one
 * connection. Schema, migrations and query logic all live in core/ so the
 * MCP server and web app can't drift apart.
 */
import * as core from '@conductor/core'
import type { NewPlan, NewTask, PlanRow, Task } from '@conductor/core'

export type { NewPlan, NewTask, PlanRow, Task, TreeStats } from '@conductor/core'

const db = core.openDatabase()

export const getPlan = (id: string) => core.getPlan(db, id)
export const listPlans = (status: 'active' | 'archived' | 'all') => core.listPlans(db, status)
export const insertPlan = (plan: NewPlan) => core.insertPlan(db, plan)
export const updatePlan = (id: string, fields: Partial<Omit<PlanRow, 'id' | 'revision'>>) => core.updatePlan(db, id, fields)
export const touchPlan = (planId: string) => core.touchPlan(db, planId)

export const getTask = (planId: string, taskId: string) => core.getTask(db, planId, taskId)
export const getRootTasks = (planId: string) => core.getRootTasks(db, planId)
export const getAllTasks = (planId: string) => core.getAllTasks(db, planId)
export const compareTaskIds = core.compareTaskIds
export const getChildren = (planId: string, parentId: string) => core.getChildren(db, planId, parentId)
export const getSiblings = (planId: string, taskId: string) => core.getSiblings(db, planId, taskId)
export const getTreeStats = (planId: string) => core.getTreeStats(db, planId)
export const countAllTasks = (planId: string) => core.countAllTasks(db, planId)
export const nextChildId = (planId: string, parentId: string) => core.nextChildId(db, planId, parentId)
export const insertTask = (task: NewTask) => core.insertTask(db, task)
export const updateTask = (planId: string, taskId: string, fields: Partial<Omit<Task, 'id' | 'plan_id'>>) =>
  core.updateTask(db, planId, taskId, fields)

export const insertEvent = (event: core.NewEvent) => core.insertEvent(db, event)
export const getEvents = (planId: string, query?: core.EventQuery) => core.getEvents(db, planId, query)

export const checkCompletion = (plan: PlanRow, task: Task, input: core.CompletionInput) => core.checkCompletion(db, plan, task, input)
export const runChecks = (plan: PlanRow, task: Task) => core.runChecks(db, plan, task, 'agent')
export const getGateStatus = (task: Task) => core.getGateStatus(db, task)
export const getLatestVerification = (planId: string, taskId: string, gate: core.GateKind) => core.getLatestVerification(db, planId, taskId, gate)
export const describeBlockers = core.describeBlockers

// Persistent goals
export const createGoal = (plan: core.NewPlan, goal: Omit<core.NewGoal, 'plan_id'>, interval?: core.IntervalConfig) => core.createGoal(db, plan, goal, interval)
/** Human review actions — used by tests to simulate the web UI. */
export const approveTask = (planId: string, taskId: string) => core.approveTask(db, planId, taskId)
export const rejectTask = (planId: string, taskId: string, feedback: string) => core.rejectTask(db, planId, taskId, feedback)
export const listGoals = (status?: core.Goal['status']) => core.listGoals(db, status)
export const getGoal = (planId: string) => core.getGoal(db, planId)
export const buildBrief = (planId: string, runId?: string) => core.buildBrief(db, planId, runId)
export const addItem = (planId: string, runId: string | null, input: core.AddItemInput) => core.addItem(db, planId, runId, input)
export const insertMemory = (m: Parameters<typeof core.insertMemory>[1]) => core.insertMemory(db, m)
export const getMemory = (id: string) => core.getMemory(db, id)
export const updateMemory = (id: string, fields: Parameters<typeof core.updateMemory>[2]) => core.updateMemory(db, id, fields)
export const getRun = (runId: string) => core.getRun(db, runId)
export const endRun = (runId: string, summary: string) => core.endRun(db, runId, summary)
export const queueRun = (planId: string) => core.queueRun(db, planId, 'manual')
export const getOpenGoalRun = (planId: string) => core.getOpenRun(db, planId)
export const countItems = (planId: string) => db.prepare(
  "SELECT SUM(CASE WHEN status IN ('pending','active') THEN 1 ELSE 0 END) AS open, SUM(CASE WHEN review_requested_at IS NOT NULL THEN 1 ELSE 0 END) AS awaiting_review FROM tasks WHERE plan_id = ? AND archived_at IS NULL",
).get(planId) as { open: number | null; awaiting_review: number | null }

export const clearAllData = () => core.clearAllData(db)

export function runTransaction<T>(fn: () => T): T {
  return db.transaction(fn)()
}
