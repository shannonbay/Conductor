import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getProject, getTask } from '@/lib/db'
import { startAgent } from '@/lib/agent-runner'
import { ok, err, notFound, conflict, serverError } from '@/lib/api-utils'

const RunSchema = z.object({
  task_id: z.string().min(1),
})

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params
    const project = getProject(projectId)
    if (!project) return notFound('Project')

    const body = await req.json()
    const parsed = RunSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.message)

    const task = getTask(projectId, parsed.data.task_id)
    if (!task) return notFound(`Task ${parsed.data.task_id}`)

    try {
      const { sessionId } = await startAgent(projectId, parsed.data.task_id)
      return ok({ sessionId, status: 'running' }, 201)
    } catch (e) {
      if (e instanceof Error && e.message.includes('already active')) return conflict(e.message)
      throw e
    }
  } catch (e) {
    return serverError(e)
  }
}
