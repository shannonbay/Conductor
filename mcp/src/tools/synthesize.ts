import { getPlan, getTask, getChildren } from '../db.js'
import { getOpenPlan } from '../session.js'
import { buildContext } from '../context.js'
import { SynthesizeSchema } from '../schema.js'

export async function synthesize(args: unknown) {
  const input = SynthesizeSchema.parse(args)

  const planId = getOpenPlan()
  if (!planId) throw new Error('No plan is open. Use open_plan or create_plan first.')

  const project = getPlan(planId)!
  const focusTaskId = project.focus_task_id
  if (!focusTaskId) throw new Error('No focus task. Use create_task to add the first task.')

  const targetId = input.target_id ?? focusTaskId
  const task = getTask(planId, targetId)
  if (!task) throw new Error(`Task ${targetId} not found.`)

  const children = getChildren(planId, targetId)

  const completed = children
    .filter(c => c.status === 'completed')
    .map(c => ({ id: c.id, goal: c.goal, result: c.result, state: c.state }))

  const abandoned = children
    .filter(c => c.status === 'abandoned')
    .map(c => ({ id: c.id, goal: c.goal, abandon_reason: c.abandon_reason }))

  const pending = children
    .filter(c => c.status !== 'completed' && c.status !== 'abandoned')
    .map(c => ({ id: c.id, goal: c.goal, status: c.status }))

  const context = buildContext(planId, targetId)

  return {
    ...context,
    synthesis: { completed, abandoned, pending },
  }
}
