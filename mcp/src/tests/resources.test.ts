import { describe, it, expect } from 'vitest'
import { handleListResources, handleReadResource } from '../resources.js'
import { create_plan } from '../tools/create_plan.js'
import { create_task } from '../tools/create_task.js'
import { navigate } from '../tools/navigate.js'

async function seedPlan(name: string) {
  const plan = await create_plan({ name })
  await create_task({ goal: 'Root task', status: 'active' })
  await create_task({ goal: 'Child one', status: 'pending' })
  // navigate back to root to create second child as sibling
  await navigate({ target_id: '1' })
  await create_task({ goal: 'Child two', status: 'pending' })
  return plan
}

describe('handleListResources', () => {
  it('returns empty list when no plans exist', async () => {
    const result = await handleListResources()
    expect(result.resources).toEqual([])
  })

  it('returns two URIs per active plan (metadata + tree)', async () => {
    const plan = await create_plan({ name: 'Alpha' })
    const result = await handleListResources()
    expect(result.resources).toHaveLength(2)
    expect(result.resources[0].uri).toBe(`conductor://plans/${plan.id}`)
    expect(result.resources[1].uri).toBe(`conductor://plans/${plan.id}/tree`)
  })

  it('includes plan name and mimeType', async () => {
    await create_plan({ name: 'Beta' })
    const result = await handleListResources()
    const meta = result.resources.find(r => !r.uri.endsWith('/tree'))!
    expect(meta.name).toBe('Beta')
    expect(meta.mimeType).toBe('application/json')
  })

  it('does not list archived plans', async () => {
    await create_plan({ name: 'Active' })
    const archived = await create_plan({ name: 'Archived' })
    // archive it directly via db
    const { updatePlan } = await import('../db.js')
    updatePlan(archived.id, { status: 'archived', updated_at: new Date().toISOString() })
    const result = await handleListResources()
    const uris = result.resources.map(r => r.uri)
    expect(uris.every(u => !u.includes(archived.id))).toBe(true)
  })
})

describe('handleReadResource — plan metadata', () => {
  it('returns plan fields and tree_stats', async () => {
    const plan = await create_plan({ name: 'Meta Test' })
    const result = await handleReadResource({ params: { uri: `conductor://plans/${plan.id}` } })
    expect(result.contents).toHaveLength(1)
    const data = JSON.parse(result.contents[0].text)
    expect(data.id).toBe(plan.id)
    expect(data.name).toBe('Meta Test')
    expect(data.tree_stats).toBeDefined()
    expect(result.contents[0].mimeType).toBe('application/json')
  })

  it('throws for unknown plan', async () => {
    await expect(
      handleReadResource({ params: { uri: 'conductor://plans/plan_doesnotexist' } })
    ).rejects.toThrow('Plan not found')
  })
})

describe('handleReadResource — tree', () => {
  it('returns nested tree with plan and stats', async () => {
    const plan = await seedPlan('Tree Test')
    const result = await handleReadResource({ params: { uri: `conductor://plans/${plan.id}/tree` } })
    const data = JSON.parse(result.contents[0].text)
    expect(data.plan.id).toBe(plan.id)
    expect(data.tree).toHaveLength(1)
    expect(data.tree[0].goal).toBe('Root task')
    expect(data.tree[0].children).toHaveLength(2)
    expect(data.stats.total_tasks).toBe(3)
  })

  it('returns empty tree array for plan with no tasks', async () => {
    const plan = await create_plan({ name: 'Empty' })
    const result = await handleReadResource({ params: { uri: `conductor://plans/${plan.id}/tree` } })
    const data = JSON.parse(result.contents[0].text)
    expect(data.tree).toEqual([])
  })

  it('throws for unknown plan', async () => {
    await expect(
      handleReadResource({ params: { uri: 'conductor://plans/plan_nope/tree' } })
    ).rejects.toThrow('Plan not found')
  })
})

describe('handleReadResource — single task', () => {
  it('returns context view for a task', async () => {
    const plan = await seedPlan('Task Test')
    const result = await handleReadResource({ params: { uri: `conductor://plans/${plan.id}/tasks/1` } })
    const data = JSON.parse(result.contents[0].text)
    expect(data.focus.id).toBe('1')
    expect(data.focus.goal).toBe('Root task')
    expect(data.children).toHaveLength(2)
  })

  it('throws for unknown task', async () => {
    const plan = await create_plan({ name: 'Task Error' })
    await expect(
      handleReadResource({ params: { uri: `conductor://plans/${plan.id}/tasks/99` } })
    ).rejects.toThrow('Task not found')
  })

  it('throws for unknown plan', async () => {
    await expect(
      handleReadResource({ params: { uri: 'conductor://plans/plan_nope/tasks/1' } })
    ).rejects.toThrow('Plan not found')
  })
})

describe('handleReadResource — unknown URI', () => {
  it('throws for unrecognised URI pattern', async () => {
    await expect(
      handleReadResource({ params: { uri: 'conductor://something/else' } })
    ).rejects.toThrow('Unknown resource URI')
  })
})
