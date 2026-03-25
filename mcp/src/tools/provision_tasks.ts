import { getOpenPlan } from '../session.js'
import { getPlan, getTask, insertTask, touchPlan, countAllTasks, runTransaction, Task } from '../db.js'
import { buildContext } from '../context.js'
import { ProvisionTasksSchema } from '../schema.js'

/** Compare task IDs by depth first, then numerically segment-by-segment. */
function compareTaskIds(a: string, b: string): number {
  const aSeg = a.split('.').map(Number)
  const bSeg = b.split('.').map(Number)
  if (aSeg.length !== bSeg.length) return aSeg.length - bSeg.length
  for (let i = 0; i < aSeg.length; i++) {
    if (aSeg[i] !== bSeg[i]) return aSeg[i] - bSeg[i]
  }
  return 0
}

function parentOf(id: string): string | null {
  const dot = id.lastIndexOf('.')
  return dot === -1 ? null : id.slice(0, dot)
}

export async function provision_tasks(args: unknown) {
  const input = ProvisionTasksSchema.parse(args)

  const planId = getOpenPlan()
  if (!planId) throw new Error('No plan is open. Call open_plan first.')
  const plan = getPlan(planId)
  if (!plan) throw new Error('Open plan not found.')

  const ids = Object.keys(input.tasks)
  if (ids.length === 0) throw new Error('tasks must not be empty.')

  const batchIds = new Set(ids)

  // 1. Reject IDs that already exist in DB
  for (const id of ids) {
    if (getTask(planId, id)) {
      throw new Error(`Task "${id}" already exists. provision_tasks only creates new tasks; use update_task to modify existing ones.`)
    }
  }

  // 2. Root-level tasks require an empty plan
  const hasRootIds = ids.some(id => !id.includes('.'))
  if (hasRootIds && countAllTasks(planId) > 0) {
    throw new Error('Cannot provision root-level tasks: the plan already has tasks. Use absolute child IDs (e.g. "1.1") to expand an existing tree.')
  }

  // 3. Every non-root task must have its parent in DB or in the batch
  for (const id of ids) {
    const parent = parentOf(id)
    if (parent === null) continue
    if (!getTask(planId, parent) && !batchIds.has(parent)) {
      throw new Error(`Task "${id}" references parent "${parent}" which does not exist in the DB or in this batch.`)
    }
  }

  // 4. Validate depends_on for each task
  for (const id of ids) {
    const spec = input.tasks[id]
    if (!spec.depends_on || spec.depends_on.length === 0) continue

    const myParent = parentOf(id)

    for (const depId of spec.depends_on) {
      // Must be a sibling (same parent)
      if (parentOf(depId) !== myParent) {
        throw new Error(`Task "${id}" depends_on "${depId}" which is not a sibling (different parent).`)
      }
      // Dep must exist in DB or in batch
      if (!getTask(planId, depId) && !batchIds.has(depId)) {
        throw new Error(`Task "${id}" depends_on "${depId}" which does not exist in the DB or in this batch.`)
      }
      // Active tasks require completed deps
      if (spec.status === 'active') {
        const dep = getTask(planId, depId)
        if (!dep || dep.status !== 'completed') {
          throw new Error(`Task "${id}" has status "active" but depends_on "${depId}" which is not completed. Set status to "pending" or complete the dependency first.`)
        }
      }
    }
  }

  // Insert in depth-first, numerically ordered sequence (parents before children)
  const sortedIds = [...ids].sort(compareTaskIds)
  const now = new Date().toISOString()

  runTransaction(() => {
    for (const id of sortedIds) {
      const spec = input.tasks[id]
      const task: Task = {
        id,
        plan_id: planId,
        goal: spec.goal,
        status: spec.status ?? 'pending',
        result: null,
        abandon_reason: null,
        state: spec.initial_state ?? {},
        depends_on: spec.depends_on ?? null,
        notes: null,
        created_at: now,
        updated_at: now,
      }
      insertTask(task)
    }
  })

  touchPlan(planId)

  // Return context for shallowest/lowest-numbered task created
  const firstId = sortedIds[0]
  return buildContext(planId, firstId)
}
