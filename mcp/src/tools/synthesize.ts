import { getTask, getChildren } from '../db.js'
import { getOpenPlan } from '../session.js'
import { buildContext } from '../context.js'
import { SynthesizeSchema } from '../schema.js'

export async function synthesize(args: unknown) {
  const input = SynthesizeSchema.parse(args)

  const planId = getOpenPlan()
  if (!planId) throw new Error('No plan is open. Use open_plan or create_plan first.')

  const task = getTask(planId, input.task_id)
  if (!task) throw new Error(`Task ${input.task_id} not found.`)

  const children = getChildren(planId, input.task_id)

  const completed = children
    .filter(c => c.status === 'completed')
    .map(c => ({ id: c.id, goal: c.goal, result: c.result, state: c.state }))

  const abandoned = children
    .filter(c => c.status === 'abandoned')
    .map(c => ({ id: c.id, goal: c.goal, abandon_reason: c.abandon_reason }))

  const pending = children
    .filter(c => c.status !== 'completed' && c.status !== 'abandoned')
    .map(c => ({ id: c.id, goal: c.goal, status: c.status }))

  const context = buildContext(planId, input.task_id)

  return {
    ...context,
    synthesis: { completed, abandoned, pending },
  }
}
