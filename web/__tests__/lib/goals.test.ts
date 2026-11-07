import { describe, it, expect, vi, beforeEach } from 'vitest'

// Fake channel: each test controls the events a run streams
let releaseStream: (events: { type: string; message?: string }[]) => void = () => {}
vi.mock('@/lib/channel-client', () => {
  class ChannelBusyError extends Error { constructor() { super('busy'); this.name = 'ChannelBusyError' } }
  class ChannelNotConnectedError extends Error { constructor() { super('not connected'); this.name = 'ChannelNotConnectedError' } }
  return {
    ChannelBusyError,
    ChannelNotConnectedError,
    startGoalRunViaChannel: vi.fn(async () => 'req_1'),
    cancelAgentViaChannel: vi.fn(async () => {}),
    getChannelStatus: vi.fn(async () => ({ connected: true, busy: false })),
    streamAgentEvents: vi.fn(async function* () {
      const events = await new Promise<{ type: string; message?: string }[]>((resolve) => { releaseStream = resolve })
      for (const e of events) yield e
    }),
  }
})

import * as channel from '@/lib/channel-client'
import { startGoalRun, cancelGoalRun, isGoalRunActive, _resetGoalRunner } from '@/lib/goal-runner'
import { tickGoals } from '@/lib/goal-scheduler'
import { createGoal, getRun, listRuns, queueRun, getGoal, updateGoal, getActiveSession, getDb } from '@/lib/db'
import * as core from '@conductor/core'

const now = new Date().toISOString()
function makeGoal(id = 'goal_1', interval?: { minutes: number }) {
  createGoal({ id, name: 'Inbox', description: null, status: 'active', working_dir: '/tmp', created_at: now, updated_at: now }, { objective: 'Inbox zero' }, interval)
  return id
}
const flush = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  _resetGoalRunner()
  vi.mocked(channel.startGoalRunViaChannel).mockClear().mockResolvedValue('req_1')
  vi.mocked(channel.cancelAgentViaChannel).mockClear()
})

describe('goal-runner', () => {
  it('starts a run via the channel and completes it when the agent ended the run', async () => {
    const id = makeGoal()
    const run = await startGoalRun(id)
    expect(run.status).toBe('running')
    expect(isGoalRunActive(id)).toBe(true)
    expect(channel.startGoalRunViaChannel).toHaveBeenCalledWith(expect.objectContaining({ planId: id, runId: run.id, maxRunMinutes: 15 }))

    core.endRun(getDb(), run.id, 'Handled everything.') // the agent calls end_run over MCP
    releaseStream([{ type: 'update', message: 'reading mail' }, { type: 'done' }])
    await flush()

    expect(getRun(run.id)).toMatchObject({ status: 'completed', summary: 'Handled everything.' })
    expect(isGoalRunActive(id)).toBe(false)
    expect(getActiveSession(id)).toBeUndefined()
  })

  it('marks the run failed if the agent finishes without end_run', async () => {
    const id = makeGoal()
    const run = await startGoalRun(id)
    releaseStream([{ type: 'done' }])
    await flush()
    expect(getRun(run.id)).toMatchObject({ status: 'failed', summary: expect.stringMatching(/without calling end_run/) })
  })

  it('records a skipped run when the channel is busy', async () => {
    const id = makeGoal()
    vi.mocked(channel.startGoalRunViaChannel).mockRejectedValueOnce(new channel.ChannelBusyError())
    await expect(startGoalRun(id)).rejects.toThrow()
    expect(listRuns(id)[0]).toMatchObject({ status: 'skipped', skip_reason: 'channel busy' })
    expect(isGoalRunActive(id)).toBe(false)
  })

  it('cancelGoalRun stops the run and tells the channel', async () => {
    const id = makeGoal()
    const run = await startGoalRun(id)
    await cancelGoalRun(id)
    expect(channel.cancelAgentViaChannel).toHaveBeenCalledWith('req_1')
    expect(getRun(run.id)).toMatchObject({ status: 'failed', summary: 'Cancelled by you' })
    releaseStream([])
  })

  it('uses a queued run instead of creating another', async () => {
    const id = makeGoal()
    const queued = queueRun(id)
    const run = await startGoalRun(id, { queuedRunId: queued.id })
    expect(run.id).toBe(queued.id)
    expect(listRuns(id)).toHaveLength(1)
    releaseStream([])
  })
})

describe('goal-scheduler tickGoals', () => {
  const deps = (status = { connected: true, busy: false }) => ({
    channelStatus: vi.fn(async () => status),
    start: vi.fn(async () => ({}) as never),
  })

  it('starts a due interval goal and schedules the next run', async () => {
    const id = makeGoal('goal_i', { minutes: 30 })
    const d = deps()
    const t = new Date(Date.now() + 1000)
    await tickGoals(t, d)
    expect(d.start).toHaveBeenCalledWith(id, { queuedRunId: undefined, trigger: 'interval' })
    expect(getGoal(id)!.next_run_at).toBe(new Date(t.getTime() + 30 * 60_000).toISOString())
  })

  it('starts a queued manual run', async () => {
    const id = makeGoal()
    const q = queueRun(id)
    const d = deps()
    await tickGoals(new Date(), d)
    expect(d.start).toHaveBeenCalledWith(id, { queuedRunId: q.id, trigger: 'manual' })
  })

  it('records a skip when Claude Code is not connected, and keeps the run due', async () => {
    const id = makeGoal('goal_i', { minutes: 30 })
    const d = deps({ connected: false, busy: false })
    await tickGoals(new Date(Date.now() + 1000), d)
    expect(d.start).not.toHaveBeenCalled()
    expect(listRuns(id)[0]).toMatchObject({ status: 'skipped', skip_reason: 'Claude Code not connected' })
  })

  it('starts at most one run per tick', async () => {
    makeGoal('goal_a', { minutes: 30 })
    makeGoal('goal_b', { minutes: 30 })
    const d = deps()
    await tickGoals(new Date(Date.now() + 1000), d)
    expect(d.start).toHaveBeenCalledTimes(1)
  })

  it('does nothing for paused goals', async () => {
    const id = makeGoal('goal_i', { minutes: 30 })
    updateGoal(id, { status: 'paused' })
    const d = deps()
    await tickGoals(new Date(Date.now() + 1000), d)
    expect(d.channelStatus).not.toHaveBeenCalled()
  })

  it('expires stale running runs that no process is tracking', async () => {
    const id = makeGoal()
    const run = core.insertRun(getDb(), id, 'manual', 'running')
    getDb().prepare('UPDATE goal_runs SET started_at = ? WHERE id = ?').run(new Date(Date.now() - 3_600_000).toISOString(), run.id)
    await tickGoals(new Date(), deps())
    expect(getRun(run.id)).toMatchObject({ status: 'timed_out' })
  })
})
