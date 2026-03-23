import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getProject, getActiveSession } from '@/lib/db'
import { enqueueUserMessage, resumeAgent } from '@/lib/agent-runner'
import { ok, notFound, err, serverError } from '@/lib/api-utils'

const BodySchema = z.object({ message: z.string().min(1) })

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params
    if (!getProject(projectId)) return notFound('Project')

    const parsed = BodySchema.safeParse(await req.json())
    if (!parsed.success) return err(parsed.error.message)

    const session = getActiveSession(projectId)
    if (!session || (session.status !== 'running' && session.status !== 'paused')) {
      return err('No active agent session', 400)
    }

    enqueueUserMessage(projectId, parsed.data.message)

    // Auto-resume a paused session so the agent picks up the message
    if (session.status === 'paused') {
      resumeAgent(projectId)
    }

    return ok({ queued: true })
  } catch (e) {
    return serverError(e)
  }
}
