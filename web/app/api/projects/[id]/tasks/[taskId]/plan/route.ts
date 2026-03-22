import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getProject, getTask, getSiblings } from '@/lib/db'
import { generatePlan } from '@/lib/planning'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

const PlanSchema = z.object({
  instruction: z.string().optional(),
})

type Params = { params: Promise<{ id: string; taskId: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id: projectId, taskId } = await params
    const project = getProject(projectId)
    if (!project) return notFound('Project')
    const task = getTask(projectId, taskId)
    if (!task) return notFound('Task')

    const body = await req.json().catch(() => ({}))
    const parsed = PlanSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.message)

    const taskParts = taskId.split('.')
    const parentId = taskParts.length > 1 ? taskParts.slice(0, -1).join('.') : null
    const parentTask = parentId ? getTask(projectId, parentId) : null
    const siblings = getSiblings(projectId, taskId)

    const proposed = await generatePlan(
      task,
      project.name,
      parentTask?.goal ?? null,
      siblings,
      parsed.data.instruction,
    )

    return ok({ proposed, task_id: taskId })
  } catch (e) {
    return serverError(e)
  }
}
