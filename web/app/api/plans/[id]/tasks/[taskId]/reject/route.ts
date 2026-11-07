import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getPlan, getTask, rejectTask, GateError } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

const RejectSchema = z.object({ feedback: z.string().trim().min(1, 'Feedback is required when rejecting.') })

type Params = { params: Promise<{ id: string; taskId: string }> }

/** POST — reject a task waiting for review; it goes back to active with the feedback in its notes. */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id: planId, taskId } = await params
    if (!getPlan(planId)) return notFound('Plan')
    if (!getTask(planId, taskId)) return notFound('Task')

    const parsed = RejectSchema.safeParse(await req.json())
    if (!parsed.success) return err(parsed.error.issues[0].message)

    rejectTask(planId, taskId, parsed.data.feedback)
    recordEvent({ planId, taskId, eventType: 'review_rejected', actor: 'human', payload: { feedback: parsed.data.feedback } })
    return ok({ task: getTask(planId, taskId) })
  } catch (e) {
    if (e instanceof GateError) return err(e.message, 409)
    return serverError(e)
  }
}
