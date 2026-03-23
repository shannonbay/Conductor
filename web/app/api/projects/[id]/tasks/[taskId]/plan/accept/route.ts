import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getProject, getTask, nextChildId, insertTask, getChildren, touchProject } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

const AcceptedTaskSchema = z.object({
  goal: z.string().min(1),
  depends_on: z.array(z.string()).optional(),
})

const AcceptPlanSchema = z.object({
  tasks: z.array(AcceptedTaskSchema).min(1),
})

type Params = { params: Promise<{ id: string; taskId: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id: projectId, taskId } = await params
    const project = getProject(projectId)
    if (!project) return notFound('Project')
    const task = getTask(projectId, taskId)
    if (!task) return notFound('Task')

    const body = await req.json()
    const parsed = AcceptPlanSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.message)

    const now = new Date().toISOString()
    const created = []

    for (const t of parsed.data.tasks) {
      const childId = nextChildId(projectId, taskId)
      insertTask({
        id: childId,
        project_id: projectId,
        goal: t.goal,
        status: 'pending',
        result: null,
        abandon_reason: null,
        state: {},
        depends_on: t.depends_on && t.depends_on.length > 0 ? t.depends_on : null,
        created_by: 'human',
        created_at: now,
        updated_at: now,
      })
      recordEvent({ projectId, taskId: childId, eventType: 'task_created', actor: 'human', payload: { via: 'plan_accept' } })
      created.push(childId)
    }

    touchProject(projectId)
    return ok({ created, children: getChildren(projectId, taskId) }, 201)
  } catch (e) {
    return serverError(e)
  }
}
