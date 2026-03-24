import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getPlan, getActiveSession } from '@/lib/db'
import { enqueueUserMessage, resumeAgent } from '@/lib/agent-runner'
import { ok, notFound, err, serverError } from '@/lib/api-utils'

const BodySchema = z.object({ message: z.string().min(1) })

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: planId } = await params
    if (!getPlan(planId)) return notFound('Project')

    const parsed = BodySchema.safeParse(await req.json())
    if (!parsed.success) return err(parsed.error.message)

    const session = getActiveSession(planId)
    if (!session || (session.status !== 'running' && session.status !== 'paused')) {
      return err('No active agent session', 400)
    }

    enqueueUserMessage(planId, parsed.data.message)

    // Auto-resume a paused session so the agent picks up the message
    if (session.status === 'paused') {
      resumeAgent(planId)
    }

    return ok({ queued: true })
  } catch (e) {
    return serverError(e)
  }
}
