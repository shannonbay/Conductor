import { getTask, getChildren, updateTask, touchPlan } from '../db.js'
import { getOpenPlan } from '../session.js'
import { buildContext } from '../context.js'
import { SetStatusSchema } from '../schema.js'

export async function set_status(args: unknown) {
  const input = SetStatusSchema.parse(args)

  const planId = getOpenPlan()
  if (!planId) throw new Error('No plan is open. Use open_plan or create_plan first.')

  const task = getTask(planId, input.task_id)
  if (!task) throw new Error(`Task ${input.task_id} not found.`)

  let warning: string | undefined

  if (input.status === 'abandoned') {
    if (!input.reason) throw new Error('reason is required when setting status to abandoned.')
  }

  if (input.status === 'active') {
    if (task.depends_on && task.depends_on.length > 0) {
      const blockers = task.depends_on.filter(depId => {
        const dep = getTask(planId, depId)
        return dep?.status !== 'completed'
      })
      if (blockers.length > 0) {
        throw new Error(`Cannot activate task: unmet dependencies: ${blockers.join(', ')}`)
      }
    }
  }

  if (input.status === 'completed') {
    const children = getChildren(planId, input.task_id)
    const unfinished = children.filter(c => c.status !== 'completed' && c.status !== 'abandoned')
    if (unfinished.length > 0) {
      warning = `Warning: ${unfinished.length} child task(s) are not yet completed or abandoned: ${unfinished.map(c => c.id).join(', ')}`
    }
  }

  const now = new Date().toISOString()
  const fields: Record<string, unknown> = { status: input.status, updated_at: now }
  if (input.status === 'abandoned') fields.abandon_reason = input.reason!
  if (input.result !== undefined) fields.result = input.result

  updateTask(planId, input.task_id, fields as Parameters<typeof updateTask>[2])
  touchPlan(planId)

  const context = buildContext(planId, input.task_id)
  if (warning) {
    return { ...context, warning }
  }
  return context
}
