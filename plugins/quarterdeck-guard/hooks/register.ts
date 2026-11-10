/**
 * Guards the goal runs the quarterdeck-goals plugin starts in background
 * subagents. It is a plugin of its own because the engine never shows a plugin
 * the calls its own timers and buttons cause: quarterdeck-goals starts most runs
 * from its scheduler timer, so its own hooks would never see what those runs do.
 *
 * - A run's agent is known by the engine's own record of who spawned it
 *   (`spawnedBy: quarterdeck-goals`, which a model can't fake) and the run id in
 *   its description.
 * - Every Quarterdeck call a run makes is tagged with its run (`run_scope`), so
 *   it acts on that run's goal and never switches the conversation's open plan.
 * - A run may use the goal tools. The person's Quarterdeck actions (approve,
 *   reject, cancel, pause...) and the plugin's tools are refused to it. Any
 *   other tool goes through the goal's guard (tool_map + autonomy): "off" and
 *   unapproved "propose" categories are refused with the reason, "auto" and
 *   approved ones are allowed, and tools outside the map follow the session's
 *   own permission rules.
 * - A run's report is its end_run summary, shown in the Goals pane; it is kept
 *   out of the person's conversation.
 * - The person's Quarterdeck actions are also refused to the model and to other
 *   agents; quarterdeck-goals' own calls (from the pane) are allowed.
 */
import type { EngineInterface, Register } from 'claude-code'

type $ = EngineInterface

const RUNNER_PLUGIN = 'quarterdeck-goals'
/** "Goal: <name> (<run id>)", the description quarterdeck-goals starts every run's agent with. */
const RUN_DESCRIPTION = /^Goal: .* \((run_[A-Za-z0-9]+)\)$/

/** Quarterdeck actions that are the person's (or the runner plugin's own bookkeeping). */
const HUMAN_ONLY = new Set([
  'mcp__quarterdeck__goals_tick',
  'mcp__quarterdeck__decide_item',
  'mcp__quarterdeck__cancel_run',
  'mcp__quarterdeck__set_goal_status',
  'mcp__quarterdeck__attach_agent',
  'mcp__quarterdeck__fail_run',
  'mcp__quarterdeck__guard_check',
  'mcp__quarterdeck__create_goal',
  'mcp__quarterdeck__delete_goal',
  'mcp__quarterdeck__delete_memory',
  'mcp__quarterdeck__set_schedule',
  'mcp__quarterdeck__update_goal',
  'mcp__quarterdeck__report_run_end',
])
const HUMAN_ONLY_REASON = "This Quarterdeck action is the person's: they take it from the Goals pane (/goals)."

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
/** The person-only tools this plugin itself calls, inside a run's loop. */
const OWN_CALLS = new Set(['mcp__quarterdeck__guard_check', 'mcp__quarterdeck__report_run_end'])

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
    const r = await $.tool.call({ tool: 'mcp__quarterdeck__guard_check', run_id: runId, tool_name: tool } as never)
    if (r.deny !== undefined) throw new Error(r.deny)
    const text = resultText(r)
    if (r.isError === true || text.startsWith('Error:')) throw new Error(text)
    return JSON.parse(text) as Verdict
  } finally {
    guardCallsInFlight--
  }
}

/** A final message that may mean the run was stopped (Quarterdeck decides which, in report_run_end). */
const STOPPED = /limit|rate|quota|credits|overloaded|api error/i

async function reportRunEnd($: $, runId: string, answer: string, reason: string, usage?: unknown): Promise<void> {
  guardCallsInFlight++
  try {
    await $.tool.call({ tool: 'mcp__quarterdeck__report_run_end', run_id: runId, answer, reason, ...(usage ? { usage } : {}) } as never)
  } finally {
    guardCallsInFlight--
  }
}

/**
 * Quarterdeck tools with an effect outside the computer: a run may use them only
 * as the goal's guard allows (its tool rules map them to an action category).
 */
const GUARDED_QUARTERDECK = new Set(['mcp__quarterdeck__unsubscribe_one_click'])

/** Fixed rules for a run's agent; null when the goal's guard or the session decides. */
function fixedVerdict(tool: string) {
  if (GUARDED_QUARTERDECK.has(tool)) return null
  if (HUMAN_ONLY.has(tool) || tool === 'mcp__quarterdeck__run_goal' || tool.startsWith('mcp__quarterdeck-goals__')) return deny(HUMAN_ONLY_REASON)
  if (tool === 'Agent') return deny('Goal runs work on their own; they do not start other agents.')
  if (tool.startsWith('mcp__quarterdeck__') || (tool as string) === 'SubagentHandback') return allow
  return null
}

/** The runner plugin's own work: its Quarterdeck calls, starting and stopping runs. */
function isRunnerTool(tool: string): boolean {
  return tool.startsWith('mcp__quarterdeck__') || tool === 'Agent' || tool === 'TaskStop'
}

// ── Reports ───────────────────────────────────────────────────────────────────

/** Each run agent's last answer, to recognise it when it is handed back to the conversation. */
const lastAnswers = new Map<string, string>()
/** The last few agent turn ends (diagnostic, shown by the status tool). */
const lastTurns: unknown[] = []
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
  // Present means goal runs are guarded; quarterdeck-goals checks for it before starting any.
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.tool.register({
      name: 'status',
      description: 'Whether Quarterdeck goal runs in this session are guarded (read-only).',
      inputSchema: { type: 'object', properties: {} },
    }).catch(() => {})
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__quarterdeck-guard__status' }, () => ({
    result: JSON.stringify({ guarded: true, runs: runIds.size, lastTurns }),
  })).catch(() => ({ result: JSON.stringify({ guarded: true }) }))

  // Permission
  on('tool.check', async ($, e, next) => {
    // This plugin's own guard check, in whichever loop the engine places it
    if (OWN_CALLS.has(e.tool) && guardCallsInFlight > 0 && next.origin?.plugin === $.plugin.name) return allow
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

  // A run's calls: Quarterdeck calls carry the run, the report stays with
  // Quarterdeck, and every other tool goes through the goal's guard first.
  on('tool.call', async ($, e, next) => {
    const runId = await runIdFor($, e.agentId)
    if (!runId) return next(e)
    if ((e.tool as string) === 'SubagentHandback') return { result: { success: true, message: 'Report saved by Quarterdeck (end_run).' } } as never
    if (e.tool.startsWith('mcp__quarterdeck__') && !GUARDED_QUARTERDECK.has(e.tool)) return next({ ...e, run_scope: runId } as typeof e)
    if (fixedVerdict(e.tool) === null) {
      const verdict = await guardCheck($, runId, e.tool)
      if (verdict.decision === 'deny') return { deny: verdict.reason ?? "Not allowed by the goal's autonomy." }
      if (verdict.category) approvedCalls.add(e.tool_use_id)
    }
    return e.tool.startsWith('mcp__quarterdeck__') ? next({ ...e, run_scope: runId } as typeof e) : next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const runId = await runIdFor($, e.agentId)
    // A diagnostic for the status tool: what the last few agent turn ends carried
    if (e.agentId) {
      lastTurns.push({ agentId: e.agentId, runId: runId ?? null, reason: e.reason, usage: e.usage ?? null, resultUsage: (r as { usage?: unknown }).usage ?? null })
      lastTurns.splice(0, Math.max(0, lastTurns.length - 4))
    }
    if (e.agentId && runId) {
      lastAnswers.set(e.agentId, e.answer)
      // Every turn's end goes to Quarterdeck: its tokens count toward the run, and a stop by
      // the usage limit or an error skips (and holds runs) or fails it with the reason
      if (e.usage || e.reason === 'error' || STOPPED.test(e.answer)) await reportRunEnd($, runId, e.answer, e.reason, e.usage).catch(() => {})
    }
    return r
  }).catch(($, e, next) => next(e))

  on('session.send', async ($, e, next) => {
    if (e.agentId && (await runIdFor($, e.agentId))) {
      return { isDelivered: false as const, reason: 'Goal runs report through end_run; Quarterdeck shows the summary in the Goals pane.' }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.receive', async ($, e, next) => {
    if (e.agentId === undefined && isRunReport(e.text)) return { consumed: 'a Quarterdeck goal run report (its summary is in the Goals pane)' }
    return next(e)
  }).catch(($, e, next) => next(e))
}
