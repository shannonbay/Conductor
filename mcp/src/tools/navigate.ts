import { getPlan, getTask, updatePlan } from '../db.js'
import { getOpenPlan } from '../session.js'
import { buildContext } from '../context.js'
import { NavigateSchema } from '../schema.js'

export async function navigate(args: unknown) {
  const input = NavigateSchema.parse(args)

  const planId = getOpenPlan()
  if (!planId) throw new Error('No plan is open. Use open_plan or create_plan first.')

  const task = getTask(planId, input.target_id)
  if (!task) throw new Error(`Task ${input.target_id} not found in this plan.`)

  const now = new Date().toISOString()
  updatePlan(planId, { focus_task_id: input.target_id, updated_at: now })

  return buildContext(planId, input.target_id)
}
