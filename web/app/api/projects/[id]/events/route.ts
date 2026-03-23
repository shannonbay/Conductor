import { NextRequest } from 'next/server'
import { getProject, getEvents } from '@/lib/db'
import { ok, notFound, serverError } from '@/lib/api-utils'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const project = getProject(id)
    if (!project) return notFound('Project')
    return ok(getEvents(id))
  } catch (e) {
    return serverError(e)
  }
}
