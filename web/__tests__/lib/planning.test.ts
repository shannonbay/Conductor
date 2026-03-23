import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Task } from '@/lib/db.js'

// Shared mock function — used by ALL instances of MockAnthropic
const mockCreate = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate }
  },
}))

// Import planning AFTER the mock is set up
const { generatePlan, modifyPlan } = await import('@/lib/planning.js')

beforeEach(() => {
  mockCreate.mockReset()
})

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: '1',
    project_id: 'proj_test',
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
  it('returns parsed ProposedTask[] from valid AI response', async () => {
    const proposed = [
      { goal: 'Subtask A', suggested_depends_on: [] },
      { goal: 'Subtask B', suggested_depends_on: [] },
    ]
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(proposed) }],
    })

    const result = await generatePlan(makeTask(), 'My Project', null, [])

    expect(result).toHaveLength(2)
    expect(result[0].goal).toBe('Subtask A')
    expect(result[1].goal).toBe('Subtask B')
  })

  it('throws on malformed AI response', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'not valid json at all' }],
    })

    await expect(generatePlan(makeTask(), 'Project', null, [])).rejects.toThrow()
  })

  it('strips markdown code blocks from response', async () => {
    const proposed = [{ goal: 'Task', suggested_depends_on: [] }]
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '```json\n' + JSON.stringify(proposed) + '\n```' }],
    })

    const result = await generatePlan(makeTask(), 'Project', null, [])
    expect(result).toHaveLength(1)
    expect(result[0].goal).toBe('Task')
  })

  it('includes parent context and siblings in prompt', async () => {
    const proposed = [{ goal: 'Task', suggested_depends_on: [] }]
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(proposed) }],
    })

    const sibling = makeTask({ id: '1.1', goal: 'Sibling task', status: 'abandoned', abandon_reason: 'API not available' })
    await generatePlan(makeTask({ id: '1.2' }), 'My Project', 'Parent goal', [sibling])

    const callArgs = mockCreate.mock.calls[0][0]
    const prompt = callArgs.messages[0].content as string
    expect(prompt).toContain('Parent goal')
    expect(prompt).toContain('Sibling task')
    expect(prompt).toContain('API not available')
  })
})

describe('modifyPlan', () => {
  it('returns a diff with unchanged, modified, added, removed', async () => {
    const diff = {
      unchanged: ['1.1'],
      modified: [{ replaces_id: '1.2', goal: 'Updated 1.2', suggested_depends_on: [] }],
      added: [{ goal: 'New task', suggested_depends_on: [] }],
      removed: ['1.3'],
    }
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(diff) }],
    })

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
    // AI mistakenly tries to remove a completed task
    const diff = {
      unchanged: [],
      modified: [],
      added: [],
      removed: ['1.1', '1.2'], // 1.1 is completed — should be protected
    }
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(diff) }],
    })

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
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(diff) }] })

    const task = makeTask({ id: '1' })
    const children: Task[] = [makeTask({ id: '1.1', status: 'active' })]
    const result = await modifyPlan(task, 'Project', children, 'simplify')
    expect(result.removed).toHaveLength(0)
  })
})
