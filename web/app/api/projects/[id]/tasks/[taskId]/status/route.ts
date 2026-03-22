import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getProject, getTask, getChildren, getSiblings, updateTask, touchProject } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

const SetStatusSchema = z.object({
  status: z.enum(['active', 'pending', 'completed', 'abandoned']),
  reason: z.string().optional(),
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
    const parsed = SetStatusSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.message)

    const { status, reason } = parsed.data

    if (status === 'abandoned' && !reason) {
      return err('reason is required when abandoning a task')
    }

    // Validate: activating a task requires all depends_on to be completed
    if (status === 'active' && task.depends_on && task.depends_on.length > 0) {
      const siblings = getSiblings(projectId, taskId)
      const siblingsById = new Map(siblings.map((s) => [s.id, s]))
      for (const depId of task.depends_on) {
        const dep = siblingsById.get(depId)
        if (!dep || dep.status !== 'completed') {
          return err(`Cannot activate: dependency ${depId} is not completed`)
        }
      }
    }

    const now = new Date().toISOString()
    const fields: Record<string, unknown> = { status, updated_at: now }
    if (status === 'abandoned') fields['abandon_reason'] = reason

    // Check for unresolved children when completing
    let warning: string | undefined
    if (status === 'completed') {
      const children = getChildren(projectId, taskId)
      const unresolved = children.filter((c) => c.status !== 'completed' && c.status !== 'abandoned')
      if (unresolved.length > 0) {
        warning = `${unresolved.length} child task(s) are not yet resolved`
      }
    }

    updateTask(projectId, taskId, fields)
    touchProject(projectId)
    recordEvent({
      projectId,
      taskId,
      eventType: 'status_changed',
      actor: 'human',
      payload: { from: task.status, to: status, reason },
    })

    const updated = getTask(projectId, taskId)!
    return ok({ task: updated, warning })
  } catch (e) {
    return serverError(e)
  }
}
