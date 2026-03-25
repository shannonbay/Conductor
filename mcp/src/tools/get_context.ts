import { getOpenPlan } from '../session.js'
import { buildContext } from '../context.js'
import { GetContextSchema } from '../schema.js'

export async function get_context(args: unknown) {
  const input = GetContextSchema.parse(args)

  const planId = getOpenPlan()
  if (!planId) {
    return {
      error: 'No plan is open. Use list_plans and open_plan to open one.',
    }
  }

  return buildContext(planId, input.task_id)
}
