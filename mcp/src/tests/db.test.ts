import { describe, it, expect } from 'vitest'
import {
  insertPlan,
  getPlan,
  insertTask,
  getTask,
  getChildren,
  getSiblings,
  nextChildId,
  getTreeStats,
  listPlans,
  updatePlan,
  updateTask,
  countAllTasks,
} from '../db.js'
import type { PlanRow, Task } from '../db.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProject(id: string, overrides: Partial<PlanRow> = {}): PlanRow {
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
    plan_id: projectId,
    goal: `Goal for ${id}`,
    status: 'active',
    result: null,
    abandon_reason: null,
    state: {},
    depends_on: null,
    notes: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

// ── Project tests ─────────────────────────────────────────────────────────────

describe('insertPlan / getPlan', () => {
  it('round-trips a project', () => {
    const p = makeProject('plan_1')
    insertPlan(p)
    const fetched = getPlan('plan_1')
    expect(fetched).toBeDefined()
    expect(fetched!.id).toBe('plan_1')
    expect(fetched!.name).toBe('Project plan_1')
  })

  it('returns undefined for unknown id', () => {
    expect(getPlan('nonexistent')).toBeUndefined()
  })
})

describe('listPlans', () => {
  it('filters active projects', () => {
    insertPlan(makeProject('p1', { status: 'active' }))
    insertPlan(makeProject('p2', { status: 'archived' }))
    const active = listPlans('active')
    expect(active.map(p => p.id)).toContain('p1')
    expect(active.map(p => p.id)).not.toContain('p2')
  })

  it('filters archived projects', () => {
    insertPlan(makeProject('p1', { status: 'active' }))
    insertPlan(makeProject('p2', { status: 'archived' }))
    const archived = listPlans('archived')
    expect(archived.map(p => p.id)).toContain('p2')
    expect(archived.map(p => p.id)).not.toContain('p1')
  })

  it('returns all projects', () => {
    insertPlan(makeProject('p1', { status: 'active' }))
    insertPlan(makeProject('p2', { status: 'archived' }))
    const all = listPlans('all')
    expect(all.map(p => p.id)).toContain('p1')
    expect(all.map(p => p.id)).toContain('p2')
  })
})

describe('updatePlan', () => {
  it('updates specified fields only', () => {
    insertPlan(makeProject('p1', { status: 'active', description: null }))
    updatePlan('p1', { status: 'archived', description: 'updated' })
    const p = getPlan('p1')!
    expect(p.status).toBe('archived')
    expect(p.description).toBe('updated')
    expect(p.name).toBe('Project p1')
  })

  it('no-ops on empty fields', () => {
    insertPlan(makeProject('p1'))
    updatePlan('p1', {})
    expect(getPlan('p1')!.name).toBe('Project p1')
  })
})

// ── Task tests ────────────────────────────────────────────────────────────────

describe('insertTask / getTask', () => {
  it('round-trips a task with JSON fields', () => {
    insertPlan(makeProject('p1'))
    const task = makeTask('p1', '1', {
      state: { key: 'value', count: 42 },
      depends_on: ['2', '3'],
    })
    insertTask(task)
    const fetched = getTask('p1', '1')
    expect(fetched).toBeDefined()
    expect(fetched!.state).toEqual({ key: 'value', count: 42 })
    expect(fetched!.depends_on).toEqual(['2', '3'])
  })

  it('returns undefined for unknown task', () => {
    insertPlan(makeProject('p1'))
    expect(getTask('p1', 'nonexistent')).toBeUndefined()
  })

  it('null depends_on round-trips as null', () => {
    insertPlan(makeProject('p1'))
    insertTask(makeTask('p1', '1', { depends_on: null }))
    expect(getTask('p1', '1')!.depends_on).toBeNull()
  })
})

describe('updateTask', () => {
  it('updates state via serialization', () => {
    insertPlan(makeProject('p1'))
    insertTask(makeTask('p1', '1', { state: { a: 1 } }))
    updateTask('p1', '1', { state: { a: 1, b: 2 } })
    expect(getTask('p1', '1')!.state).toEqual({ a: 1, b: 2 })
  })

  it('updates status', () => {
    insertPlan(makeProject('p1'))
    insertTask(makeTask('p1', '1'))
    updateTask('p1', '1', { status: 'completed' })
    expect(getTask('p1', '1')!.status).toBe('completed')
  })
})

// ── Tree hierarchy tests ──────────────────────────────────────────────────────

describe('getChildren', () => {
  it('returns direct children only, not grandchildren', () => {
    insertPlan(makeProject('p1'))
    insertTask(makeTask('p1', '1'))
    insertTask(makeTask('p1', '1.1'))
    insertTask(makeTask('p1', '1.2'))
    insertTask(makeTask('p1', '1.1.1'))  // grandchild
    insertTask(makeTask('p1', '1.1.2'))  // grandchild

    const children = getChildren('p1', '1')
    const ids = children.map(t => t.id)
    expect(ids).toContain('1.1')
    expect(ids).toContain('1.2')
    expect(ids).not.toContain('1.1.1')
    expect(ids).not.toContain('1.1.2')
  })

  it('returns empty array for leaf node', () => {
    insertPlan(makeProject('p1'))
    insertTask(makeTask('p1', '1'))
    expect(getChildren('p1', '1')).toEqual([])
  })

  it('returns children for nested parent', () => {
    insertPlan(makeProject('p1'))
    insertTask(makeTask('p1', '1'))
    insertTask(makeTask('p1', '1.1'))
    insertTask(makeTask('p1', '1.1.1'))
    insertTask(makeTask('p1', '1.1.2'))

    const children = getChildren('p1', '1.1')
    expect(children.map(t => t.id)).toEqual(['1.1.1', '1.1.2'])
  })
})

describe('getSiblings', () => {
  it('returns siblings at root level (no dot)', () => {
    insertPlan(makeProject('p1'))
    insertTask(makeTask('p1', '1'))
    insertTask(makeTask('p1', '2'))
    insertTask(makeTask('p1', '3'))
    insertTask(makeTask('p1', '1.1'))  // not a root sibling

    const siblings = getSiblings('p1', '1')
    const ids = siblings.map(t => t.id)
    expect(ids).toContain('2')
    expect(ids).toContain('3')
    expect(ids).not.toContain('1')
    expect(ids).not.toContain('1.1')
  })

  it('returns siblings at nested level', () => {
    insertPlan(makeProject('p1'))
    insertTask(makeTask('p1', '1'))
    insertTask(makeTask('p1', '1.1'))
    insertTask(makeTask('p1', '1.2'))
    insertTask(makeTask('p1', '1.3'))
    insertTask(makeTask('p1', '1.1.1'))  // child, not sibling

    const siblings = getSiblings('p1', '1.1')
    const ids = siblings.map(t => t.id)
    expect(ids).toContain('1.2')
    expect(ids).toContain('1.3')
    expect(ids).not.toContain('1.1')
    expect(ids).not.toContain('1.1.1')
  })

  it('returns empty array when only child', () => {
    insertPlan(makeProject('p1'))
    insertTask(makeTask('p1', '1'))
    insertTask(makeTask('p1', '1.1'))
    expect(getSiblings('p1', '1.1')).toEqual([])
  })
})

describe('nextChildId', () => {
  it('returns parentId.1 when no children exist', () => {
    insertPlan(makeProject('p1'))
    insertTask(makeTask('p1', '1'))
    expect(nextChildId('p1', '1')).toBe('1.1')
  })

  it('increments based on direct child count', () => {
    insertPlan(makeProject('p1'))
    insertTask(makeTask('p1', '1'))
    insertTask(makeTask('p1', '1.1'))
    insertTask(makeTask('p1', '1.2'))
    expect(nextChildId('p1', '1')).toBe('1.3')
  })

  it('works for nested parent', () => {
    insertPlan(makeProject('p1'))
    insertTask(makeTask('p1', '1'))
    insertTask(makeTask('p1', '1.1'))
    insertTask(makeTask('p1', '1.1.1'))
    expect(nextChildId('p1', '1.1')).toBe('1.1.2')
  })
})

// ── Tree stats tests ──────────────────────────────────────────────────────────

describe('getTreeStats', () => {
  it('counts tasks by status', () => {
    insertPlan(makeProject('p1'))
    insertTask(makeTask('p1', '1', { status: 'active' }))
    insertTask(makeTask('p1', '1.1', { status: 'completed' }))
    insertTask(makeTask('p1', '1.2', { status: 'completed' }))
    insertTask(makeTask('p1', '1.3', { status: 'pending' }))
    insertTask(makeTask('p1', '1.4', { status: 'abandoned' }))

    const stats = getTreeStats('p1')
    expect(stats.total_tasks).toBe(5)
    expect(stats.active).toBe(1)
    expect(stats.completed).toBe(2)
    expect(stats.pending).toBe(1)
    expect(stats.abandoned).toBe(1)
  })

  it('returns zeros for empty project', () => {
    insertPlan(makeProject('p1'))
    const stats = getTreeStats('p1')
    expect(stats.total_tasks).toBe(0)
    expect(stats.active).toBe(0)
    expect(stats.completed).toBe(0)
  })
})

describe('countAllTasks', () => {
  it('counts all tasks in a project', () => {
    insertPlan(makeProject('p1'))
    insertTask(makeTask('p1', '1'))
    insertTask(makeTask('p1', '1.1'))
    expect(countAllTasks('p1')).toBe(2)
  })

  it('returns 0 for empty project', () => {
    insertPlan(makeProject('p1'))
    expect(countAllTasks('p1')).toBe(0)
  })
})
