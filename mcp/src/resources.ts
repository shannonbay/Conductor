import { getPlan, listPlans, getTask, getChildren, getRootTasks, getTreeStats } from './db.js'
import { buildContext } from './context.js'
import type { Task } from './db.js'

type TreeNode = Task & { children: TreeNode[] }

function attachChildren(planId: string, task: Task): TreeNode {
  const children = getChildren(planId, task.id)
  return { ...task, children: children.map(child => attachChildren(planId, child)) }
}

export async function handleListResources() {
  const plans = listPlans('active')
  const resources = []
  for (const plan of plans) {
    resources.push({
      uri: `conductor://plans/${plan.id}`,
      name: plan.name,
      description: plan.description ?? undefined,
      mimeType: 'application/json',
    })
    resources.push({
      uri: `conductor://plans/${plan.id}/tree`,
      name: `${plan.name} — task tree`,
      mimeType: 'application/json',
    })
  }
  return { resources }
}

export async function handleReadResource(request: { params: { uri: string } }) {
  const { uri } = request.params

  // conductor://plans/{id}/tasks/{taskId}
  const taskMatch = uri.match(/^conductor:\/\/plans\/([^/]+)\/tasks\/(.+)$/)
  if (taskMatch) {
    const [, planId, taskId] = taskMatch
    if (!getPlan(planId)) throw new Error(`Plan not found: ${planId}`)
    if (!getTask(planId, taskId)) throw new Error(`Task not found: ${taskId}`)
    const context = buildContext(planId, taskId)
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(context, null, 2) }] }
  }

  // conductor://plans/{id}/tree
  const treeMatch = uri.match(/^conductor:\/\/plans\/([^/]+)\/tree$/)
  if (treeMatch) {
    const [, planId] = treeMatch
    const plan = getPlan(planId)
    if (!plan) throw new Error(`Plan not found: ${planId}`)
    const tree = getRootTasks(planId).map(task => attachChildren(planId, task))
    const stats = getTreeStats(planId)
    const payload = { plan: { id: plan.id, name: plan.name, working_dir: plan.working_dir }, tree, stats }
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) }] }
  }

  // conductor://plans/{id}
  const planMatch = uri.match(/^conductor:\/\/plans\/([^/]+)$/)
  if (planMatch) {
    const [, planId] = planMatch
    const plan = getPlan(planId)
    if (!plan) throw new Error(`Plan not found: ${planId}`)
    const stats = getTreeStats(planId)
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ ...plan, tree_stats: stats }, null, 2) }] }
  }

  throw new Error(`Unknown resource URI: ${uri}`)
}
