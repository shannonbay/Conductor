import { describe, it, expect } from 'vitest'
import { todo_list, todo_add, todo_set } from '../../tools/todos.js'
import { getEvents } from '../../db.js'

const DIR = '/work/proj'

describe('to-do tools', () => {
  it('adds to the project\'s To do list, lists it, and ticks items off', async () => {
    expect(await todo_list({ working_dir: DIR })).toEqual({ lists: [] })
    const a = await todo_add({ working_dir: DIR, text: 'Try it on my phone' })
    expect(a).toMatchObject({ item_id: '1', created_list: true })
    await todo_add({ working_dir: DIR, text: 'Rename the package', added_by: 'agent' })
    const { lists } = await todo_list({ working_dir: DIR })
    expect(lists).toEqual([expect.objectContaining({ name: 'To do', open: 2, items: [expect.objectContaining({ text: 'Try it on my phone' }), expect.objectContaining({ text: 'Rename the package' })] })])

    expect((await todo_set({ list_id: a.list_id, item_id: '1', status: 'completed' })).item).toMatchObject({ status: 'completed' })
    expect((await todo_list({ working_dir: DIR })).lists[0]).toMatchObject({ open: 1, done: 1 })
    expect(getEvents(a.list_id).map((e) => [e.event_type, e.actor])).toEqual(expect.arrayContaining([['task_created', 'agent'], ['status_changed', 'human']]))
    await expect(todo_add({ working_dir: DIR, text: '   ' })).rejects.toThrow()
  })
})
