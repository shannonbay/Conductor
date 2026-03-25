import { getPlan, updatePlan, getRootTasks, getTreeStats } from '../db.js'
import { setOpenPlan } from '../session.js'
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

  const roots = getRootTasks(plan.id)

  if (roots.length === 0) {
    return {
      plan: { id: plan.id, name: plan.name, working_dir: plan.working_dir },
      message: 'Plan opened. The task tree is empty — use create_task to add the first task.',
    }
  }

  roots.sort((a, b) => Number(a.id) - Number(b.id))

  return {
    plan: { id: plan.id, name: plan.name, working_dir: plan.working_dir },
    tree_stats: getTreeStats(plan.id),
    root_tasks: roots.map(t => ({ id: t.id, goal: t.goal, status: t.status })),
  }
}
