import { describe, it, expect } from 'vitest'
import { set_status } from '../../tools/set_status.js'
import { create_plan } from '../../tools/create_plan.js'
import { create_task } from '../../tools/create_task.js'
import { getTask } from '../../db.js'
import { getOpenPlan } from '../../session.js'

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
