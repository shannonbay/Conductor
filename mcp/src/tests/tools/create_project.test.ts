import { describe, it, expect } from 'vitest'
import { create_project } from '../../tools/create_project.js'
import { getOpenProject } from '../../session.js'

describe('create_project', () => {
  it('returns a project with the given name', async () => {
    const result = await create_project({ name: 'My Project' })
    expect(result.name).toBe('My Project')
    expect(result.status).toBe('active')
    expect(result.focus_task_id).toBeNull()
  })

  it('id starts with proj_', async () => {
    const result = await create_project({ name: 'Test' })
    expect(result.id).toMatch(/^proj_/)
  })

  it('sets the session open project', async () => {
    const result = await create_project({ name: 'Test' })
    expect(getOpenProject()).toBe(result.id)
  })

  it('description is optional and defaults to null', async () => {
    const result = await create_project({ name: 'No Desc' })
    expect(result.description).toBeNull()
  })

  it('description is stored when provided', async () => {
    const result = await create_project({ name: 'With Desc', description: 'some desc' })
    expect(result.description).toBe('some desc')
  })

  it('includes empty tree_stats', async () => {
    const result = await create_project({ name: 'Test' })
    expect(result.tree_stats).toEqual({ total_tasks: 0, active: 0, completed: 0, pending: 0, abandoned: 0 })
  })

  it('throws on missing name', async () => {
    await expect(create_project({})).rejects.toThrow()
  })
})
