/**
 * Guards the goal runs the conductor-goals plugin starts in background
 * subagents. It is a plugin of its own because the engine never shows a plugin
 * the calls its own timers and buttons cause: conductor-goals starts most runs
 * from its scheduler timer, so its own hooks would never see what those runs do.
 *
 * - A run's agent is known by the engine's own record of who spawned it
 *   (`spawnedBy: conductor-goals`, which a model can't fake) and the run id in
 *   its description.
 * - Every Conductor call a run makes is tagged with its run (`run_scope`), so
 *   it acts on that run's goal and never switches the conversation's open plan.
 * - A run may use the goal tools. The person's Conductor actions (approve,
 *   reject, cancel, pause...) and the plugin's tools are refused to it. Any
 *   other tool goes through the goal's guard (tool_map + autonomy): "off" and
 *   unapproved "propose" categories are refused with the reason, "auto" and
 *   approved ones are allowed, and tools outside the map follow the session's
 *   own permission rules.
 * - A run's report is its end_run summary, shown in the Goals pane; it is kept
 *   out of the person's conversation.
 * - The person's Conductor actions are also refused to the model and to other
 *   agents; conductor-goals' own calls (from the pane) are allowed.
 */
import type { EngineInterface, Register } from 'claude-code'

type $ = EngineInterface

const RUNNER_PLUGIN = 'conductor-goals'
/** "Goal: <name> (<run id>)", the description conductor-goals starts every run's agent with. */
const RUN_DESCRIPTION = /^Goal: .* \((run_[A-Za-z0-9]+)\)$/

/** Conductor actions that are the person's (or the runner plugin's own bookkeeping). */
const HUMAN_ONLY = new Set([
  'mcp__conductor__goals_tick',
  'mcp__conductor__decide_item',
  'mcp__conductor__cancel_run',
  'mcp__conductor__set_goal_status',
  'mcp__conductor__attach_agent',
  'mcp__conductor__fail_run',
  'mcp__conductor__guard_check',
  'mcp__conductor__create_goal',
  'mcp__conductor__delete_memory',
])
const HUMAN_ONLY_REASON = "This Conductor action is the person's: they take it from the Goals pane (/goals)."

const allow = { decision: 'allow' as const }
const deny = (reason: string) => ({ decision: 'deny' as const, reason })

// ── Which subagents are runs ──────────────────────────────────────────────────

/** Run ids by subagent id, and subagents known not to be runs. Rebuilt from $.agent.list() after a reload. */
const runIds = new Map<string, string>()
const otherAgents = new Set<string>()

async function runIdFor($: $, agentId: string | undefined): Promise<string | null> {
  if (!agentId || otherAgents.has(agentId)) return null
  const known = runIds.get(agentId)
  if (known) return known
  const agent = (await $.agent.list()).find((a) => a.id === agentId)
  if (!agent) return null // not listed yet: ask again next call
  const runId = agent.spawnedBy === RUNNER_PLUGIN ? RUN_DESCRIPTION.exec(agent.description)?.[1] : undefined
  if (!runId) {
    otherAgents.add(agentId)
    return null
  }
  runIds.set(agentId, runId)
  return runId
}

// ── The goal's guard ──────────────────────────────────────────────────────────

/** Calls the goal's guard allowed ("auto" or an approved category), by tool_use_id, for the permission check. */
const approvedCalls = new Set<string>()
/**
 * This plugin's own guard_check calls under way. guard_check is the person's
 * tool to everyone else, so the permission check lets it through only for this
 * plugin's own call while one is in flight.
 */
let guardCallsInFlight = 0

type Verdict = { decision: 'allow' | 'deny'; category?: string; reason?: string }

/** The text a tool answered with, whether core or a hook answered. */
function resultText(r: { text?: string; result?: unknown }): string {
  if (typeof r.text === 'string') return r.text
  if (typeof r.result === 'string') return r.result
  if (Array.isArray(r.result)) return r.result.map((b) => (typeof b === 'object' && b && 'text' in b ? String((b as { text: unknown }).text) : '')).join('')
  return JSON.stringify(r.result ?? null)
}

async function guardCheck($: $, runId: string, tool: string): Promise<Verdict> {
  guardCallsInFlight++
  try {
    const r = await $.tool.call({ tool: 'mcp__conductor__guard_check', run_id: runId, tool_name: tool } as never)
    if (r.deny !== undefined) throw new Error(r.deny)
    const text = resultText(r)
    if (r.isError === true || text.startsWith('Error:')) throw new Error(text)
    return JSON.parse(text) as Verdict
  } finally {
    guardCallsInFlight--
  }
}

/** Fixed rules for a run's agent; null when the goal's guard or the session decides. */
function fixedVerdict(tool: string) {
  if (HUMAN_ONLY.has(tool) || tool === 'mcp__conductor__run_goal' || tool.startsWith('mcp__conductor-goals__')) return deny(HUMAN_ONLY_REASON)
  if (tool === 'Agent') return deny('Goal runs work on their own; they do not start other agents.')
  if (tool.startsWith('mcp__conductor__') || (tool as string) === 'SubagentHandback') return allow
  return null
}

/** The runner plugin's own work: its Conductor calls, starting and stopping runs. */
function isRunnerTool(tool: string): boolean {
  return tool.startsWith('mcp__conductor__') || tool === 'Agent' || tool === 'TaskStop'
}

// ── Reports ───────────────────────────────────────────────────────────────────

/** Each run agent's last answer, to recognise it when it is handed back to the conversation. */
const lastAnswers = new Map<string, string>()
const HAND_BACK_FROM = /<agent-message from="([^"]+)">/

function isRunReport(text: string): boolean {
  const from = HAND_BACK_FROM.exec(text)?.[1]
  if (from && runIds.has(from)) return true
  const body = text.trim()
  if (!body) return false
  for (const answer of lastAnswers.values()) {
    const a = answer.trim()
    if (a && (body.includes(a.slice(0, 200)) || a.includes(body.slice(0, 200)))) return true
  }
  return false
}

export const register: Register = (on) => {
  // Present means goal runs are guarded; conductor-goals checks for it before starting any.
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.tool.register({
      name: 'status',
      description: 'Whether Conductor goal runs in this session are guarded (read-only).',
      inputSchema: { type: 'object', properties: {} },
    }).catch(() => {})
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__conductor-goals-guard__status' }, () => ({
    result: JSON.stringify({ guarded: true, runs: runIds.size }),
  })).catch(() => ({ result: JSON.stringify({ guarded: true }) }))

  // Permission
  on('tool.check', async ($, e, next) => {
    // This plugin's own guard check, in whichever loop the engine places it
    if (e.tool === 'mcp__conductor__guard_check' && guardCallsInFlight > 0 && next.origin?.plugin === $.plugin.name) return allow
    const runId = await runIdFor($, e.agentId)
    if (runId) {
      const fixed = fixedVerdict(e.tool)
      if (fixed) return fixed
      if (e.tool_use_id && approvedCalls.delete(e.tool_use_id)) return allow
      return next(e)
    }
    const fromRunner = e.agentId === undefined && next.origin?.plugin === RUNNER_PLUGIN
    if (fromRunner && isRunnerTool(e.tool)) return allow
    if (HUMAN_ONLY.has(e.tool)) return deny(HUMAN_ONLY_REASON)
    return next(e)
  }).catch(($, e, next) => next(e))

  // A run's calls: Conductor calls carry the run, the report stays with
  // Conductor, and every other tool goes through the goal's guard first.
  on('tool.call', async ($, e, next) => {
    const runId = await runIdFor($, e.agentId)
    if (!runId) return next(e)
    if ((e.tool as string) === 'SubagentHandback') return { result: { success: true, message: 'Report saved by Conductor (end_run).' } } as never
    if (e.tool.startsWith('mcp__conductor__')) return next({ ...e, run_scope: runId } as typeof e)
    if (fixedVerdict(e.tool) === null) {
      const verdict = await guardCheck($, runId, e.tool)
      if (verdict.decision === 'deny') return { deny: verdict.reason ?? "Not allowed by the goal's autonomy." }
      if (verdict.category) approvedCalls.add(e.tool_use_id)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId && (await runIdFor($, e.agentId))) lastAnswers.set(e.agentId, e.answer)
    return r
  }).catch(($, e, next) => next(e))

  on('session.send', async ($, e, next) => {
    if (e.agentId && (await runIdFor($, e.agentId))) {
      return { isDelivered: false as const, reason: 'Goal runs report through end_run; Conductor shows the summary in the Goals pane.' }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.receive', async ($, e, next) => {
    if (e.agentId === undefined && isRunReport(e.text)) return { consumed: 'a Conductor goal run report (its summary is in the Goals pane)' }
    return next(e)
  }).catch(($, e, next) => next(e))
}
