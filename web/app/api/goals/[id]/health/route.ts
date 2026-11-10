import { NextRequest } from 'next/server'
import { getGoal, getOpenRun, queueRun, runHealthCheck } from '@/lib/db'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

type Params = { params: Promise<{ id: string }> }

/** POST — run the goal's health check now; a failure may queue a run (per the goal's setting). */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const goal = getGoal(id)
    if (!goal) return notFound('Goal')
    if (!goal.health_command) return err('This goal has no health check command.')
    const result = await runHealthCheck(id)
    // A failed check queues a run (if the goal asks for it); the quarterdeck-goals plugin starts it
    let queuedRun = false
    if (!result.passed && goal.health_triggers_run && goal.status === 'active' && !getOpenRun(id)) {
      queueRun(id, 'health')
      queuedRun = true
    }
    return ok({ passed: result.passed, queuedRun })
  } catch (e) {
    return serverError(e)
  }
}
