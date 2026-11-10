import { describe, it, expect, beforeEach } from 'vitest'
import type { Database } from './sqlite.js'
import { openDatabase, insertPlan, insertTask, createGoal, todoLists, addTodo, setTodo, getTask, DEFAULT_LIST } from './index.js'

let db: Database
const now = new Date().toISOString()
const DIR = 'C:\\Users\\me\\proj'

function task(planId: string, id: string, goal: string) {
  insertTask(db, { id, plan_id: planId, goal, status: 'pending', result: null, abandon_reason: null, state: {}, depends_on: null, notes: null, created_by: 'agent', created_at: now, updated_at: now })
}

beforeEach(() => {
  db = openDatabase(':memory:')
})

describe('to-do lists', () => {
  it('makes the "To do" list on first use and adds to it', () => {
    expect(todoLists(db, DIR)).toEqual([])
    const first = addTodo(db, { workingDir: DIR, text: 'Try it on my phone' })
    expect(first).toMatchObject({ itemId: '1', created: true })
    const second = addTodo(db, { workingDir: 'c:/users/me/proj/', text: 'Rename the package', by: 'agent' })
    expect(second).toMatchObject({ listId: first.listId, itemId: '2', created: false })
    expect(todoLists(db, DIR)).toEqual([
      expect.objectContaining({ name: DEFAULT_LIST, open: 2, done: 0, items: [
        expect.objectContaining({ id: '1', text: 'Try it on my phone', depth: 0 }),
        expect.objectContaining({ id: '2', text: 'Rename the package' }),
      ] }),
    ])
    expect(getTask(db, first.listId, '2')!.created_by).toBe('agent')
  })

  it("shows a roadmap's children under its heading, and adds there; goals and other folders are left out", () => {
    insertPlan(db, { id: 'p1', name: 'Roadmap', description: null, status: 'active', working_dir: DIR, created_at: now, updated_at: now })
    task('p1', '1', 'Roadmap heading')
    task('p1', '1.1', 'Approvals on my phone')
    task('p1', '1.2', 'Runs with Claude Code closed')
    insertPlan(db, { id: 'p2', name: 'Elsewhere', description: null, status: 'active', working_dir: 'C:\\other', created_at: now, updated_at: now })
    createGoal(db, { id: 'g1', name: 'Inbox', description: null, status: 'active', working_dir: DIR, created_at: now, updated_at: now }, { objective: 'x' })

    const [roadmap] = todoLists(db, DIR)
    expect(todoLists(db, DIR)).toHaveLength(1)
    expect(roadmap!.items.map((i) => [i.id, i.depth])).toEqual([['1.1', 0], ['1.2', 0]])
    expect(addTodo(db, { workingDir: DIR, text: 'Templates', listId: 'p1' }).itemId).toBe('1.3')
    expect(() => addTodo(db, { workingDir: DIR, text: 'x', listId: 'g1' })).toThrow(/not found/)
  })

  it('ticks a to-do off and back on, and notes one under way', () => {
    const { listId } = addTodo(db, { workingDir: DIR, text: 'Write the docs' })
    expect(setTodo(db, listId, '1', 'completed')).toMatchObject({ status: 'completed' })
    expect(todoLists(db, DIR)[0]).toMatchObject({ open: 0, done: 1 })
    setTodo(db, listId, '1', 'active', 'Running as the one-off goal "Write the docs"')
    expect(getTask(db, listId, '1')).toMatchObject({ status: 'active', notes: 'Running as the one-off goal "Write the docs"' })
    expect(() => setTodo(db, listId, '9', 'completed')).toThrow(/not found/)
    expect(() => addTodo(db, { workingDir: DIR, text: '  ' })).toThrow(/needs some text/)
  })
})
