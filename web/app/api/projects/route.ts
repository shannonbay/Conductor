import { NextRequest } from 'next/server'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { listProjects, getTreeStats, insertProject } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, serverError } from '@/lib/api-utils'

const CreateProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
})

export async function GET(req: NextRequest) {
  try {
    const status = (req.nextUrl.searchParams.get('status') ?? 'active') as 'active' | 'archived' | 'all'
    const projects = listProjects(status)
    const result = projects.map((p) => ({ ...p, tree_stats: getTreeStats(p.id) }))
    return ok(result)
  } catch (e) {
    return serverError(e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const parsed = CreateProjectSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.message)

    const { name, description } = parsed.data
    const now = new Date().toISOString()
    const project = {
      id: `proj_${nanoid(10)}`,
      name,
      description: description ?? null,
      status: 'active' as const,
      focus_task_id: null,
      created_at: now,
      updated_at: now,
    }
    insertProject(project)
    recordEvent({ projectId: project.id, taskId: project.id, eventType: 'project_created', actor: 'human' })
    return ok({ ...project, tree_stats: getTreeStats(project.id) }, 201)
  } catch (e) {
    return serverError(e)
  }
}
