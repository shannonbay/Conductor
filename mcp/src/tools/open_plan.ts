import { getPlan, updatePlan } from '../db.js'
import { setOpenPlan } from '../session.js'
import { buildContext } from '../context.js'
import { OpenPlanSchema } from '../schema.js'

export async function open_plan(args: unknown) {
  const input = OpenPlanSchema.parse(args)
  const plan = getPlan(input.plan_id)
  if (!plan) throw new Error(`Plan ${input.plan_id} not found`)

  if (plan.status === 'archived') {
    const now = new Date().toISOString()
    updatePlan(plan.id, { status: 'active', updated_at: now })
    plan.status = 'active'
    plan.updated_at = now
  }

  setOpenPlan(plan.id)

  if (!plan.focus_task_id) {
    return {
      plan: { id: plan.id, name: plan.name, working_dir: plan.working_dir },
      message: 'Plan opened. The task tree is empty — use create_task to add the first task.',
    }
  }

  return buildContext(plan.id, plan.focus_task_id)
}
