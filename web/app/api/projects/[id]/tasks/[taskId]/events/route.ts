import { NextRequest } from 'next/server'
import { getProject, getTask, getEvents } from '@/lib/db'
import { notFound, ok, serverError } from '@/lib/api-utils'

type Params = { params: Promise<{ id: string; taskId: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id: projectId, taskId } = await params
    const project = getProject(projectId)
    if (!project) return notFound('Project')
    const task = getTask(projectId, taskId)
    if (!task) return notFound('Task')
    return ok(getEvents(projectId, taskId))
  } catch (e) {
    return serverError(e)
  }
}
