import { getProject, getTask, countAllTasks, nextChildId, insertTask, updateProject, touchProject } from '../db.js'
import { getOpenProject } from '../session.js'
import { buildContext } from '../context.js'
import { CreateTaskSchema } from '../schema.js'

export async function create_task(args: unknown) {
  const input = CreateTaskSchema.parse(args)

  const projectId = getOpenProject()
  if (!projectId) throw new Error('No project is open. Use open_project or create_project first.')

  const project = getProject(projectId)!
  const parentId = project.focus_task_id

  let newId: string

  if (parentId === null) {
    // Creating root task — tree must be empty
    const total = countAllTasks(projectId)
    if (total > 0) throw new Error('Tree is not empty. Navigate to the desired parent task first.')
    newId = '1'
  } else {
    newId = nextChildId(projectId, parentId)
  }

  // Validate depends_on items exist as siblings and if status=active they're all completed
  if (input.depends_on && input.depends_on.length > 0) {
    for (const depId of input.depends_on) {
      const dep = getTask(projectId, depId)
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
        const dep = getTask(projectId, depId)
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
    project_id: projectId,
    goal: input.goal,
    plan: input.plan,
    step: 0,
    status: input.status,
    result: null,
    abandon_reason: null,
    state: input.initial_state ?? {},
    depends_on: input.depends_on ?? null,
    created_at: now,
    updated_at: now,
  }

  insertTask(task)
  updateProject(projectId, { focus_task_id: newId, updated_at: now })

  return buildContext(projectId, newId)
}
