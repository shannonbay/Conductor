import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getProject, getFullTree, getTask, getSiblings, nextChildId, insertTask, updateProject, countAllTasks, touchProject } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

const CreateTaskSchema = z.object({
  goal: z.string().min(1),
  plan: z.array(z.string()).min(1),
  parent_id: z.string().nullable().optional(),
  status: z.enum(['active', 'pending']).default('pending'),
  initial_state: z.record(z.unknown()).optional(),
  depends_on: z.array(z.string()).optional(),
  notes: z.string().optional(),
})

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const project = getProject(id)
    if (!project) return notFound('Project')
    return ok(getFullTree(id))
  } catch (e) {
    return serverError(e)
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params
    const project = getProject(projectId)
    if (!project) return notFound('Project')

    const body = await req.json()
    const parsed = CreateTaskSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.message)

    const { goal, plan, parent_id, status, initial_state, depends_on, notes } = parsed.data

    // Validate: root task requires empty tree
    if (!parent_id && countAllTasks(projectId) > 0) {
      return err('A root task already exists. Provide a parent_id to create a child task.')
    }

    // Compute tree-address ID
    const taskId = parent_id
      ? nextChildId(projectId, parent_id)
      : nextChildId(projectId, null)

    // Validate parent exists
    if (parent_id) {
      const parent = getTask(projectId, parent_id)
      if (!parent) return notFound(`Parent task ${parent_id}`)
    }

    // Validate depends_on are siblings
    if (depends_on && depends_on.length > 0) {
      const siblings = getSiblings(projectId, taskId)
      const siblingIds = new Set(siblings.map((s) => s.id))
      for (const depId of depends_on) {
        if (!siblingIds.has(depId)) {
          return err(`depends_on task ${depId} is not a sibling of ${taskId}`)
        }
        if (status === 'active') {
          const dep = getTask(projectId, depId)
          if (dep && dep.status !== 'completed') {
            return err(`Cannot set status to active: dependency ${depId} is not completed`)
          }
        }
      }
    }

    const now = new Date().toISOString()
    insertTask({
      id: taskId,
      project_id: projectId,
      goal,
      plan,
      step: 0,
      status,
      result: null,
      abandon_reason: null,
      state: initial_state ?? {},
      depends_on: depends_on ?? null,
      notes: notes ?? null,
      created_by: 'human',
      created_at: now,
      updated_at: now,
    })

    // Update project focus to new task
    updateProject(projectId, { focus_task_id: taskId, updated_at: now })

    recordEvent({ projectId, taskId, eventType: 'task_created', actor: 'human', payload: { goal, status } })
    return ok(getTask(projectId, taskId)!, 201)
  } catch (e) {
    return serverError(e)
  }
}
