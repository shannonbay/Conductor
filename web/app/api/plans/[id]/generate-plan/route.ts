import { NextRequest } from 'next/server'
import { getPlan, getFullTree } from '@/lib/db'
import type { TreeNode } from '@/lib/db'
import { generatePlan } from '@/lib/plan-generator'
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
    const plan = getPlan(id)
    if (!plan) return notFound('Plan')

    const flatTasks = flattenNodes(getFullTree(id))
    const proposal = await generatePlan(plan, flatTasks)
    return ok({ proposal })
  } catch (e) {
    return serverError(e)
  }
}
