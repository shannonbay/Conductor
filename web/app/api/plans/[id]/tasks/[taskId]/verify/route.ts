import { NextRequest } from 'next/server'
import { getPlan, getTask, runChecks } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

type Params = { params: Promise<{ id: string; taskId: string }> }

/** POST — run the task's verify command now, without completing it. */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const { id: planId, taskId } = await params
    const plan = getPlan(planId)
    if (!plan) return notFound('Plan')
    const task = getTask(planId, taskId)
    if (!task) return notFound('Task')
    if (!task.verify_command) return err('This task has no verify command to run.')

    const { result, gates } = await runChecks(plan, task)
    recordEvent({ planId, taskId, eventType: 'verification_run', actor: 'human', payload: { passed: result!.passed, exit_code: result!.exit_code } })
    return ok({ result, gates })
  } catch (e) {
    return serverError(e)
  }
}
