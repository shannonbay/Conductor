import { describe, it, expect } from 'vitest'
import { create_task } from '../../tools/create_task.js'
import { create_plan } from '../../tools/create_plan.js'
import { set_status } from '../../tools/set_status.js'

async function setup() {
  return create_plan({ name: 'Test Project' })
}

describe('create_task', () => {
  it('throws when no project is open', async () => {
    await expect(create_task({ goal: 'g' })).rejects.toThrow('No plan is open')
  })

  it('creates root task with id "1" on empty tree', async () => {
    await setup()
    const result = await create_task({ goal: 'root goal' })
    expect(result.focus.id).toBe('1')
    expect(result.focus.goal).toBe('root goal')
  })

  it('throws when creating root task on non-empty tree', async () => {
    await setup()
    await create_task({ goal: 'root' })
    await expect(create_task({ goal: 'another root' })).rejects.toThrow('parent_id is required')
  })

  it('creates child under explicit parent_id', async () => {
    await setup()
    await create_task({ goal: 'root' })
    const child = await create_task({ goal: 'child 1', parent_id: '1' })
    expect(child.focus.id).toBe('1.1')
  })

  it('creates sequential children with incrementing ids', async () => {
    await setup()
    await create_task({ goal: 'root' })
    await create_task({ goal: 'child 1', parent_id: '1' })
    const child2 = await create_task({ goal: 'child 2', parent_id: '1' })
    expect(child2.focus.id).toBe('1.2')
  })

  it('throws when parent_id references unknown task', async () => {
    await setup()
    await expect(create_task({ goal: 'child', parent_id: '99' })).rejects.toThrow('not found')
  })

  it('stores initial_state', async () => {
    await setup()
    const result = await create_task({
      goal: 'root',
      initial_state: { key: 'value', count: 5 },
    })
    expect(result.focus.state).toEqual({ key: 'value', count: 5 })
  })

  it('throws when depends_on references unknown task', async () => {
    await setup()
    await create_task({ goal: 'root' })
    await expect(
      create_task({ goal: 'child', parent_id: '1', depends_on: ['1.99'] })
    ).rejects.toThrow('unknown task')
  })

  it('throws when depends_on references a non-sibling', async () => {
    await setup()
    await create_task({ goal: 'root' })
    await create_task({ goal: 'child 1', parent_id: '1' })
    await create_task({ goal: 'grandchild', parent_id: '1.1' })
    // Try to create 1.1.2 depending on '1' (not a sibling of 1.1.x)
    await expect(
      create_task({ goal: 'grandchild 2', parent_id: '1.1', depends_on: ['1'] })
    ).rejects.toThrow('not a sibling')
  })

  it('throws when creating active task with incomplete dependency', async () => {
    await setup()
    await create_task({ goal: 'root' })
    await create_task({ goal: 'child 1', parent_id: '1' })
    // child 1 is active (not completed). Try to create active child 2 depending on it.
    await expect(
      create_task({ goal: 'child 2', parent_id: '1', status: 'active', depends_on: ['1.1'] })
    ).rejects.toThrow('dependencies not completed')
  })

  it('succeeds creating pending task with incomplete dependency', async () => {
    await setup()
    await create_task({ goal: 'root' })
    await create_task({ goal: 'child 1', parent_id: '1' })
    const result = await create_task({
      goal: 'child 2',
      parent_id: '1',
      status: 'pending',
      depends_on: ['1.1'],
    })
    expect(result.focus.status).toBe('pending')
    expect(result.focus.depends_on).toEqual(['1.1'])
  })

  it('succeeds creating active task when dependency is completed', async () => {
    await setup()
    await create_task({ goal: 'root' })
    await create_task({ goal: 'child 1', parent_id: '1' })
    await set_status({ task_id: '1.1', status: 'completed' })
    const result = await create_task({
      goal: 'child 2',
      parent_id: '1',
      status: 'active',
      depends_on: ['1.1'],
    })
    expect(result.focus.status).toBe('active')
  })
})
