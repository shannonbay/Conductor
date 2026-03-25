import { getTask, updateTask, touchPlan } from '../db.js'
import { getOpenPlan } from '../session.js'
import { buildContext } from '../context.js'
import { UpdateTaskSchema } from '../schema.js'

export async function update_task(args: unknown) {
  const input = UpdateTaskSchema.parse(args)

  const planId = getOpenPlan()
  if (!planId) throw new Error('No plan is open. Use open_plan or create_plan first.')

  const task = getTask(planId, input.task_id)
  if (!task) throw new Error(`Task ${input.task_id} not found.`)

  if (input.goal !== undefined && task.status !== 'pending') {
    throw new Error(`Cannot rename task: goal can only be changed while the task is pending (current status: ${task.status})`)
  }

  const newState = { ...task.state, ...(input.state_patch ?? {}) }

  const now = new Date().toISOString()
  const fields: Parameters<typeof updateTask>[2] = { state: newState, updated_at: now }
  if (input.result !== undefined) fields.result = input.result
  if (input.notes !== undefined) fields.notes = input.notes
  if (input.goal !== undefined) fields.goal = input.goal

  updateTask(planId, input.task_id, fields)
  touchPlan(planId)

  return buildContext(planId, input.task_id)
}
