import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getProject, nextChildId, insertTask, touchProject } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

const AcceptSchema = z.object({
  root: z.object({
    goal: z.string().min(1),
    plan: z.array(z.string()).min(1),
  }),
  children: z.array(z.object({
    goal: z.string().min(1),
    plan: z.array(z.string()).min(1),
    depends_on: z.array(z.string()).optional(),
  })),
})

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params
    const project = getProject(projectId)
    if (!project) return notFound('Project')

    const body = await req.json()
    const parsed = AcceptSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.message)

    const { root, children } = parsed.data
    const now = new Date().toISOString()

    // Create root task
    const rootId = nextChildId(projectId, null)
    insertTask({
      id: rootId,
      project_id: projectId,
      goal: root.goal,
      plan: root.plan,
      step: 0,
      status: 'pending',
      result: null,
      abandon_reason: null,
      state: {},
      depends_on: null,
      notes: null,
      created_by: 'human',
      created_at: now,
      updated_at: now,
    })
    recordEvent({ projectId, taskId: rootId, eventType: 'task_created', actor: 'human', payload: { goal: root.goal, via: 'generate_plan_accept' } })

    // Create children under root
    const createdIds: string[] = [rootId]
    for (const child of children) {
      const childId = nextChildId(projectId, rootId)
      insertTask({
        id: childId,
        project_id: projectId,
        goal: child.goal,
        plan: child.plan,
        step: 0,
        status: 'pending',
        result: null,
        abandon_reason: null,
        state: {},
        depends_on: child.depends_on ?? null,
        notes: null,
        created_by: 'human',
        created_at: now,
        updated_at: now,
      })
      recordEvent({ projectId, taskId: childId, eventType: 'task_created', actor: 'human', payload: { goal: child.goal, via: 'generate_plan_accept' } })
      createdIds.push(childId)
    }

    touchProject(projectId)

    return ok({ root_id: rootId, created: createdIds }, 201)
  } catch (e) {
    return serverError(e)
  }
}
