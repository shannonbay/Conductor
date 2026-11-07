import { getEvents, getPlan } from '../db.js'
import { getOpenPlan } from '../session.js'
import { GetHistorySchema } from '../schema.js'

/** Read-only: recent changes to the open plan, from both Claude (actor "agent") and the web UI (actor "human"). */
export async function get_history(args: unknown) {
  const input = GetHistorySchema.parse(args)

  const planId = getOpenPlan()
  if (!planId) throw new Error('No plan is open. Use list_plans and open_plan first.')
  const plan = getPlan(planId)!

  const events = getEvents(planId, { taskId: input.task_id, subtree: true, limit: input.limit })

  return {
    plan: { id: plan.id, name: plan.name },
    count: events.length,
    events: events.map((e) => {
      const { via, ...details } = e.payload
      return {
        at: e.created_at,
        actor: e.actor,
        via: via ?? (e.actor === 'human' ? 'ui' : 'agent-run'),
        type: e.event_type,
        task_id: e.task_id === planId ? null : e.task_id,
        ...(Object.keys(details).length > 0 && { details }),
      }
    }),
  }
}
