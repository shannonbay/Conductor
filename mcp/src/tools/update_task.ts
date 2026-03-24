import { getPlan, getTask, updateTask, touchPlan } from '../db.js'
import { getOpenPlan } from '../session.js'
import { buildContext } from '../context.js'
import { UpdateTaskSchema } from '../schema.js'

export async function update_task(args: unknown) {
  const input = UpdateTaskSchema.parse(args)

  const planId = getOpenPlan()
  if (!planId) throw new Error('No plan is open. Use open_plan or create_plan first.')

  const project = getPlan(planId)!
  const focusTaskId = project.focus_task_id
  if (!focusTaskId) throw new Error('No focus task. Use create_task to add the first task.')

  const task = getTask(planId, focusTaskId)
  if (!task) throw new Error(`Task ${focusTaskId} not found.`)

  const newState = { ...task.state, ...(input.state_patch ?? {}) }

  const now = new Date().toISOString()
  const fields: Parameters<typeof updateTask>[2] = { state: newState, updated_at: now }
  if (input.result !== undefined) fields.result = input.result

  updateTask(planId, focusTaskId, fields)
  touchPlan(planId)

  return buildContext(planId, focusTaskId)
}
