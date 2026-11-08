import { describe, it, expect } from 'vitest'
import {
  insertPlan, getPlan, insertTask as _insertTask,
  getTask, deleteTaskTree, nextChildId, getDb,
  insertEvent, getEvents,
} from '@/lib/db.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProject(id?: string) {
  const now = new Date().toISOString()
  return {
    id: id ?? `plan_${Math.random().toString(36).slice(2, 10)}`,
    name: 'Test Project',
    description: null,
    status: 'active' as const,
    working_dir: '/tmp',
    focus_task_id: null,
    created_at: now,
    updated_at: now,
  }
}

function createTestTask(planId: string, id: string, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString()
  _insertTask({
    id,
    plan_id: planId,
    goal: `Task ${id}`,
    status: 'pending',
    result: null,
    abandon_reason: null,
    state: {},
    depends_on: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  } as Parameters<typeof _insertTask>[0])
}

function makeSession(planId: string, rootTaskId: string, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString()
  return {
    id: `sess_${Math.random().toString(36).slice(2, 10)}`,
    plan_id: planId,
    root_task_id: rootTaskId,
    nickname: 'TestAgent',
    status: 'running' as const,
    autonomy_level: 'full' as const,
    model: 'claude-sonnet-4-6',
    started_at: now,
    ...overrides,
  }
}

// ─── getFullTree ──────────────────────────────────────────────────────────────

describe('deleteTaskTree', () => {
  it('removes root task and all descendants', () => {
    const p = makeProject()
    insertPlan(p)
    createTestTask(p.id, '1')
    createTestTask(p.id, '1.1')
    createTestTask(p.id, '1.1.1')
    createTestTask(p.id, '2')

    deleteTaskTree(p.id, '1')

    expect(getTask(p.id, '1')).toBeUndefined()
    expect(getTask(p.id, '1.1')).toBeUndefined()
    expect(getTask(p.id, '1.1.1')).toBeUndefined()
    expect(getTask(p.id, '2')).toBeDefined()
  })

  it('only removes the specified subtree', () => {
    const p = makeProject()
    insertPlan(p)
    createTestTask(p.id, '1')
    createTestTask(p.id, '1.1')
    createTestTask(p.id, '1.2')
    createTestTask(p.id, '1.1.1')

    deleteTaskTree(p.id, '1.1')

    expect(getTask(p.id, '1')).toBeDefined()
    expect(getTask(p.id, '1.2')).toBeDefined()
    expect(getTask(p.id, '1.1')).toBeUndefined()
    expect(getTask(p.id, '1.1.1')).toBeUndefined()
  })
})

// ─── nextChildId ──────────────────────────────────────────────────────────────

describe('nextChildId', () => {
  it('does not reuse an existing ID after a middle child is deleted', () => {
    const p = makeProject()
    insertPlan(p)
    createTestTask(p.id, '1')
    createTestTask(p.id, '1.1')
    createTestTask(p.id, '1.2')
    createTestTask(p.id, '1.3')

    deleteTaskTree(p.id, '1.2')

    expect(nextChildId(p.id, '1')).toBe('1.4')
  })

  it('handles gaps among root tasks', () => {
    const p = makeProject()
    insertPlan(p)
    createTestTask(p.id, '1')
    createTestTask(p.id, '3')
    expect(nextChildId(p.id, null)).toBe('4')
  })

  it('does not count grandchildren', () => {
    const p = makeProject()
    insertPlan(p)
    createTestTask(p.id, '1')
    createTestTask(p.id, '1.1')
    createTestTask(p.id, '1.1.5')
    expect(nextChildId(p.id, '1')).toBe('1.2')
  })
})

// ─── Agent sessions ───────────────────────────────────────────────────────────

describe('event log', () => {
  it('insertEvent and getEvents for a task', () => {
    const p = makeProject()
    insertPlan(p)
    createTestTask(p.id, '1')

    insertEvent({
      id: 'evt_1',
      plan_id: p.id,
      task_id: '1',
      event_type: 'task_created',
      actor: 'human',
      session_id: null,
      payload: { goal: 'Root task' },
    })

    const events = getEvents(p.id, '1')
    expect(events).toHaveLength(1)
    expect(events[0].event_type).toBe('task_created')
    expect(events[0].payload).toMatchObject({ goal: 'Root task' })
  })

  it('getEvents without taskId returns all project events', () => {
    const p = makeProject()
    insertPlan(p)
    createTestTask(p.id, '1')
    createTestTask(p.id, '1.1')

    insertEvent({ id: 'e1', plan_id: p.id, task_id: '1', event_type: 'task_created', actor: 'human', session_id: null, payload: {} })
    insertEvent({ id: 'e2', plan_id: p.id, task_id: '1.1', event_type: 'task_created', actor: 'agent', session_id: null, payload: {} })

    const events = getEvents(p.id)
    expect(events).toHaveLength(2)
  })

  it('deserializes payload JSON', () => {
    const p = makeProject()
    insertPlan(p)
    createTestTask(p.id, '1')

    insertEvent({ id: 'e_json', plan_id: p.id, task_id: '1', event_type: 'task_updated', actor: 'agent', session_id: null, payload: { step: 2, value: [1, 2, 3] } })

    const events = getEvents(p.id, '1')
    expect(events[0].payload).toEqual({ step: 2, value: [1, 2, 3] })
  })
})
