import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getPlan, getTask, overrideCompletion, GateError } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

const OverrideSchema = z.object({ reason: z.string().trim().min(1, 'A reason is required to override verification.') })

type Params = { params: Promise<{ id: string; taskId: string }> }

/**
 * POST — complete a task despite failing verification. Only reachable from the
 * web UI (humans); the MCP server has no equivalent. The reason is kept as evidence.
 */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id: planId, taskId } = await params
    if (!getPlan(planId)) return notFound('Plan')
    const task = getTask(planId, taskId)
    if (!task) return notFound('Task')

    const parsed = OverrideSchema.safeParse(await req.json())
    if (!parsed.success) return err(parsed.error.issues[0].message)

    overrideCompletion(planId, taskId, parsed.data.reason)
    recordEvent({ planId, taskId, eventType: 'verification_overridden', actor: 'human', payload: { reason: parsed.data.reason } })
    recordEvent({ planId, taskId, eventType: 'status_changed', actor: 'human', payload: { from: task.status, to: 'completed', reason: `override: ${parsed.data.reason}` } })
    return ok({ task: getTask(planId, taskId) })
  } catch (e) {
    if (e instanceof GateError) return err(e.message, 409)
    return serverError(e)
  }
}
