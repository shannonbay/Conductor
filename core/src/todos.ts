/**
 * The person's to-do lists: things agreed in a conversation that must outlive
 * it (and its compactions). A list is an ordinary active plan in the
 * project's directory (not a goal), and each to-do is one of its tasks, so a
 * plan made earlier, like a roadmap, shows up as a list too. New to-dos go to
 * a plan named "To do", made on first use.
 *
 * A plan with one root task that has children (a roadmap's "1" over "1.1",
 * "1.2", ...) shows the children as its to-dos; the root is only a heading.
 */
import { randomUUID } from 'crypto'
import type { Database } from './sqlite.js'
import { getAllTasks, getPlan, getTask, insertPlan, insertTask, nextChildId, touchPlan, updateTask } from './queries.js'
import type { PlanRow, Task, TaskStatus } from './types.js'

export const DEFAULT_LIST = 'To do'

export interface TodoItem {
  id: string
  text: string
  status: TaskStatus
  /** 0 for a top-level to-do, 1 for one under it, ... */
  depth: number
  notes: string | null
}

export interface TodoList {
  id: string
  name: string
  items: TodoItem[]
  open: number
  done: number
}

/** Paths compare case- and slash-insensitively (Windows spells one folder several ways). */
const samePath = (a: string, b: string) => norm(a) === norm(b)
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

function listPlans(db: Database, workingDir: string): PlanRow[] {
  const plans = db.prepare("SELECT * FROM plans WHERE status = 'active' AND kind != 'goal' ORDER BY updated_at DESC").all() as PlanRow[]
  return plans.filter((p) => samePath(p.working_dir, workingDir))
}

/** The task a list adds under: a single root with children is a heading; otherwise to-dos are roots. */
function headingOf(tasks: Task[]): string | null {
  const roots = tasks.filter((t) => !t.id.includes('.'))
  if (roots.length !== 1) return null
  return tasks.some((t) => t.id.startsWith(`${roots[0]!.id}.`)) ? roots[0]!.id : null
}

function toList(db: Database, plan: PlanRow): TodoList {
  const tasks = getAllTasks(db, plan.id).filter((t) => !t.archived_at)
  const heading = headingOf(tasks)
  const shown = heading ? tasks.filter((t) => t.id !== heading) : tasks
  const base = heading ? 2 : 1
  const items = shown.map((t) => ({ id: t.id, text: t.goal, status: t.status, depth: t.id.split('.').length - base, notes: t.notes }))
  const done = items.filter((i) => i.status === 'completed' || i.status === 'abandoned').length
  return { id: plan.id, name: plan.name, items, open: items.length - done, done }
}

/** The project's lists, the default "To do" first, then the most recently changed. */
export function todoLists(db: Database, workingDir: string): TodoList[] {
  const plans = listPlans(db, workingDir)
  plans.sort((a, b) => Number(b.name === DEFAULT_LIST) - Number(a.name === DEFAULT_LIST))
  return plans.map((p) => toList(db, p))
}

/** Adds a to-do: to the given list, or to the project's "To do" list (made on first use). */
export function addTodo(
  db: Database, input: { workingDir: string; text: string; listId?: string; by?: 'human' | 'agent' },
): { listId: string; itemId: string; created: boolean } {
  const text = input.text.trim()
  if (!text) throw new Error('A to-do needs some text.')
  const now = new Date().toISOString()
  let plan = input.listId ? getPlan(db, input.listId) : listPlans(db, input.workingDir).find((p) => p.name === DEFAULT_LIST)
  if (input.listId && (!plan || plan.kind === 'goal')) throw new Error(`List ${input.listId} not found.`)
  let created = false
  if (!plan) {
    const id = `plan_${randomUUID().replace(/-/g, '').slice(0, 10)}`
    insertPlan(db, { id, name: DEFAULT_LIST, description: 'Your to-do list for this project', status: 'active', working_dir: input.workingDir, created_at: now, updated_at: now })
    plan = getPlan(db, id)!
    created = true
  }
  const parent = headingOf(getAllTasks(db, plan.id).filter((t) => !t.archived_at))
  const itemId = nextChildId(db, plan.id, parent)
  insertTask(db, {
    id: itemId, plan_id: plan.id, goal: text, status: 'pending', result: null, abandon_reason: null, state: {},
    depends_on: null, notes: null, created_by: input.by ?? 'human', created_at: now, updated_at: now,
  })
  touchPlan(db, plan.id)
  return { listId: plan.id, itemId, created }
}

/** Ticks a to-do off (completed), back on (pending), or marks it under way (active), with an optional note. */
export function setTodo(db: Database, listId: string, itemId: string, status: 'pending' | 'active' | 'completed', notes?: string): TodoItem {
  const task = getTask(db, listId, itemId)
  if (!task) throw new Error(`To-do ${itemId} not found in list ${listId}.`)
  updateTask(db, listId, itemId, { status, updated_at: new Date().toISOString(), ...(notes !== undefined && { notes }) })
  touchPlan(db, listId)
  const t = getTask(db, listId, itemId)!
  return { id: t.id, text: t.goal, status: t.status, depth: 0, notes: t.notes }
}
