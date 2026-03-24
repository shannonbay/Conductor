import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getPlan, updatePlan, getTreeStats, touchPlan, deletePlan } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

const UpdatePlanSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
})

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const plan = getPlan(id)
    if (!plan) return notFound('Plan')
    return ok({ ...plan, tree_stats: getTreeStats(id) })
  } catch (e) {
    return serverError(e)
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const plan = getPlan(id)
    if (!plan) return notFound('Plan')
    deletePlan(id)
    return ok({ ok: true })
  } catch (e) {
    return serverError(e)
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const plan = getPlan(id)
    if (!plan) return notFound('Plan')

    const body = await req.json()
    const parsed = UpdatePlanSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.message)

    const fields: Record<string, unknown> = {}
    if (parsed.data.name !== undefined) fields['name'] = parsed.data.name
    if (parsed.data.description !== undefined) fields['description'] = parsed.data.description
    fields['updated_at'] = new Date().toISOString()
    updatePlan(id, fields)

    recordEvent({ planId: id, taskId: id, eventType: 'plan_updated', actor: 'human', payload: { changes: fields } })
    return ok({ ...getPlan(id)!, tree_stats: getTreeStats(id) })
  } catch (e) {
    return serverError(e)
  }
}
