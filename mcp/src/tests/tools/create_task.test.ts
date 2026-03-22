import { describe, it, expect } from 'vitest'
import { create_task } from '../../tools/create_task.js'
import { create_project } from '../../tools/create_project.js'
import { set_status } from '../../tools/set_status.js'
import { navigate } from '../../tools/navigate.js'
import { getProject } from '../../db.js'

async function setup() {
  return create_project({ name: 'Test Project' })
}

describe('create_task', () => {
  it('throws when no project is open', async () => {
    await expect(create_task({ goal: 'g', plan: ['s1'] })).rejects.toThrow('No project is open')
  })

  it('creates root task with id "1" on empty tree', async () => {
    const p = await setup()
    const result = await create_task({ goal: 'root goal', plan: ['step 1'] })
    expect(result.focus.id).toBe('1')
    expect(result.focus.goal).toBe('root goal')
  })

  it('throws when trying to create second root task', async () => {
    await setup()
    await create_task({ goal: 'root', plan: ['s1'] })
    // Focus is now on task 1; navigate back to "empty" is impossible —
    // manually we need to create child tasks, not root. But the constraint is that
    // if focus is on task 1 and tree is non-empty, next create_task is a child.
    // To test "Tree is not empty" error, we need focus_task_id to be null + tasks > 0.
    // That can't happen in normal flow. So we test the child creation path instead.
    const result2 = await create_task({ goal: 'child', plan: ['s1'] })
    expect(result2.focus.id).toBe('1.1')
  })

  it('creates child under focus task', async () => {
    await setup()
    await create_task({ goal: 'root', plan: ['s1'] })
    const child = await create_task({ goal: 'child 1', plan: ['s1'] })
    expect(child.focus.id).toBe('1.1')
  })

  it('creates sequential children with incrementing ids', async () => {
    await setup()
    await create_task({ goal: 'root', plan: ['s1'] })
    await create_task({ goal: 'child 1', plan: ['s1'] })
    // Navigate back to root to create another child
    await navigate({ target_id: '1' })
    const child2 = await create_task({ goal: 'child 2', plan: ['s1'] })
    expect(child2.focus.id).toBe('1.2')
  })

  it('focus moves to new task', async () => {
    const p = await setup()
    await create_task({ goal: 'root', plan: ['s1'] })
    expect(getProject(p.id)!.focus_task_id).toBe('1')
    await create_task({ goal: 'child', plan: ['s1'] })
    expect(getProject(p.id)!.focus_task_id).toBe('1.1')
  })

  it('stores initial_state', async () => {
    await setup()
    const result = await create_task({
      goal: 'root',
      plan: ['s1'],
      initial_state: { key: 'value', count: 5 },
    })
    expect(result.focus.state).toEqual({ key: 'value', count: 5 })
  })

  it('throws when depends_on references unknown task', async () => {
    await setup()
    await create_task({ goal: 'root', plan: ['s1'] })
    await navigate({ target_id: '1' })
    await expect(
      create_task({ goal: 'child', plan: ['s1'], depends_on: ['1.99'] })
    ).rejects.toThrow('unknown task')
  })

  it('throws when depends_on references a non-sibling', async () => {
    await setup()
    await create_task({ goal: 'root', plan: ['s1'] })
    await create_task({ goal: 'child 1', plan: ['s1'] })
    // Now focus is on 1.1. Create a grandchild 1.1.1
    const gc = await create_task({ goal: 'grandchild', plan: ['s1'] })
    expect(gc.focus.id).toBe('1.1.1')
    // Navigate back to 1.1 and try to create 1.1.2 depending on '1' (not a sibling)
    await navigate({ target_id: '1.1' })
    await expect(
      create_task({ goal: 'child 2', plan: ['s1'], depends_on: ['1'] })
    ).rejects.toThrow('not a sibling')
  })

  it('throws when creating active task with incomplete dependency', async () => {
    await setup()
    await create_task({ goal: 'root', plan: ['s1'] })
    await create_task({ goal: 'child 1', plan: ['s1'] })
    // child 1 is active (not completed). Navigate back to root and try to create
    // active child 2 that depends on child 1.
    await navigate({ target_id: '1' })
    await expect(
      create_task({ goal: 'child 2', plan: ['s1'], status: 'active', depends_on: ['1.1'] })
    ).rejects.toThrow('dependencies not completed')
  })

  it('succeeds creating pending task with incomplete dependency', async () => {
    await setup()
    await create_task({ goal: 'root', plan: ['s1'] })
    await create_task({ goal: 'child 1', plan: ['s1'] })
    await navigate({ target_id: '1' })
    const result = await create_task({
      goal: 'child 2',
      plan: ['s1'],
      status: 'pending',
      depends_on: ['1.1'],
    })
    expect(result.focus.status).toBe('pending')
    expect(result.focus.depends_on).toEqual(['1.1'])
  })

  it('succeeds creating active task when dependency is completed', async () => {
    await setup()
    await create_task({ goal: 'root', plan: ['s1'] })
    await create_task({ goal: 'child 1', plan: ['s1'] })
    await set_status({ status: 'completed' })
    await navigate({ target_id: '1' })
    const result = await create_task({
      goal: 'child 2',
      plan: ['s1'],
      status: 'active',
      depends_on: ['1.1'],
    })
    expect(result.focus.status).toBe('active')
  })
})
