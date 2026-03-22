import { NextRequest } from 'next/server'
import { getProject, getActiveSession } from '@/lib/db'
import { ok, notFound, serverError } from '@/lib/api-utils'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params
    if (!getProject(projectId)) return notFound('Project')
    const session = getActiveSession(projectId)
    return ok(session ?? null)
  } catch (e) {
    return serverError(e)
  }
}
