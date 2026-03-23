import { NextRequest } from 'next/server'
import { getProject, getFullTree } from '@/lib/db'
import type { TreeNode } from '@/lib/db'
import { generateProjectPlan } from '@/lib/project-planner'
import { ok, notFound, serverError } from '@/lib/api-utils'

function flattenNodes(nodes: TreeNode[]) {
  const tasks = []
  const stack = [...nodes]
  while (stack.length > 0) {
    const node = stack.pop()!
    const { children, ...task } = node
    tasks.push(task)
    stack.push(...children)
  }
  return tasks
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const project = getProject(id)
    if (!project) return notFound('Project')

    const flatTasks = flattenNodes(getFullTree(id))
    const proposal = await generateProjectPlan(project, flatTasks)
    return ok({ proposal })
  } catch (e) {
    return serverError(e)
  }
}
