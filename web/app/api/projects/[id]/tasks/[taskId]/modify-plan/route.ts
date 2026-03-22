import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getProject, getTask, getChildren } from '@/lib/db'
import { modifyPlan } from '@/lib/planning'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

const ModifyPlanSchema = z.object({
  instruction: z.string().min(1),
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
    const parsed = ModifyPlanSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.message)

    const children = getChildren(projectId, taskId)
    const diff = await modifyPlan(task, project.name, children, parsed.data.instruction)

    return ok({ diff, task_id: taskId, existing_children: children })
  } catch (e) {
    return serverError(e)
  }
}
