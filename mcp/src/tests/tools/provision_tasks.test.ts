import { describe, it, expect } from 'vitest'
import { provision_tasks } from '../../tools/provision_tasks.js'
import { create_plan } from '../../tools/create_plan.js'
import { create_task } from '../../tools/create_task.js'
import { set_status } from '../../tools/set_status.js'
import { getTask } from '../../db.js'

async function setup() {
  return create_plan({ name: 'Test Plan' })
}

describe('provision_tasks', () => {
  it('throws when no plan is open', async () => {
    await expect(provision_tasks({ tasks: { '1': { goal: 'root' } } })).rejects.toThrow('No plan is open')
  })

  it('throws when tasks is empty', async () => {
    await setup()
    await expect(provision_tasks({ tasks: {} })).rejects.toThrow('must not be empty')
  })

  it('provisions a full tree into an empty plan', async () => {
    const plan = await setup()
    await provision_tasks({
      tasks: {
        '1':     { goal: 'Root task', status: 'active' },
        '1.1':   { goal: 'Child one', status: 'pending' },
        '1.2':   { goal: 'Child two', status: 'pending' },
        '1.1.1': { goal: 'Grandchild', status: 'pending' },
      },
    })

    expect(getTask(plan.id, '1')?.goal).toBe('Root task')
    expect(getTask(plan.id, '1.1')?.goal).toBe('Child one')
    expect(getTask(plan.id, '1.2')?.goal).toBe('Child two')
    expect(getTask(plan.id, '1.1.1')?.goal).toBe('Grandchild')
  })

  it('returns context for the shallowest, lowest-numbered task', async () => {
    await setup()
    const result = await provision_tasks({
      tasks: {
        '1':   { goal: 'Root', status: 'active' },
        '1.2': { goal: 'Second child', status: 'pending' },
        '1.1': { goal: 'First child', status: 'pending' },
      },
    })

    expect(result.focus.id).toBe('1')
  })

  it('sets focus to lowest-numbered when all tasks share the same depth', async () => {
    await setup()
    await create_task({ goal: 'root' })
    const result = await provision_tasks({
      tasks: {
        '1.2': { goal: 'Second child', status: 'pending' },
        '1.1': { goal: 'First child', status: 'pending' },
      },
    })

    expect(result.focus.id).toBe('1.1')
  })

  it('provisions a sub-tree under an existing task', async () => {
    const plan = await setup()
    await create_task({ goal: 'root' })
    await provision_tasks({
      tasks: {
        '1.1': { goal: 'Child one', status: 'pending' },
        '1.2': { goal: 'Child two', status: 'pending' },
      },
    })

    expect(getTask(plan.id, '1.1')?.goal).toBe('Child one')
    expect(getTask(plan.id, '1.2')?.goal).toBe('Child two')
  })

  it('returns context view with children and tree stats', async () => {
    await setup()
    const result = await provision_tasks({
      tasks: {
        '1':   { goal: 'Root', status: 'active' },
        '1.1': { goal: 'Child', status: 'pending' },
      },
    })

    expect(result.focus.id).toBe('1')
    expect(result.children).toHaveLength(1)
    expect(result.children[0].id).toBe('1.1')
    expect(result.tree_stats.total_tasks).toBe(2)
    expect(result.tree_stats.pending).toBe(1)
    expect(result.tree_stats.active).toBe(1)
  })

  it('stores initial_state on tasks', async () => {
    const plan = await setup()
    await provision_tasks({
      tasks: {
        '1': { goal: 'Root', initial_state: { phase: 'init', count: 0 } },
      },
    })

    expect(getTask(plan.id, '1')?.state).toEqual({ phase: 'init', count: 0 })
  })

  it('stores depends_on correctly', async () => {
    const plan = await setup()
    await provision_tasks({
      tasks: {
        '1':   { goal: 'Root', status: 'active' },
        '1.1': { goal: 'First', status: 'pending' },
        '1.2': { goal: 'Second', status: 'pending', depends_on: ['1.1'] },
      },
    })

    expect(getTask(plan.id, '1.2')?.depends_on).toEqual(['1.1'])
  })

  it('rejects duplicate IDs that already exist in DB', async () => {
    const plan = await setup()
    await create_task({ goal: 'existing root' })

    await expect(
      provision_tasks({ tasks: { '1': { goal: 'duplicate root' } } })
    ).rejects.toThrow('already exists')
  })

  it('rejects root-level tasks when plan already has tasks', async () => {
    await setup()
    await create_task({ goal: 'existing root' })

    await expect(
      provision_tasks({ tasks: { '2': { goal: 'second root' } } })
    ).rejects.toThrow('already has tasks')
  })

  it('rejects tasks with missing parent not in DB or batch', async () => {
    await setup()
    await create_task({ goal: 'root' })

    await expect(
      provision_tasks({ tasks: { '1.1.1': { goal: 'orphan grandchild' } } })
    ).rejects.toThrow('parent "1.1"')
  })

  it('allows parent to be supplied in the same batch', async () => {
    const plan = await setup()
    await provision_tasks({
      tasks: {
        '1':     { goal: 'Root', status: 'active' },
        '1.1':   { goal: 'Child', status: 'pending' },
        '1.1.1': { goal: 'Grandchild — parent in batch', status: 'pending' },
      },
    })

    expect(getTask(plan.id, '1.1.1')?.goal).toBe('Grandchild — parent in batch')
  })

  it('rejects depends_on referencing a non-sibling', async () => {
    await setup()
    await expect(
      provision_tasks({
        tasks: {
          '1':   { goal: 'Root', status: 'active' },
          '1.1': { goal: 'Child', status: 'pending', depends_on: ['1'] },
        },
      })
    ).rejects.toThrow('not a sibling')
  })

  it('rejects depends_on referencing an ID not in DB or batch', async () => {
    await setup()
    await expect(
      provision_tasks({
        tasks: {
          '1':   { goal: 'Root', status: 'active' },
          '1.2': { goal: 'Child', status: 'pending', depends_on: ['1.1'] },
        },
      })
    ).rejects.toThrow('"1.1"')
  })

  it('rejects active task with incomplete dep', async () => {
    await setup()
    await expect(
      provision_tasks({
        tasks: {
          '1':   { goal: 'Root', status: 'active' },
          '1.1': { goal: 'First', status: 'pending' },
          '1.2': { goal: 'Second', status: 'active', depends_on: ['1.1'] },
        },
      })
    ).rejects.toThrow('not completed')
  })

  it('allows active task with completed dep already in DB', async () => {
    const plan = await setup()
    await create_task({ goal: 'root' })
    await create_task({ goal: 'child 1', parent_id: '1' })
    await set_status({ task_id: '1.1', status: 'completed', result: 'done' })

    const result = await provision_tasks({
      tasks: {
        '1.2': { goal: 'Child 2 — active dep on completed 1.1', status: 'active', depends_on: ['1.1'] },
      },
    })

    expect(getTask(plan.id, '1.2')?.status).toBe('active')
    expect(result.focus.id).toBe('1.2')
  })

  it('is atomic — rolls back all inserts on error', async () => {
    const plan = await setup()
    await create_task({ goal: 'root' })

    await expect(
      provision_tasks({
        tasks: {
          '1.1': { goal: 'Valid child' },
          '1.2': { goal: 'Child with bad dep', depends_on: ['1.99'] },
        },
      })
    ).rejects.toThrow()

    // 1.1 must NOT have been inserted (transaction rolled back)
    expect(getTask(plan.id, '1.1')).toBeUndefined()
  })
})
