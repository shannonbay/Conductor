import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getProject, getTask, getChildren, getDb, nextChildId, insertTask, updateTask, deleteTaskTree, touchProject } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

const AcceptModifySchema = z.object({
  modified: z.array(z.object({
    replaces_id: z.string(),
    goal: z.string(),
    plan: z.array(z.string()),
    suggested_depends_on: z.array(z.string()).optional(),
  })).optional(),
  added: z.array(z.object({
    goal: z.string(),
    plan: z.array(z.string()),
    suggested_depends_on: z.array(z.string()).optional(),
  })).optional(),
  removed: z.array(z.string()).optional(),
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
    const parsed = AcceptModifySchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.message)

    const { modified = [], added = [], removed = [] } = parsed.data
    const now = new Date().toISOString()

    const db = getDb()
    db.transaction(() => {
      // Apply modifications (replace pending tasks)
      for (const mod of modified) {
        const existing = getTask(projectId, mod.replaces_id)
        if (!existing) return
        if (existing.status === 'completed' || existing.status === 'active') return // guard
        updateTask(projectId, mod.replaces_id, {
          goal: mod.goal,
          plan: mod.plan,
          depends_on: mod.suggested_depends_on?.length ? mod.suggested_depends_on : null,
          updated_at: now,
        })
        recordEvent({ projectId, taskId: mod.replaces_id, eventType: 'task_updated', actor: 'human', payload: { via: 'modify_plan_accept' } })
      }

      // Remove pending tasks
      for (const id of removed) {
        const existing = getTask(projectId, id)
        if (!existing || existing.status === 'completed' || existing.status === 'active') continue
        deleteTaskTree(projectId, id)
        recordEvent({ projectId, taskId: id, eventType: 'task_deleted', actor: 'human', payload: { via: 'modify_plan_accept' } })
      }

      // Add new tasks
      for (const t of added) {
        const childId = nextChildId(projectId, taskId)
        insertTask({
          id: childId,
          project_id: projectId,
          goal: t.goal,
          plan: t.plan,
          step: 0,
          status: 'pending',
          result: null,
          abandon_reason: null,
          state: {},
          depends_on: t.suggested_depends_on?.length ? t.suggested_depends_on : null,
          created_by: 'human',
          created_at: now,
          updated_at: now,
        })
        recordEvent({ projectId, taskId: childId, eventType: 'task_created', actor: 'human', payload: { via: 'modify_plan_accept' } })
      }
    })()

    touchProject(projectId)
    return ok({ children: getChildren(projectId, taskId) })
  } catch (e) {
    return serverError(e)
  }
}
