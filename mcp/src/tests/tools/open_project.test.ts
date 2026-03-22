import { describe, it, expect } from 'vitest'
import { open_project } from '../../tools/open_project.js'
import { create_project } from '../../tools/create_project.js'
import { create_task } from '../../tools/create_task.js'
import { archive_project } from '../../tools/archive_project.js'
import { getOpenProject } from '../../session.js'
import { getProject } from '../../db.js'

describe('open_project', () => {
  it('throws for unknown project id', async () => {
    await expect(open_project({ project_id: 'nonexistent' })).rejects.toThrow('not found')
  })

  it('sets the open project in session', async () => {
    const p = await create_project({ name: 'Test' })
    // Create a second project to change session
    await create_project({ name: 'Other' })
    expect(getOpenProject()).not.toBe(p.id)

    await open_project({ project_id: p.id })
    expect(getOpenProject()).toBe(p.id)
  })

  it('returns empty-tree message when project has no tasks', async () => {
    const p = await create_project({ name: 'Empty' })
    const result = await open_project({ project_id: p.id })
    expect(result).toHaveProperty('message')
    expect((result as { message: string }).message).toContain('empty')
  })

  it('returns context when project has tasks', async () => {
    const p = await create_project({ name: 'With Tasks' })
    await create_task({ goal: 'root', plan: ['step 1'] })
    const result = await open_project({ project_id: p.id })
    expect(result).toHaveProperty('focus')
    expect(result).toHaveProperty('tree_stats')
  })

  it('auto-reactivates archived projects', async () => {
    const p = await create_project({ name: 'Was Archived' })
    await archive_project({ project_id: p.id })
    expect(getProject(p.id)!.status).toBe('archived')

    await open_project({ project_id: p.id })
    expect(getProject(p.id)!.status).toBe('active')
  })
})
