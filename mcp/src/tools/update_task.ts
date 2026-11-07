import { getTask, updateTask, touchPlan } from '../db.js'
import { getOpenPlan } from '../session.js'
import { buildContext } from '../context.js'
import { UpdateTaskSchema } from '../schema.js'
import { record } from '../history.js'
import { gateFieldsFrom } from '../gates.js'

export async function update_task(args: unknown) {
  const input = UpdateTaskSchema.parse(args)

  const planId = getOpenPlan()
  if (!planId) throw new Error('No plan is open. Use open_plan or create_plan first.')

  const task = getTask(planId, input.task_id)
  if (!task) throw new Error(`Task ${input.task_id} not found.`)

  if (input.goal !== undefined && task.status !== 'pending') {
    throw new Error(`Cannot rename task: goal can only be changed while the task is pending (current status: ${task.status})`)
  }

  // Gates are agreed before work starts. Once a task has started, an agent may
  // only make it stricter (add approval) — otherwise it could delete a failing
  // check and then complete. Humans can still edit gates in the web UI.
  const gates = gateFieldsFrom(input)
  const changedGates = Object.keys(gates).filter((k) => !(k === 'requires_approval' && gates.requires_approval === true))
  if (changedGates.length > 0 && task.status !== 'pending') {
    throw new Error(
      `Cannot change ${changedGates.join(', ')}: verification gates can only be changed while the task is pending ` +
      `(current status: ${task.status}). Ask a human to edit them in the web UI if they are wrong.`)
  }

  const newState = { ...task.state, ...(input.state_patch ?? {}) }

  const now = new Date().toISOString()
  const fields: Parameters<typeof updateTask>[2] = { state: newState, updated_at: now, ...gates }
  if (input.result !== undefined) fields.result = input.result
  if (input.notes !== undefined) fields.notes = input.notes
  if (input.goal !== undefined) fields.goal = input.goal

  updateTask(planId, input.task_id, fields)
  touchPlan(planId)

  // Record old and new values of what changed, so the change can be reviewed (or undone later).
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  for (const key of ['goal', 'result', 'notes'] as const) {
    if (input[key] !== undefined && input[key] !== task[key]) {
      before[key] = task[key]
      after[key] = input[key]
    }
  }
  for (const [key, value] of Object.entries(gates) as [keyof typeof gates, unknown][]) {
    if (JSON.stringify(value ?? null) !== JSON.stringify(task[key] ?? null)) {
      before[key] = task[key]
      after[key] = value
    }
  }
  if (input.state_patch && Object.keys(input.state_patch).length > 0) {
    before.state = Object.fromEntries(Object.keys(input.state_patch).map((k) => [k, task.state[k] ?? null]))
    after.state = input.state_patch
  }
  if (Object.keys(after).length > 0) {
    record(planId, input.task_id, 'task_updated', { fields: Object.keys(after), before, after })
  }

  return buildContext(planId, input.task_id)
}
