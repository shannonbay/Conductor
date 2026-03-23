import { describe, it, expect } from 'vitest'
import { set_status } from '../../tools/set_status.js'
import { create_project } from '../../tools/create_project.js'
import { create_task } from '../../tools/create_task.js'
import { navigate } from '../../tools/navigate.js'
import { getTask } from '../../db.js'
import { getOpenProject } from '../../session.js'

describe('set_status', () => {
  it('throws when no project is open', async () => {
    await expect(set_status({ status: 'completed' })).rejects.toThrow('No project is open')
  })

  it('throws when abandoned without reason', async () => {
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root', plan: ['s1'] })
    await expect(set_status({ status: 'abandoned' })).rejects.toThrow('reason is required')
  })

  it('stores abandon_reason when abandoned', async () => {
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root', plan: ['s1'] })
    await set_status({ status: 'abandoned', reason: 'approach failed' })
    const task = getTask(getOpenProject()!, '1')!
    expect(task.status).toBe('abandoned')
    expect(task.abandon_reason).toBe('approach failed')
  })

  it('throws when activating a task with unmet dependencies', async () => {
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root', plan: ['s1'] })
    // Create child 1.1 (active) and child 1.2 pending with depends_on 1.1
    await create_task({ goal: 'child 1', plan: ['s1'] })
    await navigate({ target_id: '1' })
    await create_task({ goal: 'child 2', plan: ['s1'], status: 'pending', depends_on: ['1.1'] })
    // Try to activate 1.2 while 1.1 is still active
    await expect(set_status({ task_id: '1.2', status: 'active' })).rejects.toThrow('unmet dependencies')
  })

  it('succeeds activating a task when all dependencies are completed', async () => {
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root', plan: ['s1'] })
    await create_task({ goal: 'child 1', plan: ['s1'] })
    await set_status({ status: 'completed' })
    await navigate({ target_id: '1' })
    await create_task({ goal: 'child 2', plan: ['s1'], status: 'pending', depends_on: ['1.1'] })
    const result = await set_status({ task_id: '1.2', status: 'active' })
    expect(result.focus).toBeDefined()
    const task = getTask(getOpenProject()!, '1.2')!
    expect(task.status).toBe('active')
  })

  it('returns warning when completing parent with unfinished children', async () => {
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root', plan: ['s1'] })
    await create_task({ goal: 'child still active', plan: ['s1'] })
    await navigate({ target_id: '1' })
    const result = await set_status({ status: 'completed' })
    expect(result).toHaveProperty('warning')
    expect((result as { warning: string }).warning).toContain('1.1')
    // Despite warning, status was still set
    expect(getTask(getOpenProject()!, '1')!.status).toBe('completed')
  })

  it('no warning when completing parent with all children resolved', async () => {
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root', plan: ['s1'] })
    await create_task({ goal: 'child', plan: ['s1'] })
    await set_status({ status: 'completed' })
    await navigate({ target_id: '1' })
    const result = await set_status({ status: 'completed' })
    expect(result).not.toHaveProperty('warning')
  })

  it('uses focus task when task_id is omitted', async () => {
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root', plan: ['s1'] })
    await set_status({ status: 'completed' })
    expect(getTask(getOpenProject()!, '1')!.status).toBe('completed')
  })

  it('uses explicit task_id when provided', async () => {
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root', plan: ['s1'] })
    await create_task({ goal: 'child', plan: ['s1'] })
    // focus is on 1.1; set status on 1 explicitly
    await set_status({ task_id: '1', status: 'completed' })
    expect(getTask(getOpenProject()!, '1')!.status).toBe('completed')
    expect(getTask(getOpenProject()!, '1.1')!.status).toBe('active')
  })

  it('throws for unknown task_id', async () => {
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root', plan: ['s1'] })
    await expect(set_status({ task_id: '99', status: 'completed' })).rejects.toThrow('not found')
  })
})
