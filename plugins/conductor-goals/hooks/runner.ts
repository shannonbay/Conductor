/**
 * Runs goals in this session. Every 30 s (and right after "Run now" or an
 * approval) it asks the conductor MCP server for a scheduler pass, which
 * claims the runs that are due, and starts each one in a background subagent
 * of its own. It stops runs that pass their time limit, and records a run
 * that ended without end_run as failed.
 *
 * Only one session runs goals at a time (the server's lease); others idle.
 */
import type { EngineInterface } from 'claude-code'

import type { RunEntry } from '../types'
import { attachAgent, cancelRunRecord, failRun, releaseLease, tick, type ClaimedRun } from './api'
import { addRun, getRuns, getSnapshot, removeRun, setNotice } from './state'

type $ = EngineInterface

export const RUNNER_AGENT = 'conductor-goals:goal-runner'
const TICK_MS = 30_000
const ENDED = new Set(['completed', 'failed', 'killed'])

/** The tool the conductor-goals-guard plugin registers; without it no run is started. */
export const GUARD_TOOL = 'mcp__conductor-goals-guard__status'
export const GUARD_MISSING = 'Goal runs are paused: install the conductor-goals-guard plugin (it keeps runs within their goal), then /reload-plugins.'

/** Conductor tools a run's agent must never call: the human's and the plugin's own. */
export const HUMAN_ONLY_TOOLS = [
  'mcp__conductor__goals_tick',
  'mcp__conductor__decide_item',
  'mcp__conductor__cancel_run',
  'mcp__conductor__set_goal_status',
  'mcp__conductor__attach_agent',
  'mcp__conductor__fail_run',
  'mcp__conductor__guard_check',
  'mcp__conductor__create_goal',
  'mcp__conductor__delete_memory',
]

/** Also refused to a run's agent: a run doesn't queue more runs. */
export const RUN_AGENT_DENIED_TOOLS = [...HUMAN_ONLY_TOOLS, 'mcp__conductor__run_goal']

const RUNNER_PROMPT = `You carry out one run of a Conductor persistent goal: a standing objective that is never finished. You start with no memory; the goal brief has everything. Work inside the goal's autonomy: never take an action whose category is "propose" or "off" unless the brief shows an approved item for it. Keep within the time you are given, and always finish with end_run. Your final message is shown to nobody but Conductor, so keep it to one line.`

/** The agent type every run uses, hidden from the model (see register). */
export async function registerRunnerAgent($: $): Promise<void> {
  await $.agent.register({
    name: 'goal-runner',
    description: 'Runs one Conductor goal run. Started by the conductor-goals plugin only.',
    prompt: RUNNER_PROMPT,
    // guard_check stays callable: the plugin calls it inside the run's loop (the guard refuses it to the agent)
    disallowedTools: [
      ...RUN_AGENT_DENIED_TOOLS.filter((t) => t !== 'mcp__conductor__guard_check'),
      'mcp__conductor-goals__approve_item', 'mcp__conductor-goals__reject_item', 'mcp__conductor-goals__run_goal',
    ],
    background: true,
  })
}

let timer: { cancel: () => void } | null = null
let ticking: Promise<void> | null = null

export function startRunner($: $): void {
  timer?.cancel()
  timer = $.clock.every(TICK_MS, () => void runPass($))
  void runPass($)
}

/** Stops ticking and gives the lease up, so another open session takes over. */
export async function stopRunner($: $): Promise<void> {
  timer?.cancel()
  timer = null
  await releaseLease($, await $.session.id()).catch(() => { /* the server may already be gone */ })
}

/** A pass now (after "Run now" or an approval) instead of within 30 s. Shares a pass under way. */
export function kick($: $): Promise<void> {
  return runPass($)
}

function runPass($: $): Promise<void> {
  ticking ??= pass($).catch(() => { /* not connected: the pane shows it; the next tick retries */ }).finally(() => {
    ticking = null
  })
  return ticking
}

// The pane re-reads on its own poll (every 5 s while a run is open).
async function pass($: $): Promise<void> {
  await reconcile($)
  // Unguarded runs could act outside their goal: start none without the guard plugin
  if (!(await $.tool.list()).some((t) => t.name === GUARD_TOOL)) {
    await setNotice($, GUARD_MISSING)
    return
  }
  const runs = await getRuns($)
  const { claimed } = await tick($, await $.session.id(), Object.values(runs).map((r) => r.runId))
  for (const run of claimed) await start($, run)
}

/** Starts a claimed run in a subagent; a run that can't start is marked failed. */
async function start($: $, run: ClaimedRun): Promise<void> {
  let agentId: string | undefined
  let why = 'no agent was started'
  const description = `Goal: ${run.name} (${run.run_id})`
  try {
    const r = await $.agent.spawn({ subagentType: RUNNER_AGENT, prompt: run.prompt, description, cwd: run.working_dir })
    agentId = r.agentId
    if ('deny' in r && typeof r.deny === 'string') why = r.deny
    // An answer without the id (a host that doesn't report it): find the agent by its description
    else if (!agentId) agentId = (await $.agent.list()).find((a) => a.description === description && !ENDED.has(a.status))?.id
  } catch (err) {
    why = err instanceof Error ? err.message : String(err)
  }
  if (!agentId) {
    await failRun($, run.run_id, 'failed', `Couldn't start the run's agent: ${why}`).catch(() => {})
    return
  }
  const now = await $.clock.now()
  const entry: RunEntry = {
    runId: run.run_id, goalId: run.goal_id, name: run.name, startedAt: now,
    deadline: now + run.max_run_minutes * 60_000, maxMinutes: run.max_run_minutes,
  }
  await addRun($, agentId, entry)
  await attachAgent($, run.run_id, agentId).catch(() => {})
}

/**
 * Finishes runs whose agent is gone or past its deadline. A run's agent may end
 * a turn and wait on background work, so only its status counts, not a turn
 * ending. Returns whether any run ended.
 */
export async function reconcile($: $): Promise<boolean> {
  const runs = await getRuns($)
  const ids = Object.keys(runs)
  if (ids.length === 0) return false
  const agents = await $.agent.list()
  const now = await $.clock.now()
  const snapshot = await getSnapshot($)
  let ended = false
  for (const agentId of ids) {
    const run = runs[agentId]!
    const agent = agents.find((a) => a.id === agentId)
    // Ended elsewhere (cancelled on the goal page or by another session): a read
    // taken after the run started no longer shows it open
    const card = snapshot.reachable && snapshot.fetchedAt > run.startedAt + 10_000 ? snapshot.goals.find((g) => g.id === run.goalId) : undefined
    const endedElsewhere = card !== undefined && card.openRun?.id !== run.runId
    if (endedElsewhere) {
      await stopAgent($, agentId)
    } else if (now >= run.deadline) {
      await stopAgent($, agentId)
      await failRun($, run.runId, 'timed_out', `Run exceeded its ${run.maxMinutes}-minute limit`).catch(() => {})
    } else if (!agent || ENDED.has(agent.status)) {
      // `changed` is false when the agent called end_run: the run finished normally
      await failRun($, run.runId, 'failed', 'The agent ended without calling end_run').catch(() => {})
    } else {
      continue
    }
    await removeRun($, agentId)
    ended = true
  }
  return ended
}

async function stopAgent($: $, agentId: string): Promise<void> {
  await $.tool.call({ tool: 'TaskStop', task_id: agentId } as never).catch(() => {})
}

/** Cancels a goal's open run and stops its subagent if this session started it. */
export async function cancelRun($: $, goalId: string): Promise<void> {
  const { agentId } = await cancelRunRecord($, goalId)
  const runs = await getRuns($)
  const mine = agentId && runs[agentId] ? agentId : Object.keys(runs).find((id) => runs[id]!.goalId === goalId)
  if (mine) {
    await stopAgent($, mine)
    await removeRun($, mine)
  }
}
