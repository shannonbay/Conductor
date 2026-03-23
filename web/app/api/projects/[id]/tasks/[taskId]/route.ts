import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getProject, getTask, getChildren, getSiblings, getTreeStats, updateTask, deleteTaskTree, touchProject } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, conflict, serverError } from '@/lib/api-utils'

const UpdateTaskSchema = z.object({
  goal: z.string().min(1).optional(),
  notes: z.string().nullable().optional(),
  result: z.string().nullable().optional(),
  assigned_to: z.enum(['human', 'agent']).nullable().optional(),
  state_patch: z.record(z.unknown()).optional(),
})

type Params = { params: Promise<{ id: string; taskId: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id: projectId, taskId } = await params
    const project = getProject(projectId)
    if (!project) return notFound('Project')
    const task = getTask(projectId, taskId)
    if (!task) return notFound('Task')

    const taskParts = taskId.split('.')
    const parentId = taskParts.length > 1 ? taskParts.slice(0, -1).join('.') : null
    const parent = parentId ? getTask(projectId, parentId) : null
    const siblings = getSiblings(projectId, taskId)
    const children = getChildren(projectId, taskId)

    return ok({
      project: { id: project.id, name: project.name },
      task,
      parent: parent ? { id: parent.id, goal: parent.goal, status: parent.status } : null,
      siblings: siblings.map((s) => ({ id: s.id, goal: s.goal, status: s.status, result: s.result, abandon_reason: s.abandon_reason })),
      children: children.map((c) => ({ id: c.id, goal: c.goal, status: c.status, result: c.result, abandon_reason: c.abandon_reason })),
      tree_stats: getTreeStats(projectId),
    })
  } catch (e) {
    return serverError(e)
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { id: projectId, taskId } = await params
    const project = getProject(projectId)
    if (!project) return notFound('Project')
    const task = getTask(projectId, taskId)
    if (!task) return notFound('Task')

    const body = await req.json()
    const parsed = UpdateTaskSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.message)

    const { goal, notes, result, assigned_to, state_patch } = parsed.data
    const now = new Date().toISOString()
    const fields: Record<string, unknown> = { updated_at: now }

    if (goal !== undefined) fields['goal'] = goal
    if (notes !== undefined) fields['notes'] = notes
    if (result !== undefined) fields['result'] = result
    if (assigned_to !== undefined) fields['assigned_to'] = assigned_to
    if (state_patch) {
      fields['state'] = { ...task.state, ...state_patch }
    }

    updateTask(projectId, taskId, fields)
    touchProject(projectId)
    recordEvent({ projectId, taskId, eventType: 'task_updated', actor: 'human', payload: { changes: Object.keys(fields) } })
    return ok(getTask(projectId, taskId)!)
  } catch (e) {
    return serverError(e)
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const { id: projectId, taskId } = await params
    const project = getProject(projectId)
    if (!project) return notFound('Project')
    const task = getTask(projectId, taskId)
    if (!task) return notFound('Task')

    if (task.locked_by) {
      return conflict(`Task ${taskId} is locked by agent session ${task.locked_by}`)
    }

    deleteTaskTree(projectId, taskId)
    touchProject(projectId)
    recordEvent({ projectId, taskId, eventType: 'task_deleted', actor: 'human' })
    return ok({ deleted: taskId })
  } catch (e) {
    return serverError(e)
  }
}
