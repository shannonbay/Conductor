import { NextRequest } from 'next/server'
import { getProject, updateProject } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, notFound, serverError } from '@/lib/api-utils'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const project = getProject(id)
    if (!project) return notFound('Project')

    updateProject(id, { status: 'active', updated_at: new Date().toISOString() })
    recordEvent({ projectId: id, taskId: id, eventType: 'project_restored', actor: 'human' })
    return ok(getProject(id)!)
  } catch (e) {
    return serverError(e)
  }
}
