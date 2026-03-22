import { describe, it, expect } from 'vitest'
import { update_task } from '../../tools/update_task.js'
import { create_project } from '../../tools/create_project.js'
import { create_task } from '../../tools/create_task.js'
import { getTask } from '../../db.js'
import { getOpenProject } from '../../session.js'

describe('update_task', () => {
  it('throws when no project is open', async () => {
    await expect(update_task({ result: 'done' })).rejects.toThrow('No project is open')
  })

  it('updates the result field', async () => {
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root', plan: ['s1'] })
    await update_task({ result: 'progress made' })
    const task = getTask(getOpenProject()!, '1')!
    expect(task.result).toBe('progress made')
  })

  it('shallow-merges state_patch into existing state', async () => {
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root', plan: ['s1'], initial_state: { a: 1, b: 2 } })
    await update_task({ result: 'ok', state_patch: { b: 99, c: 3 } })
    const task = getTask(getOpenProject()!, '1')!
    expect(task.state).toEqual({ a: 1, b: 99, c: 3 })
  })

  it('replaces nested objects on shallow merge (not deep merge)', async () => {
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root', plan: ['s1'], initial_state: { obj: { x: 1, y: 2 } } })
    await update_task({ result: 'ok', state_patch: { obj: { x: 10 } } })
    const task = getTask(getOpenProject()!, '1')!
    // shallow merge replaces 'obj' entirely
    expect(task.state).toEqual({ obj: { x: 10 } })
  })

  it('advances step when advance_step is true', async () => {
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root', plan: ['s1', 's2', 's3'] })
    await update_task({ result: 'done step 1', advance_step: true })
    const task = getTask(getOpenProject()!, '1')!
    expect(task.step).toBe(1)
  })

  it('does not advance step when advance_step is false', async () => {
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root', plan: ['s1', 's2'] })
    await update_task({ result: 'update', advance_step: false })
    const task = getTask(getOpenProject()!, '1')!
    expect(task.step).toBe(0)
  })

  it('caps step at last plan index', async () => {
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root', plan: ['s1'] })  // plan.length = 1, max step = 0
    await update_task({ result: 'done', advance_step: true })
    const task = getTask(getOpenProject()!, '1')!
    expect(task.step).toBe(0)  // already at max
  })

  it('does not change focus', async () => {
    const p = await create_project({ name: 'Test' })
    await create_task({ goal: 'root', plan: ['s1'] })
    await create_task({ goal: 'child', plan: ['s1'] })
    // focus is on 1.1
    await update_task({ result: 'update on 1.1' })
    expect(getTask(p.id, '1.1')!.result).toBe('update on 1.1')
    expect(getTask(p.id, '1')!.result).toBeNull()
  })
})
