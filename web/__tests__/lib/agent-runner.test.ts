import { describe, it, expect, vi, beforeEach } from 'vitest'
import { insertPlan, insertTask as _insertTask, getTask, createSession, getDb } from '@/lib/db.js'

// Mock the channel client so tests don't need a running Claude Code session
const mockRequireChannel = vi.fn().mockResolvedValue(undefined)
const mockStartAgent = vi.fn().mockResolvedValue('req_test_123')
const mockCancelAgent = vi.fn().mockResolvedValue(undefined)
const mockSendHumanMessage = vi.fn().mockResolvedValue(undefined)

async function* mockStreamDone() {
  yield { type: 'done' as const, summary: 'finished' }
}

const mockStreamEvents = vi.fn().mockImplementation(mockStreamDone)

vi.mock('@/lib/channel-client.js', () => ({
  ChannelNotConnectedError: class ChannelNotConnectedError extends Error {
    constructor() { super('not connected'); this.name = 'ChannelNotConnectedError' }
  },
  ChannelBusyError: class ChannelBusyError extends Error {
    constructor() { super('busy'); this.name = 'ChannelBusyError' }
  },
  requireChannel: mockRequireChannel,
  startAgentViaChannel: mockStartAgent,
  streamAgentEvents: mockStreamEvents,
  cancelAgentViaChannel: mockCancelAgent,
  sendHumanMessageToAgent: mockSendHumanMessage,
}))

beforeEach(() => {
  mockRequireChannel.mockReset().mockResolvedValue(undefined)
  mockStartAgent.mockReset().mockResolvedValue('req_test_123')
  mockStreamEvents.mockReset().mockImplementation(mockStreamDone)
  mockCancelAgent.mockReset().mockResolvedValue(undefined)
  mockSendHumanMessage.mockReset().mockResolvedValue(undefined)
})

function insertTestProject(id: string) {
  const now = new Date().toISOString()
  insertPlan({ id, name: 'Test', description: null, status: 'active', working_dir: '/tmp', focus_task_id: null, created_at: now, updated_at: now })
  return id
}

function insertTestTask(planId: string, id: string) {
  const now = new Date().toISOString()
  _insertTask({
    id,
    plan_id: planId,
    goal: `Task ${id}`,
    status: 'active',
    result: null,
    abandon_reason: null,
    state: {},
    depends_on: null,
    created_at: now,
    updated_at: now,
  })
}

function getSession(id: string): { status: string; id: string } | undefined {
  return getDb().prepare('SELECT id, status FROM agent_sessions WHERE id = ?').get(id) as { status: string; id: string } | undefined
}

describe('startAgent', () => {
  it('throws if an active session already exists', async () => {
    const planId = insertTestProject('plan_exists')
    insertTestTask(planId, '1')

    const now = new Date().toISOString()
    createSession({ id: 'existing', plan_id: planId, root_task_id: '1', nickname: 'TestAgent', status: 'running', autonomy_level: 'full', model: 'test', started_at: now })

    const { startAgent } = await import('@/lib/agent-runner.js')
    await expect(startAgent(planId, '1')).rejects.toThrow('already active')
  })

  it('creates a session row on start', async () => {
    const planId = insertTestProject('plan_new_unique')
    insertTestTask(planId, '1')
    insertTestTask(planId, '1.1')

    const { startAgent } = await import('@/lib/agent-runner.js')
    const { sessionId } = await startAgent(planId, '1')

    expect(sessionId).toBeTruthy()
    const sess = getSession(sessionId)
    expect(sess).toBeDefined()
    expect(sess?.id).toBe(sessionId)
  })

  it('throws if project does not exist', async () => {
    const { startAgent } = await import('@/lib/agent-runner.js')
    await expect(startAgent('plan_nonexistent', '1')).rejects.toThrow()
  })

  it('throws if task does not exist', async () => {
    const planId = insertTestProject('plan_notask')
    const { startAgent } = await import('@/lib/agent-runner.js')
    await expect(startAgent(planId, '99')).rejects.toThrow()
  })

  it('throws ChannelNotConnectedError when channel is not connected', async () => {
    const planId = insertTestProject('plan_noconn')
    insertTestTask(planId, '1')
    mockRequireChannel.mockRejectedValue(Object.assign(new Error('not connected'), { name: 'ChannelNotConnectedError' }))

    const { startAgent } = await import('@/lib/agent-runner.js')
    await expect(startAgent(planId, '1')).rejects.toMatchObject({ name: 'ChannelNotConnectedError' })
  })
})

describe('cancelAgent', () => {
  it('sets session status to cancelled and unlocks subtree', async () => {
    const planId = insertTestProject('plan_cancel')
    insertTestTask(planId, '1')

    const now = new Date().toISOString()
    createSession({ id: 'sess_to_cancel', plan_id: planId, root_task_id: '1', nickname: 'TestAgent', status: 'running', autonomy_level: 'full', model: 'test', started_at: now })

    // Lock the task manually
    getDb().prepare('UPDATE tasks SET locked_by = ?, locked_at = ? WHERE id = ? AND plan_id = ?')
      .run('sess_to_cancel', now, '1', planId)

    const { cancelAgent } = await import('@/lib/agent-runner.js')
    await cancelAgent(planId)

    const sess = getSession('sess_to_cancel')
    expect(sess?.status).toBe('cancelled')
    expect(getTask(planId, '1')?.locked_by).toBeNull()
  })
})

describe('pauseAgent / resumeAgent', () => {
  it('pauses a running session', async () => {
    const planId = insertTestProject('plan_pause')
    insertTestTask(planId, '1')

    const now = new Date().toISOString()
    createSession({ id: 'sess_pause', plan_id: planId, root_task_id: '1', nickname: 'TestAgent', status: 'running', autonomy_level: 'full', model: 'test', started_at: now })

    const { pauseAgent } = await import('@/lib/agent-runner.js')
    pauseAgent(planId)

    expect(getSession('sess_pause')?.status).toBe('paused')
  })

  it('resumes a paused session', async () => {
    const planId = insertTestProject('plan_resume')
    insertTestTask(planId, '1')

    const now = new Date().toISOString()
    createSession({ id: 'sess_resume', plan_id: planId, root_task_id: '1', nickname: 'TestAgent', status: 'paused', autonomy_level: 'full', model: 'test', started_at: now })

    const { resumeAgent } = await import('@/lib/agent-runner.js')
    resumeAgent(planId)

    expect(getSession('sess_resume')?.status).toBe('running')
  })

  it('throws when trying to pause with no running session', async () => {
    const planId = insertTestProject('plan_pause_fail')
    const { pauseAgent } = await import('@/lib/agent-runner.js')
    expect(() => pauseAgent(planId)).toThrow()
  })

  it('throws when trying to resume with no paused session', async () => {
    const planId = insertTestProject('plan_resume_fail')
    const { resumeAgent } = await import('@/lib/agent-runner.js')
    expect(() => resumeAgent(planId)).toThrow()
  })
})
