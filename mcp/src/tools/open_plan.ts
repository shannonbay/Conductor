import { getPlan, updatePlan, countAllTasks, getRootTasks } from '../db.js'
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

  // focus_task_id may be null even when tasks exist (e.g. plans created outside
  // the MCP, or whose cursor was never set). Treat null as "no focus" not "no tasks".
  const focusId = plan.focus_task_id ?? findDefaultFocus(plan.id)

  if (!focusId) {
    return {
      plan: { id: plan.id, name: plan.name, working_dir: plan.working_dir },
      message: 'Plan opened. The task tree is empty — use create_task to add the first task.',
    }
  }

  if (!plan.focus_task_id) {
    // Persist the recovered focus so subsequent get_context calls see it too
    updatePlan(plan.id, { focus_task_id: focusId, updated_at: plan.updated_at })
  }

  return buildContext(plan.id, focusId)
}

/** Return the lowest-numbered root task ID, or null if the plan is empty. */
function findDefaultFocus(planId: string): string | null {
  const roots = getRootTasks(planId)
  if (roots.length === 0) return null
  roots.sort((a, b) => Number(a.id) - Number(b.id))
  return roots[0].id
}
