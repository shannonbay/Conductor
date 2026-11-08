/**
 * Conductor goals beside the chat. Wiring only: settings, start-up, polling,
 * the goal runner (runs in background subagents) and its guard, commands,
 * tools Claude can call, the Goals pane and the band shown while goal runs
 * are going. See README.md for what each does.
 */
import type { EngineInterface, Register } from 'claude-code'

import { resetAlerts } from './alerts'
import { configure } from './api'
import { ago } from './model'
import { renderPane } from './pane'
import { reconcile, registerRunnerAgent, RUNNER_AGENT, startRunner, stopRunner } from './runner'
import { getActiveRun, getRuns, getSnapshot, PANE, setActiveRun } from './state'
import { refresh, startPolling, stopPolling } from './sync'
import { goalCommand, newGoal, registerCommands, registerTools, runTool, scheduleCommand, type ToolName } from './tools'
import { todoCommand } from './todos'

type $ = EngineInterface

// Whether this copy of the module has started. session.start does it, but a
// module loaded into a running session (a reload) may not see one, so the
// first prompt or command does it instead.
let started = false

async function start($: $, openPane: boolean): Promise<void> {
  if (started) return
  started = true
  resetAlerts()
  await registerCommands($)
  await registerTools($)
  await registerRunnerAgent($)
  const first = await refresh($)
  startPolling($, first)
  startRunner($)
  if (openPane && first.goals.some((g) => g.needsYou.length > 0)) void $.ui.open({ id: PANE, title: 'Goals' })
}

/** Start-up must never block the session or a prompt; a failure retries on the next prompt. */
async function safeStart($: $, openPane: boolean): Promise<void> {
  try {
    await start($, openPane)
  } catch {
    started = false
  }
}

/** A tool call of this plugin, answered as text. */
async function answerTool($: $, name: ToolName, e: object) {
  const { text, isError } = await runTool($, name, e as Record<string, unknown>)
  return { result: isError ? `Error: ${text}` : text }
}

/** The goal and run ids a conductor MCP call carries. */
function runIds(e: object): { goalId: string | null; runId: string | null } {
  const input = e as { goal_id?: unknown; run_id?: unknown }
  return {
    goalId: typeof input.goal_id === 'string' ? input.goal_id : null,
    runId: typeof input.run_id === 'string' ? input.run_id : null,
  }
}

// Each hook's .catch: fall back to the engine's own behaviour (replaying it
// if the hook had already called next), or answer with a plain error, so the
// plugin can never block the session.
function passOn<E, R>(_$: $, e: E, next: (e: E) => R): R {
  return next(e)
}
function failedCommand() {
  return { text: 'conductor-goals hit an error; see the Goals pane, or run claude --debug.' }
}
function failedTool() {
  return { result: 'Error: the conductor-goals tool failed unexpectedly.' }
}

export const register: Register = (on, options) => {
  configure(options)

  on('session.start', async ($, e, next) => {
    await safeStart($, true)
    return next(e)
  }).catch(passOn)

  on('prompt.submit', async ($, e, next) => {
    await safeStart($, false)
    return next(e)
  }).catch(passOn)

  on('session.end', async ($, e, next) => {
    stopPolling()
    await stopRunner($)
    started = false
    return next(e)
  }).catch(passOn)

  // Goal runs: the runner's agent type is the plugin's alone. What a run may do
  // is the conductor-goals-guard plugin's: this plugin's hooks never see the
  // calls its own timer causes, so a run started by the scheduler is invisible here.

  on('agent.offer', { agent: RUNNER_AGENT }, () => ({ isOffered: false }))

  // A run's agent ending its work: finish the run now instead of at the next tick
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId && (await getRuns($))[e.agentId]) {
      $.clock.after(2_000, () => {
        void reconcile($).then((ended) => {
          if (ended) void refresh($)
        })
      })
    }
    return result
  }).catch(passOn)

  // Commands

  on('command.run', { command: 'goals' }, async ($) => {
    await safeStart($, false)
    const s = await refresh($)
    await $.ui.open({ id: PANE, title: 'Goals' })
    return { text: s.reachable ? 'Goals pane opened.' : `Goals pane opened, but Conductor isn't reachable (${s.error ?? 'no answer'}).` }
  }).catch(failedCommand)

  on('command.run', { command: 'goal-run' }, async ($, e) => ({ text: await goalCommand($, 'goal-run', e.args) })).catch(failedCommand)
  on('command.run', { command: 'goal-pause' }, async ($, e) => ({ text: await goalCommand($, 'goal-pause', e.args) })).catch(failedCommand)
  on('command.run', { command: 'goal-resume' }, async ($, e) => ({ text: await goalCommand($, 'goal-resume', e.args) })).catch(failedCommand)
  on('command.run', { command: 'goal-new' }, async ($, e) => ({ text: await newGoal($, e.args) })).catch(failedCommand)
  on('command.run', { command: 'goal-schedule' }, async ($, e) => ({ text: await scheduleCommand($, e.args) })).catch(failedCommand)
  on('command.run', { command: 'todo' }, async ($, e) => ({ text: await todoCommand($, e.args) })).catch(failedCommand)

  // Tools Claude can call (the names match TOOLS in tools.ts)

  on('tool.call', { tool: 'mcp__conductor-goals__goals_status' }, ($, e) => answerTool($, 'goals_status', e)).catch(failedTool)
  on('tool.call', { tool: 'mcp__conductor-goals__goal_detail' }, ($, e) => answerTool($, 'goal_detail', e)).catch(failedTool)
  on('tool.call', { tool: 'mcp__conductor-goals__approve_item' }, ($, e) => answerTool($, 'approve_item', e)).catch(failedTool)
  on('tool.call', { tool: 'mcp__conductor-goals__reject_item' }, ($, e) => answerTool($, 'reject_item', e)).catch(failedTool)
  on('tool.call', { tool: 'mcp__conductor-goals__run_goal' }, ($, e) => answerTool($, 'run_goal', e)).catch(failedTool)
  on('tool.call', { tool: 'mcp__conductor-goals__set_schedule' }, ($, e) => answerTool($, 'set_schedule', e)).catch(failedTool)
  on('tool.call', { tool: 'mcp__conductor-goals__todos' }, ($, e) => answerTool($, 'todos', e)).catch(failedTool)
  on('tool.call', { tool: 'mcp__conductor-goals__add_todo' }, ($, e) => answerTool($, 'add_todo', e)).catch(failedTool)
  on('tool.call', { tool: 'mcp__conductor-goals__complete_todo' }, ($, e) => answerTool($, 'complete_todo', e)).catch(failedTool)

  // A goal run in this conversation itself (the old channel path): get_goal_brief
  // with a run_id starts it, end_run ends it. Runs in subagents are the runner's.

  on('tool.call', { tool: 'mcp__conductor__get_goal_brief' }, async ($, e, next) => {
    const result = await next(e)
    const { goalId, runId } = runIds(e)
    if (!e.agentId && goalId && runId && result.deny === undefined && result.isError !== true) {
      const current = await getActiveRun($)
      if (current?.runId !== runId) await setActiveRun($, { goalId, runId, startedAt: await $.clock.now() })
    }
    return result
  }).catch(passOn)

  on('tool.call', { tool: 'mcp__conductor__end_run' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined && result.isError !== true) {
      if (!e.agentId) await setActiveRun($, null)
      void refresh($)
    }
    return result
  }).catch(passOn)

  // Drawing

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => renderPane($, e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const run = await getActiveRun($)
    const background = Object.values(await getRuns($))
    if ((!run && background.length === 0) || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    if (run) {
      const s = await getSnapshot($)
      const name = s.goals.find((g) => g.id === run.goalId)?.name ?? run.goalId
      return (
        <Box>
          <Text color="cyan">● Running goal {name}</Text>
          <Text dimColor> · run {run.runId} · started {ago(new Date(run.startedAt).toISOString(), now)}</Text>
        </Box>
      )
    }
    const first = background[0]!
    const more = background.length > 1 ? ` and ${background.length - 1} more` : ''
    return (
      <Box>
        <Text color="cyan">● Goal run: {first.name}{more}</Text>
        <Text dimColor> · in the background · started {ago(new Date(first.startedAt).toISOString(), now)} · /goals</Text>
      </Box>
    )
  })
}
