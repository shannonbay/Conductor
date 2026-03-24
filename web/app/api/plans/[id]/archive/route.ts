import { NextRequest } from 'next/server'
import { getPlan, updatePlan } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, notFound, serverError } from '@/lib/api-utils'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const plan = getPlan(id)
    if (!plan) return notFound('Plan')

    updatePlan(id, { status: 'archived', updated_at: new Date().toISOString() })
    recordEvent({ planId: id, taskId: id, eventType: 'plan_archived', actor: 'human' })
    return ok(getPlan(id)!)
  } catch (e) {
    return serverError(e)
  }
}
