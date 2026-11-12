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
 *   unapproved "propose" categories are refused with the reason. Everything
 *   else ("auto", approved, or outside the map) follows the session's own
 *   permission rules: this plugin refuses, it never allows.
 * - A run's report is its end_run summary, shown in the Goals pane; it is kept
 *   out of the person's conversation.
 * - The person's Quarterdeck actions are also refused to the model and to other
 *   agents; quarterdeck-goals' own calls (from the pane) are allowed.
 */
import type { EngineInterface, Register } from 'claude-code'

type Engine = EngineInterface

const RUNNER_PLUGIN = 'quarterdeck-goals'
/** "Goal: <name> (<run id>)", the description quarterdeck-goals starts every run's agent with. */
const RUN_DESCRIPTION = /^Goal: .* \((run_[A-Za-z0-9]+)\)$/

/**
 * The quarterdeck server's tool prefixes: provided by the quarterdeck-goals
 * plugin (Claude Code names plugin servers' tools this way), or added by hand
 * with `claude mcp add` (older installs). Every rule here works with either.
 */
export const SERVER_PREFIXES = ['mcp__plugin_quarterdeck-goals_quarterdeck__', 'mcp__quarterdeck__'] as const

/** A quarterdeck server tool's own name (`decide_item`), or null for any other tool. */
export function serverTool(tool: string): string | null {
  const prefix = SERVER_PREFIXES.find((p) => tool.startsWith(p))
  return prefix ? tool.slice(prefix.length) : null
}

/** Quarterdeck actions that are the person's (or the runner plugin's own bookkeeping). */
const HUMAN_ONLY = new Set([
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
])
const isHumanOnly = (tool: string) => HUMAN_ONLY.has(serverTool(tool) ?? '')
const HUMAN_ONLY_REASON = "This Quarterdeck action is the person's: they take it from the Goals pane (/goals)."


// ── Which subagents are runs ──────────────────────────────────────────────────

/** Run ids by subagent id, and subagents known not to be runs. Rebuilt from $.agent.list() after a reload. */
const runIds = new Map<string, string>()
const otherAgents = new Set<string>()

async function runIdFor($: Engine, agentId: string | undefined): Promise<string | null> {
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

/**
 * This plugin's own guard_check calls under way. guard_check is the person's
 * tool to everyone else, so the permission check lets it through only for this
 * plugin's own call while one is in flight.
 */
let guardCallsInFlight = 0
/** The person-only tools this plugin itself calls, inside a run's loop. */
const OWN_CALLS = new Set(['guard_check', 'report_run_end', 'run_progress'])

type Verdict = { decision: 'allow' | 'deny'; category?: string; reason?: string }

/** The text a tool answered with, whether core or a hook answered. */
function resultText(r: { text?: string; result?: unknown }): string {
  if (typeof r.text === 'string') return r.text
  if (typeof r.result === 'string') return r.result
  if (Array.isArray(r.result)) return r.result.map((b) => (typeof b === 'object' && b && 'text' in b ? String((b as { text: unknown }).text) : '')).join('')
  return JSON.stringify(r.result ?? null)
}

/** The prefix the session's quarterdeck server answered under last (a cache: callServer tries both). */
let serverPrefix: string | null = null
const NO_SUCH_TOOL = /no tool named "mcp__|no such tool available: mcp__|no implementation for tool.call/i

/** Calls a quarterdeck server tool under whichever prefix the session has. */
async function callServer($: Engine, name: string, input: Record<string, unknown>): Promise<Awaited<ReturnType<Engine['tool']['call']>>> {
  const order = serverPrefix ? [serverPrefix, ...SERVER_PREFIXES.filter((p) => p !== serverPrefix)] : [...SERVER_PREFIXES]
  let missing: unknown
  for (const prefix of order) {
    try {
      const r = await $.tool.call({ tool: prefix + name, ...input } as never)
      if (NO_SUCH_TOOL.test(resultText(r))) {
        missing = new Error(resultText(r))
        continue
      }
      serverPrefix = prefix
      return r
    } catch (err) {
      if (!NO_SUCH_TOOL.test(err instanceof Error ? err.message : String(err))) throw err
      missing = err
    }
  }
  throw missing
}

async function guardCheck($: Engine, runId: string, tool: string): Promise<Verdict> {
  guardCallsInFlight++
  try {
    const r = await callServer($, 'guard_check', { run_id: runId, tool_name: tool })
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

async function reportRunEnd($: Engine, runId: string, answer: string, reason: string, usage?: unknown): Promise<void> {
  guardCallsInFlight++
  try {
    await callServer($, 'report_run_end', { run_id: runId, answer, reason, ...(usage ? { usage } : {}) })
  } finally {
    guardCallsInFlight--
  }
}

// ── What a run is doing ───────────────────────────────────────────────────────

const LABEL_DETAIL = 80
const firstLine = (v: unknown) => (typeof v === 'string' ? v.trim().split(/\r?\n/)[0]!.replace(/\s+/g, ' ') : '')
const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * A tool call as the Goals pane shows it: `Bash: npm test`, `Edit: src/a.ts`,
 * `Gmail search_threads`. Only the start of a command, path, address or query.
 */
export function toolLabel(tool: string, input: unknown): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp) {
    const server = mcp[1]!.replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '').replace(/_/g, ' ')
    return `${server} ${mcp[2]}`
  }
  const i = (input ?? {}) as Record<string, unknown>
  const detail = firstLine(i.command) || firstLine(i.file_path) || firstLine(i.notebook_path) || firstLine(i.url) || firstLine(i.query) || firstLine(i.pattern)
  return detail ? `${tool}: ${clipText(detail, LABEL_DETAIL)}` : tool
}

/** Progress reports, one at a time and in order; only a call's last one is waited for. */
let progressQueue: Promise<unknown> = Promise.resolve()

function reportProgress($: Engine, runId: string, event: 'tool' | 'waiting' | 'settled', label: string): Promise<unknown> {
  return progressQueue = progressQueue.then(async () => {
    guardCallsInFlight++
    try {
      await callServer($, 'run_progress', { run_id: runId, event, label })
    } finally {
      guardCallsInFlight--
    }
  }).catch(() => {})
}

/**
 * Quarterdeck tools with an effect outside the computer: a run may use them only
 * as the goal's guard allows (its tool rules map them to an action category).
 */
const GUARDED_QUARTERDECK = new Set(['unsubscribe_one_click'])
const isGuardedQuarterdeck = (tool: string) => GUARDED_QUARTERDECK.has(serverTool(tool) ?? '')

/**
 * Fixed rules for a run's agent: the reason a tool is refused, 'own' for
 * Quarterdeck's own tools (no guard check), or null when the goal's guard decides.
 */
function fixedVerdict(tool: string): string | null {
  if (isGuardedQuarterdeck(tool)) return null
  if (isHumanOnly(tool) || serverTool(tool) === 'run_goal' || tool.startsWith('mcp__quarterdeck-goals__')) return HUMAN_ONLY_REASON
  if (tool === 'Agent') return 'Goal runs work on their own; they do not start other agents.'
  if (serverTool(tool) !== null || (tool as string) === 'SubagentHandback') return 'own'
  return null
}

/** The runner plugin's own work: its Quarterdeck calls, starting and stopping runs. */
function isRunnerTool(tool: string): boolean {
  return serverTool(tool) !== null || tool === 'Agent' || tool === 'TaskStop'
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

  // Permission. This hook only ever refuses or passes the check on: whether a
  // tool may run is the person's own permission rules' to say, never this plugin's.
  on('tool.check', async ($, e, next) => {
    // This plugin's own guard check, in whichever loop the engine places it
    if (OWN_CALLS.has(serverTool(e.tool) ?? '') && guardCallsInFlight > 0 && next.origin?.plugin === $.plugin.name) return next(e)
    const runId = await runIdFor($, e.agentId)
    if (runId) {
      const fixed = fixedVerdict(e.tool)
      if (fixed !== null && fixed !== 'own') return { decision: 'deny', reason: fixed }
      return next(e)
    }
    const fromRunner = e.agentId === undefined && next.origin?.plugin === RUNNER_PLUGIN
    if (fromRunner && isRunnerTool(e.tool)) return next(e)
    if (isHumanOnly(e.tool)) return { decision: 'deny', reason: HUMAN_ONLY_REASON }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A run's calls: Quarterdeck calls carry the run, the report stays with
  // Quarterdeck, and every other tool goes through the goal's guard first.
  on('tool.call', async ($, e, next) => {
    const runId = await runIdFor($, e.agentId)
    if (!runId) return next(e)
    if ((e.tool as string) === 'SubagentHandback') return { result: { success: true, message: 'Report saved by Quarterdeck (end_run).' } } as never
    // A call that already carries its run goes on untouched: auto mode reviews a call
    // before this hook, and refuses one whose input changes after its review
    const scoped = (e as { run_scope?: unknown }).run_scope === runId
    if (serverTool(e.tool) !== null && !isGuardedQuarterdeck(e.tool)) return scoped ? next(e) : next({ ...e, run_scope: runId } as typeof e)
    if (fixedVerdict(e.tool) === null) {
      const verdict = await guardCheck($, runId, e.tool)
      if (verdict.decision === 'deny') return { deny: verdict.reason ?? "Not allowed by the goal's autonomy." }
    }
    // The pane's "Now:" line: the call starts, and once it has run or been refused,
    // any permission wait on it is over (classic.PermissionRequest below marks one)
    const label = toolLabel(e.tool, e)
    void reportProgress($, runId, 'tool', label)
    try {
      return await (serverTool(e.tool) !== null && !scoped ? next({ ...e, run_scope: runId } as typeof e) : next(e))
    } finally {
      await reportProgress($, runId, 'settled', label)
    }
  }).catch(($, e, next) => next(e))

  // A run's call is about to be put to the person (a permission prompt in the
  // window, the Claude app or claude.ai/code): the pane says the run waits on them.
  // The decision stays the person's: the hook always passes the request on as it came
  // (the directory checks for `return next(e)`). If a settings hook answers it instead,
  // the wait clears as soon as the call settles.
  on('classic.PermissionRequest', async ($, e, next) => {
    const runId = await runIdFor($, e.agent_id)
    if (runId) void reportProgress($, runId, 'waiting', toolLabel(e.tool_name, e.tool_input))
    return next(e)
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
