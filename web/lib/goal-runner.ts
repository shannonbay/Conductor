/**
 * Runs one persistent-goal run in the connected Claude Code session via the
 * channel, streams its progress into the activity feed, and enforces the
 * goal's run time limit. See specs/persistent-goals.md.
 */
import { nanoid } from 'nanoid'
import { generateNickname } from './agent-nickname'
import {
  getGoal, getPlan, getRun, insertRun, startRun, failRun, updateRun, createSession, updateSession,
  type GoalRun,
} from './db'
import { recordEvent } from './event-log'
import { broadcast } from './ws-broadcaster'
import {
  startGoalRunViaChannel, streamAgentEvents, cancelAgentViaChannel, ChannelBusyError, ChannelNotConnectedError,
} from './channel-client'

interface ActiveRun {
  runId: string
  sessionId: string
  requestId: string | null
  controller: AbortController
  timer: ReturnType<typeof setTimeout>
}

// One active run per goal (the channel only handles one request at a time anyway).
// Anchored to globalThis so server.ts (which runs the scheduler) and Next.js API
// routes (cancel) share it — Next compiles routes as separate module instances.
const g = globalThis as typeof globalThis & { __conductorGoalRuns?: Map<string, ActiveRun> }
g.__conductorGoalRuns ??= new Map()
const active = g.__conductorGoalRuns

export function isGoalRunActive(planId?: string): boolean {
  return planId ? active.has(planId) : active.size > 0
}

/** Runs being tracked in this process (anything else marked "running" in the DB is stale). */
export function activeRunIds(): Set<string> {
  return new Set([...active.values()].map((a) => a.runId))
}

/**
 * Starts a run. Uses the queued run if given, otherwise creates one.
 * Returns once the run is handed to the channel; the run continues in the background.
 */
export async function startGoalRun(planId: string, opts: { queuedRunId?: string; trigger?: GoalRun['trigger'] } = {}): Promise<GoalRun> {
  if (active.has(planId)) throw new Error('This goal already has a run in progress.')
  const plan = getPlan(planId)
  const goal = getGoal(planId)
  if (!plan || !goal) throw new Error(`Goal ${planId} not found`)

  const run = opts.queuedRunId ? getRun(opts.queuedRunId)! : insertRun(planId, opts.trigger ?? 'manual', 'queued')
  const sessionId = nanoid()
  createSession({
    id: sessionId, plan_id: planId, root_task_id: '', nickname: generateNickname(),
    status: 'running', autonomy_level: 'full', model: 'claude-code', started_at: new Date().toISOString(),
  })
  startRun(run.id, sessionId)

  const controller = new AbortController()
  const timer = setTimeout(() => {
    void cancelGoalRun(planId, 'timed_out', `Run exceeded its ${goal.limits.max_run_minutes}-minute limit`)
  }, goal.limits.max_run_minutes * 60_000)
  const entry: ActiveRun = { runId: run.id, sessionId, requestId: null, controller, timer }
  active.set(planId, entry)

  try {
    entry.requestId = await startGoalRunViaChannel({
      planId, runId: run.id, goalName: plan.name, workingDir: plan.working_dir, maxRunMinutes: goal.limits.max_run_minutes,
    })
  } catch (err) {
    clearTimeout(timer)
    active.delete(planId)
    const busy = err instanceof ChannelBusyError || err instanceof ChannelNotConnectedError
    const reason = err instanceof ChannelNotConnectedError ? 'Claude Code not connected' : busy ? 'channel busy' : (err as Error).message
    updateRun(run.id, { status: busy ? 'skipped' : 'failed', skip_reason: busy ? reason : null, summary: busy ? null : reason, ended_at: new Date().toISOString() })
    updateSession(sessionId, { status: 'failed', ended_at: new Date().toISOString(), error: reason })
    throw err
  }

  recordEvent({ planId, taskId: planId, eventType: 'agent_started', actor: 'agent', sessionId, payload: { run_id: run.id, trigger: run.trigger } })
  broadcast(planId, { type: 'agent_started', sessionId, rootTaskId: '' })

  void streamRun(planId, entry)
  return getRun(run.id)!
}

async function streamRun(planId: string, entry: ActiveRun): Promise<void> {
  const { runId, sessionId, requestId, controller } = entry
  try {
    for await (const event of streamAgentEvents(requestId!, controller.signal)) {
      if (event.type === 'update') {
        recordEvent({
          planId, taskId: planId, eventType: event.tool ? 'tool_call' : 'agent_message', actor: 'agent', sessionId,
          payload: { message: event.message, tool: event.tool ?? undefined },
        })
        broadcast(planId, { type: 'agent_turn', sessionId, message: event.message, tool: event.tool ?? null })
      } else if (event.type === 'done') {
        finish(planId, entry, 'completed')
        return
      } else if (event.type === 'cancelled') {
        return // cancelGoalRun already recorded the outcome
      } else if (event.type === 'error') {
        throw new Error(event.message ?? 'Agent error')
      }
    }
    if (!controller.signal.aborted) finish(planId, entry, 'failed', 'The connection to Claude Code ended before the run finished')
  } catch (err) {
    if (!controller.signal.aborted) finish(planId, entry, 'failed', err instanceof Error ? err.message : String(err))
  } finally {
    clearTimeout(entry.timer)
    if (active.get(planId)?.runId === runId) active.delete(planId)
  }
}

/** Records how a run ended. A run the agent didn't close with end_run is marked failed. */
function finish(planId: string, entry: ActiveRun, outcome: 'completed' | 'failed', error?: string): void {
  const now = new Date().toISOString()
  const run = getRun(entry.runId)
  if (run?.status === 'running') {
    failRun(entry.runId, 'failed', error ?? 'The agent finished without calling end_run, so no summary was recorded')
  }
  const ok = outcome === 'completed' && getRun(entry.runId)?.status === 'completed'
  updateSession(entry.sessionId, { status: ok ? 'completed' : 'failed', ended_at: now, ...(ok ? {} : { error: error ?? getRun(entry.runId)?.summary ?? undefined }) })
  recordEvent({
    planId, taskId: planId, eventType: ok ? 'agent_completed' : 'agent_failed', actor: 'agent', sessionId: entry.sessionId,
    payload: ok ? { run_id: entry.runId } : { run_id: entry.runId, error: getRun(entry.runId)?.summary },
  })
  broadcast(planId, { type: ok ? 'agent_completed' : 'agent_failed', sessionId: entry.sessionId })
}

/** Stops a goal's active run (human cancel or time limit). */
export async function cancelGoalRun(planId: string, status: 'failed' | 'timed_out' = 'failed', reason = 'Cancelled by you'): Promise<void> {
  const entry = active.get(planId)
  if (!entry) throw new Error('This goal has no run in progress.')
  entry.controller.abort()
  clearTimeout(entry.timer)
  active.delete(planId)
  if (entry.requestId) await cancelAgentViaChannel(entry.requestId).catch(() => {})
  failRun(entry.runId, status, reason)
  updateSession(entry.sessionId, { status: 'cancelled', ended_at: new Date().toISOString(), error: reason })
  recordEvent({ planId, taskId: planId, eventType: 'agent_cancelled', actor: status === 'timed_out' ? 'agent' : 'human', sessionId: entry.sessionId, payload: { run_id: entry.runId, reason } })
  broadcast(planId, { type: 'agent_cancelled', sessionId: entry.sessionId })
}

/** Test helper: forget tracked runs. */
export function _resetGoalRunner(): void {
  for (const e of active.values()) clearTimeout(e.timer)
  active.clear()
}
