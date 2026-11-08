import { NextRequest } from 'next/server'
import { getGoal, getTask, decideItem, GateError } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

type Params = { params: Promise<{ id: string; itemId: string }> }

/**
 * POST — approve a goal item waiting for review. An approved proposal stays
 * active and is carried out by a run: decideItem queues one if the goal is
 * active, and the conductor-goals plugin starts it within 30 s.
 */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const { id: goalId, itemId } = await params
    if (!getGoal(goalId)) return notFound('Goal')
    if (!getTask(goalId, itemId)) return notFound('Item')
    const { task } = decideItem(goalId, itemId, { decision: 'approve' })
    recordEvent({ planId: goalId, taskId: itemId, eventType: 'approval_granted', actor: 'human' })
    return ok({ task })
  } catch (e) {
    if (e instanceof GateError) return err(e.message, 409)
    return serverError(e)
  }
}
