import { describe, it, expect } from 'vitest'
import { update_task } from '../../tools/update_task.js'
import { create_plan } from '../../tools/create_plan.js'
import { create_task } from '../../tools/create_task.js'
import { getTask } from '../../db.js'
import { getOpenPlan } from '../../session.js'

describe('update_task', () => {
  it('throws when no project is open', async () => {
    await expect(update_task({})).rejects.toThrow('No plan is open')
  })

  it('updates the result field', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await update_task({ result: 'progress made' })
    const task = getTask(getOpenPlan()!, '1')!
    expect(task.result).toBe('progress made')
  })

  it('does not overwrite result when omitted', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await update_task({ result: 'initial' })
    await update_task({ state_patch: { x: 1 } })
    const task = getTask(getOpenPlan()!, '1')!
    expect(task.result).toBe('initial')
  })

  it('shallow-merges state_patch into existing state', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root', initial_state: { a: 1, b: 2 } })
    await update_task({ state_patch: { b: 99, c: 3 } })
    const task = getTask(getOpenPlan()!, '1')!
    expect(task.state).toEqual({ a: 1, b: 99, c: 3 })
  })

  it('replaces nested objects on shallow merge (not deep merge)', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root', initial_state: { obj: { x: 1, y: 2 } } })
    await update_task({ state_patch: { obj: { x: 10 } } })
    const task = getTask(getOpenPlan()!, '1')!
    // shallow merge replaces 'obj' entirely
    expect(task.state).toEqual({ obj: { x: 10 } })
  })

  it('does not change focus', async () => {
    const p = await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await create_task({ goal: 'child' })
    // focus is on 1.1
    await update_task({ result: 'update on 1.1' })
    expect(getTask(p.id, '1.1')!.result).toBe('update on 1.1')
    expect(getTask(p.id, '1')!.result).toBeNull()
  })
})
