import { getPlan, getTask, countAllTasks, nextChildId, insertTask, updatePlan, touchPlan } from '../db.js'
import { getOpenPlan } from '../session.js'
import { buildContext } from '../context.js'
import { CreateTaskSchema } from '../schema.js'

export async function create_task(args: unknown) {
  const input = CreateTaskSchema.parse(args)

  const planId = getOpenPlan()
  if (!planId) throw new Error('No plan is open. Use open_plan or create_plan first.')

  const project = getPlan(planId)!
  const parentId = project.focus_task_id

  let newId: string

  if (parentId === null) {
    // Creating root task — tree must be empty
    const total = countAllTasks(planId)
    if (total > 0) throw new Error('Tree is not empty. Navigate to the desired parent task first.')
    newId = '1'
  } else {
    newId = nextChildId(planId, parentId)
  }

  // Validate depends_on items exist as siblings and if status=active they're all completed
  if (input.depends_on && input.depends_on.length > 0) {
    for (const depId of input.depends_on) {
      const dep = getTask(planId, depId)
      if (!dep) throw new Error(`depends_on references unknown task: ${depId}`)

      // Verify it's a sibling
      const depSegments = depId.split('.')
      const newSegments = newId.split('.')
      const depParent = depSegments.slice(0, -1).join('.')
      const newParent = newSegments.slice(0, -1).join('.')
      if (depParent !== newParent) {
        throw new Error(`depends_on task ${depId} is not a sibling of ${newId}. Dependencies must be between siblings.`)
      }
    }

    if (input.status === 'active') {
      const incomplete = input.depends_on.filter(depId => {
        const dep = getTask(planId, depId)
        return dep?.status !== 'completed'
      })
      if (incomplete.length > 0) {
        throw new Error(`Cannot create active task: dependencies not completed: ${incomplete.join(', ')}`)
      }
    }
  }

  const now = new Date().toISOString()
  const task = {
    id: newId,
    plan_id: planId,
    goal: input.goal,
    status: input.status,
    result: null,
    abandon_reason: null,
    state: input.initial_state ?? {},
    depends_on: input.depends_on ?? null,
    notes: null,
    created_at: now,
    updated_at: now,
  }

  insertTask(task)
  updatePlan(planId, { focus_task_id: newId, updated_at: now })

  return buildContext(planId, newId)
}
