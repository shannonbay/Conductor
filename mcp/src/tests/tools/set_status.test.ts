import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { set_status } from '../../tools/set_status.js'
import { update_task } from '../../tools/update_task.js'
import { create_plan } from '../../tools/create_plan.js'
import { create_task } from '../../tools/create_task.js'
import { getTask } from '../../db.js'
import { getOpenPlan } from '../../session.js'

describe('set_status with CONDUCTOR_REQUIRE_DECOMPOSE=1', () => {
  beforeEach(() => { process.env.CONDUCTOR_REQUIRE_DECOMPOSE = '1' })
  afterEach(() => { delete process.env.CONDUCTOR_REQUIRE_DECOMPOSE })

  it('blocks activating a leaf task that is not marked atomic', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root', status: 'pending' })
    await expect(set_status({ task_id: '1', status: 'active' })).rejects.toThrow('has no sub-tasks yet')
  })

  it('allows activating a task that has children', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root', status: 'pending' })
    await create_task({ goal: 'child', parent_id: '1', status: 'pending' })
    await set_status({ task_id: '1', status: 'active' })
    expect(getTask(getOpenPlan()!, '1')!.status).toBe('active')
  })

  it('allows activating a leaf task marked atomic', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root', status: 'pending' })
    await update_task({ task_id: '1', state_patch: { atomic: true } })
    await set_status({ task_id: '1', status: 'active' })
    expect(getTask(getOpenPlan()!, '1')!.status).toBe('active')
  })

  it('only looks at the open plan, not same-numbered tasks in other plans', async () => {
    await create_plan({ name: 'Other' })
    await create_task({ goal: 'root', status: 'pending' })
    await create_task({ goal: 'child', parent_id: '1', status: 'pending' })
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root', status: 'pending' })
    await expect(set_status({ task_id: '1', status: 'active' })).rejects.toThrow('has no sub-tasks yet')
  })
})

describe('set_status with CONDUCTOR_STRICT_COMPLETE=1', () => {
  beforeEach(() => { process.env.CONDUCTOR_STRICT_COMPLETE = '1' })
  afterEach(() => { delete process.env.CONDUCTOR_STRICT_COMPLETE })

  it('blocks completing a parent with unresolved children', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await create_task({ goal: 'child', parent_id: '1', status: 'pending' })
    await expect(set_status({ task_id: '1', status: 'completed' })).rejects.toThrow('not yet completed or abandoned: 1.1')
    expect(getTask(getOpenPlan()!, '1')!.status).toBe('active')
  })

  it('allows completion once children are completed or abandoned', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await create_task({ goal: 'a', parent_id: '1' })
    await create_task({ goal: 'b', parent_id: '1' })
    await set_status({ task_id: '1.1', status: 'completed' })
    await set_status({ task_id: '1.2', status: 'abandoned', reason: 'not needed' })
    const result = await set_status({ task_id: '1', status: 'completed' })
    expect(result).not.toHaveProperty('warning')
    expect(getTask(getOpenPlan()!, '1')!.status).toBe('completed')
  })
})

describe('set_status', () => {
  it('throws when no project is open', async () => {
    await expect(set_status({ task_id: '1', status: 'completed' })).rejects.toThrow('No plan is open')
  })

  it('throws when abandoned without reason', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await expect(set_status({ task_id: '1', status: 'abandoned' })).rejects.toThrow('reason is required')
  })

  it('stores abandon_reason when abandoned', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await set_status({ task_id: '1', status: 'abandoned', reason: 'approach failed' })
    const task = getTask(getOpenPlan()!, '1')!
    expect(task.status).toBe('abandoned')
    expect(task.abandon_reason).toBe('approach failed')
  })

  it('throws when activating a task with unmet dependencies', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await create_task({ goal: 'child 1', parent_id: '1' })
    await create_task({ goal: 'child 2', parent_id: '1', status: 'pending', depends_on: ['1.1'] })
    // Try to activate 1.2 while 1.1 is still active
    await expect(set_status({ task_id: '1.2', status: 'active' })).rejects.toThrow('unmet dependencies')
  })

  it('succeeds activating a task when all dependencies are completed', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await create_task({ goal: 'child 1', parent_id: '1' })
    await set_status({ task_id: '1.1', status: 'completed' })
    await create_task({ goal: 'child 2', parent_id: '1', status: 'pending', depends_on: ['1.1'] })
    const result = await set_status({ task_id: '1.2', status: 'active' })
    expect(result.focus).toBeDefined()
    const task = getTask(getOpenPlan()!, '1.2')!
    expect(task.status).toBe('active')
  })

  it('returns warning when completing parent with unfinished children', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await create_task({ goal: 'child still active', parent_id: '1' })
    const result = await set_status({ task_id: '1', status: 'completed' })
    expect(result).toHaveProperty('warning')
    expect((result as { warning: string }).warning).toContain('1.1')
    // Despite warning, status was still set
    expect(getTask(getOpenPlan()!, '1')!.status).toBe('completed')
  })

  it('no warning when completing parent with all children resolved', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await create_task({ goal: 'child', parent_id: '1' })
    await set_status({ task_id: '1.1', status: 'completed' })
    const result = await set_status({ task_id: '1', status: 'completed' })
    expect(result).not.toHaveProperty('warning')
  })

  it('updates any task by explicit task_id', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await set_status({ task_id: '1', status: 'completed' })
    expect(getTask(getOpenPlan()!, '1')!.status).toBe('completed')
  })

  it('throws for unknown task_id', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await expect(set_status({ task_id: '99', status: 'completed' })).rejects.toThrow('not found')
  })
})
