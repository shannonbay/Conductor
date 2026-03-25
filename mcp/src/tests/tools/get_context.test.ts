import { describe, it, expect } from 'vitest'
import { get_context } from '../../tools/get_context.js'
import { create_plan } from '../../tools/create_plan.js'
import { create_task } from '../../tools/create_task.js'

describe('get_context', () => {
  it('returns error object (does not throw) when no project is open', async () => {
    const result = await get_context({ task_id: '1' })
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain('No plan is open')
  })

  it('throws for unknown task_id', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await expect(get_context({ task_id: '99' })).rejects.toThrow('not found')
  })

  it('returns full context for a task', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    const result = await get_context({ task_id: '1' })
    expect(result).toHaveProperty('focus')
    expect(result).toHaveProperty('tree_stats')
    expect(result).toHaveProperty('siblings')
    expect(result).toHaveProperty('children')
    expect((result as { focus: { id: string } }).focus.id).toBe('1')
  })

  it('returns context for a child task', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await create_task({ goal: 'child', parent_id: '1' })
    const result = await get_context({ task_id: '1.1' })
    expect((result as { focus: { id: string } }).focus.id).toBe('1.1')
    expect((result as { parent: { id: string } }).parent?.id).toBe('1')
  })

  it('is read-only — does not mutate state', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    const r1 = await get_context({ task_id: '1' })
    const r2 = await get_context({ task_id: '1' })
    expect((r1 as { focus: { id: string } }).focus.id).toBe('1')
    expect((r2 as { focus: { id: string } }).focus.id).toBe('1')
  })
})
