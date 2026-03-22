import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getProject, updateProject, getTreeStats, touchProject } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

const UpdateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
})

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const project = getProject(id)
    if (!project) return notFound('Project')
    return ok({ ...project, tree_stats: getTreeStats(id) })
  } catch (e) {
    return serverError(e)
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const project = getProject(id)
    if (!project) return notFound('Project')

    const body = await req.json()
    const parsed = UpdateProjectSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.message)

    const fields: Record<string, unknown> = {}
    if (parsed.data.name !== undefined) fields['name'] = parsed.data.name
    if (parsed.data.description !== undefined) fields['description'] = parsed.data.description
    fields['updated_at'] = new Date().toISOString()
    updateProject(id, fields)

    recordEvent({ projectId: id, taskId: id, eventType: 'project_updated', actor: 'human', payload: { changes: fields } })
    return ok({ ...getProject(id)!, tree_stats: getTreeStats(id) })
  } catch (e) {
    return serverError(e)
  }
}
