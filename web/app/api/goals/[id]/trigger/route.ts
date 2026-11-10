import { NextRequest } from 'next/server'
import { getGoal, getOpenRun, queueRun, verifyEventSecret } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

type Params = { params: Promise<{ id: string }> }

/**
 * POST — webhook: queue a run (trigger "event"). Authenticate with
 * "Authorization: Bearer <secret>" or an "x-quarterdeck-secret" header (the older "x-conductor-secret" works too).
 * The local request guard still applies: remote callers need their host in
 * QUARTERDECK_ALLOWED_HOSTS (e.g. behind a tunnel). Repeated calls while a run
 * is queued or running are coalesced into that run.
 */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const goal = getGoal(id)
    if (!goal) return notFound('Goal')
    const auth = req.headers.get('authorization')
    const secret = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : req.headers.get('x-quarterdeck-secret') ?? req.headers.get('x-conductor-secret') ?? ''
    if (!verifyEventSecret(id, secret)) return err('Invalid or missing webhook secret.', 401)
    if (goal.status !== 'active') return err(`Goal is ${goal.status}.`, 409)

    const existing = getOpenRun(id)
    const run = existing ?? queueRun(id, 'event')
    if (!existing) {
      let reason: string | undefined
      try { reason = ((await req.json()) as { reason?: string }).reason } catch { /* no body */ }
      recordEvent({ planId: id, taskId: id, eventType: 'plan_updated', actor: 'agent', payload: { changes: ['webhook triggered a run'], ...(reason && { reason }) } })
    }
    return ok({ run: { id: run.id, status: run.status }, coalesced: Boolean(existing) }, 202)
  } catch (e) {
    return serverError(e)
  }
}
