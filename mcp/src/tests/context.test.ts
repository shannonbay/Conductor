import { describe, it, expect } from 'vitest'
import { buildContext } from '../context.js'
import { insertProject, insertTask, updateProject } from '../db.js'
import type { ProjectRow, Task } from '../db.js'

function makeProject(id: string, overrides: Partial<ProjectRow> = {}): ProjectRow {
  const now = new Date().toISOString()
  return {
    id,
    name: `Project ${id}`,
    description: null,
    status: 'active',
    working_dir: '/tmp',
    focus_task_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

function makeTask(projectId: string, id: string, overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString()
  return {
    id,
    project_id: projectId,
    goal: `Goal for ${id}`,
    plan: ['step 1'],
    step: 0,
    status: 'active',
    result: null,
    abandon_reason: null,
    state: {},
    depends_on: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

describe('buildContext', () => {
  it('throws if project not found', () => {
    expect(() => buildContext('nonexistent', '1')).toThrow('Project nonexistent not found')
  })

  it('throws if focus task not found', () => {
    insertProject(makeProject('p1'))
    expect(() => buildContext('p1', '999')).toThrow('Task 999 not found')
  })

  it('returns null parent for root task', () => {
    insertProject(makeProject('p1'))
    insertTask(makeTask('p1', '1'))
    updateProject('p1', { focus_task_id: '1' })

    const ctx = buildContext('p1', '1')
    expect(ctx.parent).toBeNull()
  })

  it('returns parent for nested task', () => {
    insertProject(makeProject('p1'))
    insertTask(makeTask('p1', '1', { goal: 'root goal' }))
    insertTask(makeTask('p1', '1.1'))
    updateProject('p1', { focus_task_id: '1.1' })

    const ctx = buildContext('p1', '1.1')
    expect(ctx.parent).not.toBeNull()
    expect(ctx.parent!.id).toBe('1')
    expect(ctx.parent!.goal).toBe('root goal')
  })

  it('includes siblings but not self', () => {
    insertProject(makeProject('p1'))
    insertTask(makeTask('p1', '1'))
    insertTask(makeTask('p1', '1.1'))
    insertTask(makeTask('p1', '1.2'))
    insertTask(makeTask('p1', '1.3'))
    updateProject('p1', { focus_task_id: '1.1' })

    const ctx = buildContext('p1', '1.1')
    const siblingIds = ctx.siblings.map(s => s.id)
    expect(siblingIds).toContain('1.2')
    expect(siblingIds).toContain('1.3')
    expect(siblingIds).not.toContain('1.1')
  })

  it('includes children', () => {
    insertProject(makeProject('p1'))
    insertTask(makeTask('p1', '1'))
    insertTask(makeTask('p1', '1.1'))
    insertTask(makeTask('p1', '1.2'))
    updateProject('p1', { focus_task_id: '1' })

    const ctx = buildContext('p1', '1')
    expect(ctx.children.map(c => c.id)).toContain('1.1')
    expect(ctx.children.map(c => c.id)).toContain('1.2')
  })

  it('tree_stats reflects actual DB state', () => {
    insertProject(makeProject('p1'))
    insertTask(makeTask('p1', '1', { status: 'active' }))
    insertTask(makeTask('p1', '1.1', { status: 'completed' }))
    insertTask(makeTask('p1', '1.2', { status: 'abandoned' }))
    updateProject('p1', { focus_task_id: '1' })

    const ctx = buildContext('p1', '1')
    expect(ctx.tree_stats.total_tasks).toBe(3)
    expect(ctx.tree_stats.active).toBe(1)
    expect(ctx.tree_stats.completed).toBe(1)
    expect(ctx.tree_stats.abandoned).toBe(1)
  })

  it('sibling summaries omit null fields', () => {
    insertProject(makeProject('p1'))
    insertTask(makeTask('p1', '1'))
    insertTask(makeTask('p1', '1.1', { result: null, abandon_reason: null, depends_on: null }))
    insertTask(makeTask('p1', '1.2'))
    updateProject('p1', { focus_task_id: '1.2' })

    const ctx = buildContext('p1', '1.2')
    const sibling = ctx.siblings.find(s => s.id === '1.1')!
    expect(sibling).toBeDefined()
    expect('result' in sibling).toBe(false)
    expect('abandon_reason' in sibling).toBe(false)
    expect('depends_on' in sibling).toBe(false)
  })

  it('sibling summaries include result when present', () => {
    insertProject(makeProject('p1'))
    insertTask(makeTask('p1', '1'))
    insertTask(makeTask('p1', '1.1', { status: 'completed', result: 'done' }))
    insertTask(makeTask('p1', '1.2'))
    updateProject('p1', { focus_task_id: '1.2' })

    const ctx = buildContext('p1', '1.2')
    const sibling = ctx.siblings.find(s => s.id === '1.1')!
    expect(sibling.result).toBe('done')
  })
})
