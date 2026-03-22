import { getProject, getTask, getChildren } from '../db.js'
import { getOpenProject } from '../session.js'
import { buildContext } from '../context.js'
import { SynthesizeSchema } from '../schema.js'

export async function synthesize(args: unknown) {
  const input = SynthesizeSchema.parse(args)

  const projectId = getOpenProject()
  if (!projectId) throw new Error('No project is open. Use open_project or create_project first.')

  const project = getProject(projectId)!
  const focusTaskId = project.focus_task_id
  if (!focusTaskId) throw new Error('No focus task. Use create_task to add the first task.')

  const targetId = input.target_id ?? focusTaskId
  const task = getTask(projectId, targetId)
  if (!task) throw new Error(`Task ${targetId} not found.`)

  const children = getChildren(projectId, targetId)

  const completed = children
    .filter(c => c.status === 'completed')
    .map(c => ({ id: c.id, goal: c.goal, result: c.result, state: c.state }))

  const abandoned = children
    .filter(c => c.status === 'abandoned')
    .map(c => ({ id: c.id, goal: c.goal, abandon_reason: c.abandon_reason }))

  const pending = children
    .filter(c => c.status !== 'completed' && c.status !== 'abandoned')
    .map(c => ({ id: c.id, goal: c.goal, status: c.status }))

  const context = buildContext(projectId, targetId)

  return {
    ...context,
    synthesis: { completed, abandoned, pending },
  }
}
