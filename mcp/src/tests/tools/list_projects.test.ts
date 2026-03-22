import { describe, it, expect } from 'vitest'
import { list_projects } from '../../tools/list_projects.js'
import { create_project } from '../../tools/create_project.js'
import { archive_project } from '../../tools/archive_project.js'

describe('list_projects', () => {
  it('returns empty list when no projects', async () => {
    const result = await list_projects({})
    expect(result.projects).toEqual([])
  })

  it('returns active projects by default', async () => {
    const p = await create_project({ name: 'Active' })
    const result = await list_projects({})
    expect(result.projects.map(x => x.id)).toContain(p.id)
  })

  it('excludes archived projects from active filter', async () => {
    const p = await create_project({ name: 'To Archive' })
    await archive_project({ project_id: p.id })
    const result = await list_projects({ status: 'active' })
    expect(result.projects.map(x => x.id)).not.toContain(p.id)
  })

  it('returns archived projects with archived filter', async () => {
    const p = await create_project({ name: 'Archived' })
    await archive_project({ project_id: p.id })
    const result = await list_projects({ status: 'archived' })
    expect(result.projects.map(x => x.id)).toContain(p.id)
  })

  it('returns all projects with all filter', async () => {
    const p1 = await create_project({ name: 'Active' })
    const p2 = await create_project({ name: 'Archived' })
    await archive_project({ project_id: p2.id })
    const result = await list_projects({ status: 'all' })
    const ids = result.projects.map(x => x.id)
    expect(ids).toContain(p1.id)
    expect(ids).toContain(p2.id)
  })

  it('each project includes tree_stats', async () => {
    await create_project({ name: 'Test' })
    const result = await list_projects({})
    expect(result.projects[0].tree_stats).toBeDefined()
    expect(result.projects[0].tree_stats.total_tasks).toBe(0)
  })
})
