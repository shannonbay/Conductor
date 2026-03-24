import { NextRequest } from 'next/server'
import { getPlan, getTask, getEvents } from '@/lib/db'
import { notFound, ok, serverError } from '@/lib/api-utils'

type Params = { params: Promise<{ id: string; taskId: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id: planId, taskId } = await params
    const plan = getPlan(planId)
    if (!plan) return notFound('Project')
    const task = getTask(planId, taskId)
    if (!task) return notFound('Task')
    return ok(getEvents(planId, taskId))
  } catch (e) {
    return serverError(e)
  }
}
