import { describe, it, expect } from 'vitest'
import {
  insertProject, getProject, insertTask as _insertTask,
  getTask, getFullTree,
  lockSubtree, unlockSubtree, deleteTaskTree,
  createSession, updateSession, getActiveSession, getDb,
  insertEvent, getEvents,
} from '@/lib/db.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProject(id?: string) {
  const now = new Date().toISOString()
  return {
    id: id ?? `proj_${Math.random().toString(36).slice(2, 10)}`,
    name: 'Test Project',
    description: null,
    status: 'active' as const,
    focus_task_id: null,
    created_at: now,
    updated_at: now,
  }
}

function createTestTask(projectId: string, id: string, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString()
  _insertTask({
    id,
    project_id: projectId,
    goal: `Task ${id}`,
    plan: ['step 1'],
    step: 0,
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

function makeSession(projectId: string, rootTaskId: string, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString()
  return {
    id: `sess_${Math.random().toString(36).slice(2, 10)}`,
    project_id: projectId,
    root_task_id: rootTaskId,
    status: 'running' as const,
    autonomy_level: 'full' as const,
    model: 'claude-sonnet-4-6',
    started_at: now,
    ...overrides,
  }
}

// ─── getFullTree ──────────────────────────────────────────────────────────────

describe('getFullTree', () => {
  it('returns nested tree structure', () => {
    const p = makeProject()
    insertProject(p)
    createTestTask(p.id, '1', { goal: 'Root' })
    createTestTask(p.id, '1.1', { goal: 'Child A' })
    createTestTask(p.id, '1.2', { goal: 'Child B' })
    createTestTask(p.id, '1.1.1', { goal: 'Grandchild' })

    const tree = getFullTree(p.id)
    expect(tree).toHaveLength(1)
    expect(tree[0].id).toBe('1')
    expect(tree[0].children).toHaveLength(2)
    const child11 = tree[0].children.find((c) => c.id === '1.1')
    expect(child11?.children).toHaveLength(1)
    expect(child11?.children[0].id).toBe('1.1.1')
  })

  it('returns empty array when no tasks', () => {
    const p = makeProject()
    insertProject(p)
    expect(getFullTree(p.id)).toEqual([])
  })
})

// ─── lockSubtree / unlockSubtree ──────────────────────────────────────────────

describe('lockSubtree / unlockSubtree', () => {
  it('sets locked_by on root task and all descendants', () => {
    const p = makeProject()
    insertProject(p)
    createTestTask(p.id, '1')
    createTestTask(p.id, '1.1')
    createTestTask(p.id, '1.2')
    createTestTask(p.id, '1.1.1')
    createTestTask(p.id, '2') // separate subtree

    const sessionId = 'sess_lock_test'
    lockSubtree(sessionId, p.id, '1')

    expect(getTask(p.id, '1')?.locked_by).toBe(sessionId)
    expect(getTask(p.id, '1.1')?.locked_by).toBe(sessionId)
    expect(getTask(p.id, '1.2')?.locked_by).toBe(sessionId)
    expect(getTask(p.id, '1.1.1')?.locked_by).toBe(sessionId)
    expect(getTask(p.id, '2')?.locked_by).toBeNull()
  })

  it('unlockSubtree clears locked_by for the session', () => {
    const p = makeProject()
    insertProject(p)
    createTestTask(p.id, '1')
    createTestTask(p.id, '1.1')
    const sessionId = 'sess_unlock_test'
    lockSubtree(sessionId, p.id, '1')
    unlockSubtree(sessionId, p.id)

    expect(getTask(p.id, '1')?.locked_by).toBeNull()
    expect(getTask(p.id, '1.1')?.locked_by).toBeNull()
  })

  it('does not unlock tasks from a different session', () => {
    const p = makeProject()
    insertProject(p)
    createTestTask(p.id, '1')
    createTestTask(p.id, '2')
    lockSubtree('sess_a', p.id, '1')
    lockSubtree('sess_b', p.id, '2')

    unlockSubtree('sess_a', p.id)

    expect(getTask(p.id, '1')?.locked_by).toBeNull()
    expect(getTask(p.id, '2')?.locked_by).toBe('sess_b')
  })
})

// ─── deleteTaskTree ───────────────────────────────────────────────────────────

describe('deleteTaskTree', () => {
  it('removes root task and all descendants', () => {
    const p = makeProject()
    insertProject(p)
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
    insertProject(p)
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

// ─── Agent sessions ───────────────────────────────────────────────────────────

describe('agent sessions', () => {
  it('createSession and getActiveSession', () => {
    const p = makeProject()
    insertProject(p)
    createTestTask(p.id, '1')

    const sess = makeSession(p.id, '1')
    createSession(sess)

    const active = getActiveSession(p.id)
    expect(active).toBeDefined()
    expect(active?.id).toBe(sess.id)
    expect(active?.status).toBe('running')
  })

  it('getActiveSession returns undefined when no running/paused sessions', () => {
    const p = makeProject()
    insertProject(p)
    createTestTask(p.id, '1')

    const sess = makeSession(p.id, '1', { status: 'completed' as const })
    createSession(sess)

    expect(getActiveSession(p.id)).toBeUndefined()
  })

  it('updateSession updates status and ended_at', () => {
    const p = makeProject()
    insertProject(p)
    createTestTask(p.id, '1')

    const sess = makeSession(p.id, '1')
    createSession(sess)

    const endedAt = new Date().toISOString()
    updateSession(sess.id, { status: 'completed', ended_at: endedAt, input_tokens: 100, output_tokens: 200 })

    expect(getActiveSession(p.id)).toBeUndefined()
    // Verify session record was updated (check via direct query)
    const row = getDb().prepare('SELECT * FROM agent_sessions WHERE id = ?').get(sess.id) as { status: string; input_tokens: number }
    expect(row.status).toBe('completed')
    expect(row.input_tokens).toBe(100)
  })
})

// ─── Event log ────────────────────────────────────────────────────────────────

describe('event log', () => {
  it('insertEvent and getEvents for a task', () => {
    const p = makeProject()
    insertProject(p)
    createTestTask(p.id, '1')

    insertEvent({
      id: 'evt_1',
      project_id: p.id,
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
    insertProject(p)
    createTestTask(p.id, '1')
    createTestTask(p.id, '1.1')

    insertEvent({ id: 'e1', project_id: p.id, task_id: '1', event_type: 'task_created', actor: 'human', session_id: null, payload: {} })
    insertEvent({ id: 'e2', project_id: p.id, task_id: '1.1', event_type: 'task_created', actor: 'agent', session_id: null, payload: {} })

    const events = getEvents(p.id)
    expect(events).toHaveLength(2)
  })

  it('deserializes payload JSON', () => {
    const p = makeProject()
    insertProject(p)
    createTestTask(p.id, '1')

    insertEvent({ id: 'e_json', project_id: p.id, task_id: '1', event_type: 'task_updated', actor: 'agent', session_id: null, payload: { step: 2, value: [1, 2, 3] } })

    const events = getEvents(p.id, '1')
    expect(events[0].payload).toEqual({ step: 2, value: [1, 2, 3] })
  })
})
