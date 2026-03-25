import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Task } from '@/lib/db.js'

// Mock the channel client
const mockRequireChannel = vi.fn().mockResolvedValue(undefined)
const mockPlanTasks = vi.fn()
const mockModifyTasks = vi.fn()

vi.mock('@/lib/channel-client.js', () => ({
  ChannelNotConnectedError: class ChannelNotConnectedError extends Error {
    constructor() { super('not connected'); this.name = 'ChannelNotConnectedError' }
  },
  ChannelBusyError: class ChannelBusyError extends Error {
    constructor() { super('busy'); this.name = 'ChannelBusyError' }
  },
  requireChannel: mockRequireChannel,
  planTasksViaChannel: mockPlanTasks,
  modifyTasksViaChannel: mockModifyTasks,
}))

// Import planning AFTER the mock is set up
const { generatePlan, modifyPlan } = await import('@/lib/planning.js')

beforeEach(() => {
  mockRequireChannel.mockReset().mockResolvedValue(undefined)
  mockPlanTasks.mockReset()
  mockModifyTasks.mockReset()
})

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: '1',
    plan_id: 'plan_test',
    goal: 'Test task',
    status: 'active',
    result: null,
    abandon_reason: null,
    state: {},
    depends_on: null,
    locked_by: null,
    locked_at: null,
    requires_approval: false,
    approved_by: null,
    approved_at: null,
    created_by: 'human',
    assigned_to: null,
    notes: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('generatePlan', () => {
  it('returns parsed ProposedTask[] from channel response', async () => {
    const proposed = [
      { goal: 'Subtask A', plan: [], suggested_depends_on: [] },
      { goal: 'Subtask B', plan: [], suggested_depends_on: [] },
    ]
    mockPlanTasks.mockResolvedValue(proposed)

    const result = await generatePlan(makeTask(), 'My Project', null, [])

    expect(result).toHaveLength(2)
    expect(result[0].goal).toBe('Subtask A')
    expect(result[1].goal).toBe('Subtask B')
  })

  it('throws on malformed channel response', async () => {
    mockPlanTasks.mockResolvedValue({ not_an_array: true })

    await expect(generatePlan(makeTask(), 'Project', null, [])).rejects.toThrow()
  })

  it('passes task context and siblings to channel client', async () => {
    const proposed = [{ goal: 'Task', plan: [], suggested_depends_on: [] }]
    mockPlanTasks.mockResolvedValue(proposed)

    const sibling = makeTask({ id: '1.1', goal: 'Sibling task', status: 'abandoned', abandon_reason: 'API not available' })
    await generatePlan(makeTask({ id: '1.2' }), 'My Project', 'Parent goal', [sibling])

    const callArgs = mockPlanTasks.mock.calls[0][0]
    expect(callArgs.parentGoal).toBe('Parent goal')
    expect(callArgs.siblings).toContainEqual(expect.objectContaining({ goal: 'Sibling task' }))
    expect(callArgs.planName).toBe('My Project')
  })

  it('passes optional instruction to channel client', async () => {
    mockPlanTasks.mockResolvedValue([{ goal: 'Task', plan: [], suggested_depends_on: [] }])
    await generatePlan(makeTask(), 'Project', null, [], 'focus on testing')
    expect(mockPlanTasks.mock.calls[0][0].instruction).toBe('focus on testing')
  })

  it('throws ChannelNotConnectedError when not connected', async () => {
    mockRequireChannel.mockRejectedValue(Object.assign(new Error('not connected'), { name: 'ChannelNotConnectedError' }))
    await expect(generatePlan(makeTask(), 'Project', null, [])).rejects.toMatchObject({ name: 'ChannelNotConnectedError' })
  })
})

describe('modifyPlan', () => {
  it('returns a diff with unchanged, modified, added, removed', async () => {
    const diff = {
      unchanged: ['1.1'],
      modified: [{ replaces_id: '1.2', goal: 'Updated 1.2', plan: [], suggested_depends_on: [] }],
      added: [{ goal: 'New task', plan: [], suggested_depends_on: [] }],
      removed: ['1.3'],
    }
    mockModifyTasks.mockResolvedValue(diff)

    const task = makeTask({ id: '1' })
    const children: Task[] = [
      makeTask({ id: '1.1', status: 'completed' }),
      makeTask({ id: '1.2', status: 'pending' }),
      makeTask({ id: '1.3', status: 'pending' }),
    ]

    const result = await modifyPlan(task, 'Project', children, 'restructure it')

    expect(result.unchanged).toEqual(['1.1'])
    expect(result.modified).toHaveLength(1)
    expect(result.modified[0].replaces_id).toBe('1.2')
    expect(result.added).toHaveLength(1)
    expect(result.removed).toContain('1.3')
  })

  it('filters out completed/active tasks from removed list', async () => {
    const diff = {
      unchanged: [],
      modified: [],
      added: [],
      removed: ['1.1', '1.2'], // 1.1 is completed — should be protected
    }
    mockModifyTasks.mockResolvedValue(diff)

    const task = makeTask({ id: '1' })
    const children: Task[] = [
      makeTask({ id: '1.1', status: 'completed' }),
      makeTask({ id: '1.2', status: 'pending' }),
    ]

    const result = await modifyPlan(task, 'Project', children, 'simplify')

    expect(result.removed).not.toContain('1.1')
    expect(result.removed).toContain('1.2')
  })

  it('filters out active tasks from removed list', async () => {
    const diff = { unchanged: [], modified: [], added: [], removed: ['1.1'] }
    mockModifyTasks.mockResolvedValue(diff)

    const task = makeTask({ id: '1' })
    const children: Task[] = [makeTask({ id: '1.1', status: 'active' })]
    const result = await modifyPlan(task, 'Project', children, 'simplify')
    expect(result.removed).toHaveLength(0)
  })
})
