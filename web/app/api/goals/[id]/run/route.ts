import { NextRequest } from 'next/server'
import { getGoal, queueRun, getOpenRun, failRun, GoalError } from '@/lib/db'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

type Params = { params: Promise<{ id: string }> }

/** POST — "Run now": queue a run; the conductor-goals plugin starts it at its next tick (within 30 s). */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    if (!getGoal(id)) return notFound('Goal')
    const run = queueRun(id)
    return ok({ run }, 202)
  } catch (e) {
    if (e instanceof GoalError) return err(e.message, 409)
    return serverError(e)
  }
}

/** DELETE — cancel the goal's run in progress. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    if (!getGoal(id)) return notFound('Goal')
    // Mark the run cancelled; the conductor-goals plugin stops its agent at its next tick
    const open = getOpenRun(id)
    if (!open) return err('This goal has no run in progress.', 409)
    failRun(open.id, 'failed', 'Cancelled by you')
    return ok({ cancelled: true })
  } catch (e) {
    return serverError(e)
  }
}
