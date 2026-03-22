import { NextRequest } from 'next/server'
import { getProject } from '@/lib/db'
import { cancelAgent } from '@/lib/agent-runner'
import { ok, notFound, err, serverError } from '@/lib/api-utils'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params
    if (!getProject(projectId)) return notFound('Project')
    try {
      cancelAgent(projectId)
      return ok({ status: 'cancelled' })
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e), 409)
    }
  } catch (e) {
    return serverError(e)
  }
}
