/**
 * Wakes persistent goals: every 30 s, decides for each active goal whether a
 * run is due and starts it through the channel. Lives in the web server
 * process, so goals only run while the web app and a channel-connected
 * Claude Code session are running. See specs/persistent-goals.md.
 */
import {
  listGoals, decideTick, updateGoal, updateRun, recordSkip, nextIntervalRun, archiveResolved, getDb, failRun,
} from './db'
import { getChannelStatus } from './channel-client'
import { startGoalRun, isGoalRunActive, activeRunIds } from './goal-runner'

const TICK_MS = 30_000
/** Grace period beyond a goal's max_run_minutes before a "running" run is considered dead. */
const STALE_GRACE_MS = 5 * 60_000

// Shared across module instances (server.ts vs Next.js API routes) via globalThis
const g = globalThis as typeof globalThis & {
  __conductorGoalScheduler?: { timer: ReturnType<typeof setInterval> | null; ticking: boolean; kick: (() => void) | null }
}
g.__conductorGoalScheduler ??= { timer: null, ticking: false, kick: null }
const state = g.__conductorGoalScheduler

export interface TickDeps {
  channelStatus: () => Promise<{ connected: boolean; busy: boolean }>
  start: typeof startGoalRun
}

const defaultDeps: TickDeps = {
  channelStatus: () => getChannelStatus().catch(() => ({ connected: false, busy: false })),
  start: startGoalRun,
}

/** Runs one scheduler pass. Exported for tests and for "Run now" to avoid waiting for the next tick. */
export async function tickGoals(now: Date = new Date(), deps: TickDeps = defaultDeps): Promise<void> {
  if (state.ticking) return
  state.ticking = true
  try {
    expireStaleRuns(now)
    const goals = listGoals('active')
    if (goals.length === 0) return

    let channel: { connected: boolean; busy: boolean } | null = null
    for (const { plan } of goals) {
      archiveResolved(plan.id, now)
      const decision = decideTick(plan.id, now)
      if (decision.action === 'none') continue

      if (decision.action === 'defer') {
        updateGoal(plan.id, { next_run_at: decision.next_run_at })
        continue
      }

      if (decision.action === 'skip') {
        if (decision.queuedRunId) {
          updateRun(decision.queuedRunId, { status: 'skipped', skip_reason: decision.reason, ended_at: now.toISOString() })
        } else {
          recordSkip(plan.id, decision.trigger, decision.reason, now)
        }
        updateGoal(plan.id, { next_run_at: nextIntervalRun(plan.id, now) })
        continue
      }

      // start — the channel serves one request at a time
      channel ??= await deps.channelStatus()
      const blocked = !channel.connected ? 'Claude Code not connected'
        : channel.busy || isGoalRunActive() ? 'channel busy'
        : null
      if (blocked) {
        recordSkip(plan.id, decision.trigger, blocked, now) // stays due; retried next tick
        continue
      }
      try {
        await deps.start(plan.id, { queuedRunId: decision.queuedRunId, trigger: decision.trigger })
        channel.busy = true
      } catch (err) {
        console.error(`[goals] could not start run for ${plan.id}:`, err instanceof Error ? err.message : err)
      }
      if (decision.trigger === 'interval') updateGoal(plan.id, { next_run_at: nextIntervalRun(plan.id, now) })
    }
  } finally {
    state.ticking = false
  }
}

/** Runs marked running in the DB that no process is tracking and are well past their limit. */
function expireStaleRuns(now: Date): void {
  const tracked = activeRunIds()
  const rows = getDb().prepare(`
    SELECT r.id, r.started_at, g.limits FROM goal_runs r JOIN goals g ON g.plan_id = r.plan_id WHERE r.status = 'running'
  `).all() as { id: string; started_at: string; limits: string }[]
  for (const r of rows) {
    if (tracked.has(r.id)) continue
    const maxMinutes = (JSON.parse(r.limits || '{}') as { max_run_minutes?: number }).max_run_minutes ?? 15
    if (now.getTime() - new Date(r.started_at).getTime() > maxMinutes * 60_000 + STALE_GRACE_MS) {
      failRun(r.id, 'timed_out', 'Run did not finish (the web app restarted or the agent stopped responding)')
    }
  }
}

export function startGoalScheduler(): void {
  if (state.timer) return
  state.timer = setInterval(() => void tickGoals(), TICK_MS)
  // The kick runs in this (server.ts) module instance, whichever instance calls kickScheduler
  state.kick = () => void tickGoals()
  void tickGoals()
}

export function stopGoalScheduler(): void {
  if (state.timer) clearInterval(state.timer)
  state.timer = null
  state.kick = null
}

/** Ask for a pass now (after "Run now" or an approval) instead of waiting up to 30 s. No-op if the scheduler isn't running. */
export function kickScheduler(): void {
  state.kick?.()
}
