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

  describe('notes', () => {
    it('sets notes', async () => {
      await create_plan({ name: 'Test' })
      await create_task({ goal: 'root' })
      await update_task({ notes: 'some context' })
      expect(getTask(getOpenPlan()!, '1')!.notes).toBe('some context')
    })

    it('overwrites notes on subsequent call', async () => {
      await create_plan({ name: 'Test' })
      await create_task({ goal: 'root' })
      await update_task({ notes: 'first' })
      await update_task({ notes: 'second' })
      expect(getTask(getOpenPlan()!, '1')!.notes).toBe('second')
    })

    it('clears notes when passed null', async () => {
      await create_plan({ name: 'Test' })
      await create_task({ goal: 'root' })
      await update_task({ notes: 'something' })
      await update_task({ notes: null })
      expect(getTask(getOpenPlan()!, '1')!.notes).toBeNull()
    })

    it('does not clear notes when omitted', async () => {
      await create_plan({ name: 'Test' })
      await create_task({ goal: 'root' })
      await update_task({ notes: 'keep me' })
      await update_task({ result: 'other update' })
      expect(getTask(getOpenPlan()!, '1')!.notes).toBe('keep me')
    })
  })

  describe('goal editing', () => {
    it('renames goal on a pending task', async () => {
      await create_plan({ name: 'Test' })
      await create_task({ goal: 'original', status: 'pending' })
      await update_task({ goal: 'renamed' })
      expect(getTask(getOpenPlan()!, '1')!.goal).toBe('renamed')
    })

    it('rejects goal edit on an active task', async () => {
      await create_plan({ name: 'Test' })
      await create_task({ goal: 'root', status: 'active' })
      await expect(update_task({ goal: 'new name' })).rejects.toThrow('pending')
    })

    it('rejects goal edit on a completed task', async () => {
      const { set_status } = await import('../../tools/set_status.js')
      await create_plan({ name: 'Test' })
      await create_task({ goal: 'root', status: 'active' })
      await set_status({ status: 'completed', result: 'done' })
      await expect(update_task({ goal: 'new name' })).rejects.toThrow('pending')
    })

    it('rejects empty string goal', async () => {
      await create_plan({ name: 'Test' })
      await create_task({ goal: 'root', status: 'pending' })
      await expect(update_task({ goal: '' })).rejects.toThrow()
    })
  })
})
