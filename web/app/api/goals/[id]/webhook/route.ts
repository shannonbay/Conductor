import { NextRequest } from 'next/server'
import { getGoal, enableEventTrigger, disableEventTrigger } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, notFound, serverError } from '@/lib/api-utils'

type Params = { params: Promise<{ id: string }> }

/**
 * POST — turn on (or rotate) the goal's webhook. Returns the secret once;
 * only its hash is stored. Callers then POST /api/goals/:id/trigger with
 * "Authorization: Bearer <secret>".
 */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    if (!getGoal(id)) return notFound('Goal')
    const secret = enableEventTrigger(id)
    recordEvent({ planId: id, taskId: id, eventType: 'plan_updated', actor: 'human', payload: { changes: ['webhook'] } })
    return ok({ secret, url: `/api/goals/${id}/trigger` }, 201)
  } catch (e) {
    return serverError(e)
  }
}

/** DELETE — turn the webhook off. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    if (!getGoal(id)) return notFound('Goal')
    disableEventTrigger(id)
    recordEvent({ planId: id, taskId: id, eventType: 'plan_updated', actor: 'human', payload: { changes: ['webhook removed'] } })
    return ok({ disabled: true })
  } catch (e) {
    return serverError(e)
  }
}
