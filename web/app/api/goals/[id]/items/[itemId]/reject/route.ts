import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getGoal, getTask, decideItem, GateError } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

const RejectSchema = z.object({ feedback: z.string().trim().min(1, 'Feedback is required when rejecting.') })

type Params = { params: Promise<{ id: string; itemId: string }> }

/** POST — reject a goal item waiting for review; the feedback goes to its notes and the goal's memory. */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id: goalId, itemId } = await params
    if (!getGoal(goalId)) return notFound('Goal')
    if (!getTask(goalId, itemId)) return notFound('Item')
    const parsed = RejectSchema.safeParse(await req.json())
    if (!parsed.success) return err(parsed.error.issues[0].message)
    const { task } = decideItem(goalId, itemId, { decision: 'reject', feedback: parsed.data.feedback })
    recordEvent({ planId: goalId, taskId: itemId, eventType: 'review_rejected', actor: 'human', payload: { feedback: parsed.data.feedback } })
    return ok({ task })
  } catch (e) {
    if (e instanceof GateError) return err(e.message, 409)
    return serverError(e)
  }
}
