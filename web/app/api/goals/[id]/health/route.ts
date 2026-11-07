import { NextRequest } from 'next/server'
import { getGoal } from '@/lib/db'
import { checkHealth, kickScheduler } from '@/lib/goal-scheduler'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

type Params = { params: Promise<{ id: string }> }

/** POST — run the goal's health check now; a failure may queue a run (per the goal's setting). */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const goal = getGoal(id)
    if (!goal) return notFound('Goal')
    if (!goal.health_command) return err('This goal has no health check command.')
    const result = await checkHealth(id)
    if (result.queuedRun) kickScheduler()
    return ok(result)
  } catch (e) {
    return serverError(e)
  }
}
