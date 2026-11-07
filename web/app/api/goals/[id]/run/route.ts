import { NextRequest } from 'next/server'
import { getGoal, queueRun, GoalError } from '@/lib/db'
import { cancelGoalRun, isGoalRunActive } from '@/lib/goal-runner'
import { kickScheduler } from '@/lib/goal-scheduler'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

type Params = { params: Promise<{ id: string }> }

/** POST — "Run now": queue a run; the scheduler starts it as soon as the channel is free. */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    if (!getGoal(id)) return notFound('Goal')
    const run = queueRun(id)
    kickScheduler()
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
    if (!isGoalRunActive(id)) return err('This goal has no run in progress.', 409)
    await cancelGoalRun(id)
    return ok({ cancelled: true })
  } catch (e) {
    return serverError(e)
  }
}
