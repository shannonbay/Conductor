/**
 * Runs goals in this session. Every 30 s (and right after "Run now" or an
 * approval) it asks the quarterdeck MCP server for a scheduler pass, which
 * claims the runs that are due, and starts each one in a background subagent
 * of its own. It stops runs that pass their time limit, and records a run
 * that ended without end_run as failed.
 *
 * Only one session runs goals at a time (the server's lease); others idle.
 */
import type { EngineInterface } from 'claude-code'

import type { RunEntry } from '../types'
import { attachAgent, cancelRunRecord, failRun, releaseLease, reportWatch, resultText, tick, type ClaimedRun, type ToolWatch } from './api'
import { addRun, getNotice, getRuns, getSnapshot, removeRun, setGuardMissing, setNotice } from './state'
import { serverToolNames } from './names'

type Engine = EngineInterface

export const RUNNER_AGENT = 'quarterdeck-goals:goal-runner'
const TICK_MS = 30_000
const ENDED = new Set(['completed', 'failed', 'killed'])

/** The tool the quarterdeck-guard plugin registers; without it no run is started. */
export const GUARD_TOOL = 'mcp__quarterdeck-guard__status'
export const GUARD_MISSING = "Goal runs are paused: the quarterdeck-guard plugin (it keeps runs within their goal) isn't loaded. Run /reload-plugins; if this stays, install it with: claude plugin install quarterdeck-guard@quarterdeck"
/** At start-up and after /reload-plugins the guard's tool can register a moment after ours: say nothing until it has been missing this long. */
export const GUARD_GRACE_MS = 10_000
const GUARD_RECHECK_MS = 2_000

/** Quarterdeck tools a run's agent must never call: the human's and the plugin's own (under both server prefixes). */
export const HUMAN_ONLY_TOOLS = serverToolNames(
  'goals_tick',
  'decide_item',
  'cancel_run',
  'set_goal_status',
  'attach_agent',
  'fail_run',
  'guard_check',
  'create_goal',
  'delete_goal',
  'delete_memory',
  'set_schedule',
  'update_goal',
  'report_run_end',
  'watch_report',
  'run_progress',
)

/** Also refused to a run's agent: a run doesn't queue more runs. */
export const RUN_AGENT_DENIED_TOOLS = [...HUMAN_ONLY_TOOLS, ...serverToolNames('run_goal')]

const RUNNER_PROMPT = `You carry out one run of a Quarterdeck persistent goal: a standing objective that is never finished. You start with no memory; the goal brief has everything. Work inside the goal's autonomy: never take an action whose category is "propose" or "off" unless the brief shows an approved item for it. Keep within the time you are given, and always finish with end_run. Pass run_scope, set to your run id, on every Quarterdeck tool call (get_goal_brief, add_item, end_run and the rest). Your final message is shown to nobody but Quarterdeck, so keep it to one line.`

/** The agent type every run uses, hidden from the model (see register). */
export async function registerRunnerAgent($: Engine): Promise<void> {
  await $.agent.register({
    name: 'goal-runner',
    description: 'Runs one Quarterdeck goal run. Started by the quarterdeck-goals plugin only.',
    prompt: RUNNER_PROMPT,
    // guard_check stays callable: the plugin calls it inside the run's loop (the guard refuses it to the agent)
    disallowedTools: [
      ...RUN_AGENT_DENIED_TOOLS.filter((t) => !t.endsWith('__guard_check')),
      'mcp__quarterdeck-goals__approve_item', 'mcp__quarterdeck-goals__reject_item', 'mcp__quarterdeck-goals__answer_item', 'mcp__quarterdeck-goals__run_goal', 'mcp__quarterdeck-goals__set_schedule', 'mcp__quarterdeck-goals__update_goal',
    ],
    background: true,
  })
}

let timer: { cancel: () => void } | null = null
let ticking: Promise<void> | null = null
/** When the guard was first found missing, and the early look that follows (the next tick is up to 30 s away). */
let guardMissingSince: number | null = null
let recheck: { cancel: () => void } | null = null

export function startRunner($: Engine): void {
  timer?.cancel()
  recheck?.cancel()
  recheck = null
  guardMissingSince = null
  timer = $.clock.every(TICK_MS, () => void runPass($))
  void runPass($)
}

/** Stops ticking and gives the lease up, so another open session takes over. */
export async function stopRunner($: Engine): Promise<void> {
  timer?.cancel()
  timer = null
  recheck?.cancel()
  recheck = null
  await releaseLease($, await $.session.id()).catch(() => { /* the server may already be gone */ })
}

/** A pass now (after "Run now" or an approval) instead of within 30 s. Shares a pass under way. */
export function kick($: Engine): Promise<void> {
  return runPass($)
}

function runPass($: Engine): Promise<void> {
  ticking ??= pass($).catch(() => { /* not connected: the pane shows it; the next tick retries */ }).finally(() => {
    ticking = null
  })
  return ticking
}

// The pane re-reads on its own poll (every 5 s while a run is open).
async function pass($: Engine): Promise<void> {
  await reconcile($)
  // Unguarded runs could act outside their goal: start none without the guard plugin.
  // Checked every pass, so the pane's warning goes as soon as the guard loads.
  const guarded = (await $.tool.list()).some((t) => t.name === GUARD_TOOL)
  recheck?.cancel()
  recheck = null
  if (guarded) guardMissingSince = null
  else {
    // Still loading, most likely: look again shortly, and warn only once the grace has passed
    const now = await $.clock.now()
    guardMissingSince ??= now
    if (now - guardMissingSince < GUARD_GRACE_MS) recheck = $.clock.after(GUARD_RECHECK_MS, () => void runPass($))
  }
  await setGuardMissing($, guardMissingSince !== null && (await $.clock.now()) - guardMissingSince >= GUARD_GRACE_MS)
  // 0.3.0 kept this warning in the action notice, where nothing cleared it
  if (guarded && (await getNotice($)) === GUARD_MISSING) await setNotice($, null)
  if (!guarded) return
  const runs = await getRuns($)
  const { claimed, toolWatches } = await tick($, await $.session.id(), Object.values(runs).map((r) => r.runId))
  for (const run of claimed) await start($, run)
  // After the runs, so a slow connector never holds a run back
  let fresh = false
  for (const watch of toolWatches) fresh = (await checkToolWatch($, watch)) || fresh
  // Something new queued a run: claim it now, not in 30 s
  if (fresh) {
    const again = await tick($, await $.session.id(), Object.values(await getRuns($)).map((r) => r.runId), false)
    for (const run of again.claimed) await start($, run)
  }
}

/** How long a watch's tool may take before the check counts as failed. */
export const WATCH_CALL_MS = 30_000
/** The most of a tool's answer sent on: ids are near the start, and a huge answer isn't worth a watch. */
const WATCH_TEXT_MAX = 60_000

/**
 * Checks one tool watch: calls its tool (a connector's search, say) with nobody
 * asked, and reports the answer to Quarterdeck, which works out what is new.
 * True when that queued a run.
 */
async function checkToolWatch($: Engine, watch: ToolWatch): Promise<boolean> {
  let report: { text: string } | { error: string }
  try {
    const answer = await Promise.race([
      $.tool.call({ tool: watch.tool, ...watch.input } as never),
      $.clock.sleep(WATCH_CALL_MS).then(() => 'timeout' as const),
    ])
    if (answer === 'timeout') report = { error: `${watch.tool} didn't answer within ${WATCH_CALL_MS / 1000} s` }
    else if (answer.deny !== undefined) report = { error: `Claude Code refused the call: ${answer.deny}` }
    else if (answer.isError === true) report = { error: resultText(answer).slice(0, 500) }
    else report = { text: resultText(answer).slice(0, WATCH_TEXT_MAX) }
  } catch (err) {
    report = { error: err instanceof Error ? err.message : String(err) }
  }
  return reportWatch($, watch.watch_id, report).then((r) => r.queued_run !== null).catch(() => false)
}

/** Starts a claimed run in a subagent; a run that can't start is marked failed. */
async function start($: Engine, run: ClaimedRun): Promise<void> {
  let agentId: string | undefined
  let why = 'no agent was started'
  const description = `Goal: ${run.name} (${run.run_id})`
  try {
    const r = await $.agent.spawn({ subagentType: RUNNER_AGENT, prompt: run.prompt, description, cwd: run.working_dir, ...(run.model ? { model: run.model } : {}) })
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
export async function reconcile($: Engine): Promise<boolean> {
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

async function stopAgent($: Engine, agentId: string): Promise<void> {
  await $.tool.call({ tool: 'TaskStop', task_id: agentId } as never).catch(() => {})
}

/** Cancels a goal's open run and stops its subagent if this session started it. */
export async function cancelRun($: Engine, goalId: string): Promise<void> {
  const { agentId } = await cancelRunRecord($, goalId)
  const runs = await getRuns($)
  const mine = agentId && runs[agentId] ? agentId : Object.keys(runs).find((id) => runs[id]!.goalId === goalId)
  if (mine) {
    await stopAgent($, mine)
    await removeRun($, mine)
  }
}
