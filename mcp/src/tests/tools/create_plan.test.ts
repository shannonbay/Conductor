import { describe, it, expect } from 'vitest'
import { create_plan } from '../../tools/create_plan.js'
import { getOpenPlan } from '../../session.js'

describe('create_plan', () => {
  it('returns a plan with the given name', async () => {
    const result = await create_plan({ name: 'My plan' })
    expect(result.name).toBe('My plan')
    expect(result.status).toBe('active')
    expect(result.focus_task_id).toBeNull()
  })

  it('id starts with plan_', async () => {
    const result = await create_plan({ name: 'Test' })
    expect(result.id).toMatch(/^plan_/)
  })

  it('sets the session open plan', async () => {
    const result = await create_plan({ name: 'Test' })
    expect(getOpenPlan()).toBe(result.id)
  })

  it('description is optional and defaults to null', async () => {
    const result = await create_plan({ name: 'No Desc' })
    expect(result.description).toBeNull()
  })

  it('description is stored when provided', async () => {
    const result = await create_plan({ name: 'With Desc', description: 'some desc' })
    expect(result.description).toBe('some desc')
  })

  it('includes empty tree_stats', async () => {
    const result = await create_plan({ name: 'Test' })
    expect(result.tree_stats).toEqual({ total_tasks: 0, active: 0, completed: 0, pending: 0, abandoned: 0 })
  })

  it('throws on missing name', async () => {
    await expect(create_plan({})).rejects.toThrow()
  })
})
