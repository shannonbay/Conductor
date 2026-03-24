import { describe, it, expect } from 'vitest'
import { navigate } from '../../tools/navigate.js'
import { create_plan } from '../../tools/create_plan.js'
import { create_task } from '../../tools/create_task.js'
import { getPlan } from '../../db.js'

describe('navigate', () => {
  it('throws when no project is open', async () => {
    await expect(navigate({ target_id: '1' })).rejects.toThrow('No plan is open')
  })

  it('throws for unknown task id', async () => {
    const p = await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await expect(navigate({ target_id: '99' })).rejects.toThrow('not found')
  })

  it('updates focus_task_id on the project', async () => {
    const p = await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await create_task({ goal: 'child' })
    // focus is on 1.1; navigate back to 1
    await navigate({ target_id: '1' })
    expect(getPlan(p.id)!.focus_task_id).toBe('1')
  })

  it('returns context for the target task', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await create_task({ goal: 'child' })
    const result = await navigate({ target_id: '1' })
    expect(result.focus.id).toBe('1')
    expect(result.focus.goal).toBe('root')
  })
})
