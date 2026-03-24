import { getPlan } from '../db.js'
import { getOpenPlan } from '../session.js'
import { buildContext } from '../context.js'
import { GetContextSchema } from '../schema.js'

export async function get_context(args: unknown) {
  GetContextSchema.parse(args)

  const planId = getOpenPlan()
  if (!planId) {
    return {
      error: 'No plan is open. Use list_plans and open_plan to open one.',
    }
  }

  const project = getPlan(planId)!
  if (!project.focus_task_id) {
    return {
      plan: { id: project.id, name: project.name },
      message: 'Plan is open but the task tree is empty. Use create_task to add the first task.',
    }
  }

  return buildContext(planId, project.focus_task_id)
}
