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

export const clearAllData = () => core.clearAllData(db)

export function runTransaction<T>(fn: () => T): T {
  return db.transaction(fn)()
}
