import { NextRequest } from 'next/server'
import { getPlan, getTask, approveTask, GateError, getGoal, isProposal, queueRun } from '@/lib/db'
import { kickScheduler } from '@/lib/goal-scheduler'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

type Params = { params: Promise<{ id: string; taskId: string }> }

/** POST — approve a task that is waiting for review; this completes it. */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const { id: planId, taskId } = await params
    if (!getPlan(planId)) return notFound('Plan')
    const task = getTask(planId, taskId)
    if (!task) return notFound('Task')

    approveTask(planId, taskId)
    recordEvent({ planId, taskId, eventType: 'approval_granted', actor: 'human' })

    // An approved goal proposal is carried out by a run: start one now if the goal is active
    if (isProposal(task) && getGoal(planId)?.status === 'active') {
      queueRun(planId)
      kickScheduler()
    }
    return ok({ task: getTask(planId, taskId) })
  } catch (e) {
    if (e instanceof GateError) return err(e.message, 409)
    return serverError(e)
  }
}
