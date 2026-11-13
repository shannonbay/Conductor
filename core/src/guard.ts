/**
 * Goal guard: decides whether a tool call made during a goal run is allowed,
 * by mapping the tool to an action category (goal.tool_map) and applying the
 * goal's autonomy. Called through the MCP tool guard_check by the
 * quarterdeck-guard plugin, which knows which subagent does which run.
 *
 *   off     → denied
 *   auto    → allowed
 *   propose → allowed while an approved proposal for that category is being
 *             carried out: as many calls as the action needs (trashing a
 *             sender's 40 threads, the clicks of an unsubscribe page), until
 *             the run marks the item done. Every call is still recorded.
 *
 * Calls outside goal runs, or to tools not in the map, are always allowed.
 *
 * Untrusted content: a tool that reads mail, a web page or the like (the
 * built-in list below, or one the goal maps to the reserved category
 * `untrusted`) marks the run, and from then on its `auto` categories act as
 * `propose`, so text written to steer the agent can't take an action nobody
 * approved. Reading more stays allowed, and an approved proposal still goes
 * through. The guard sees tool names, not input: `Bash` running curl, or `Read`
 * of a downloaded file, marks nothing unless the goal maps it to `untrusted`.
 *
 * Quarterdeck's own data: a run may not touch Quarterdeck's folder
 * (`~/.quarterdeck`, or `~/.conductor` from before the rename) or its database,
 * wherever `QUARTERDECK_DB` puts it, whatever the goal's tool rules say. Writing
 * the database directly would let a run approve its own proposals or change its
 * own autonomy, and the runner folder holds what the standing session starts.
 * For this one rule the guard looks at a call's input: a shell command that
 * names the folder, the database file or the variables that point to it, and a
 * file tool's path inside the folder. Matching names can be got around (a
 * script written to another file, a path spelled another way); a sandbox for
 * goal runs is what closes that.
 *
 * "allow" means only that Quarterdeck doesn't object: the plugin passes such a
 * call on to Claude Code's own permission rules, which decide it. It never
 * answers allow itself.
 */
import { homedir } from 'os'
import { join, posix } from 'path'
import type { Database } from './sqlite.js'
import { defaultDbPath } from './paths.js'
import { autonomyFor } from './goal-engine.js'
import { getGoal, getRun, markRunUntrusted, newId } from './goals.js'
import type { Goal, GoalRun, ToolCallRecord } from './types.js'

export type GuardDecision =
  | { decision: 'allow'; category?: string; run_id?: string }
  | { decision: 'deny'; category: string; run_id: string; reason: string }

/** The quarterdeck MCP server's tool prefix when it is set up by hand (`claude mcp add`). */
export const QUARTERDECK_TOOL_PREFIX = 'mcp__quarterdeck__'
/** Its prefix when the quarterdeck-goals plugin provides the server (Claude Code names plugin servers this way). */
export const PLUGIN_QUARTERDECK_TOOL_PREFIX = 'mcp__plugin_quarterdeck-goals_quarterdeck__'

/** A quarterdeck tool's name under either prefix, as `mcp__quarterdeck__<tool>`; other names unchanged. */
export function canonicalToolName(name: string): string {
  return name.startsWith(PLUGIN_QUARTERDECK_TOOL_PREFIX) ? QUARTERDECK_TOOL_PREFIX + name.slice(PLUGIN_QUARTERDECK_TOOL_PREFIX.length) : name
}

/**
 * Matches a tool name against "exact" or glob ("mcp__gmail__send*") patterns; exact patterns win.
 * Quarterdeck's own tools match under either prefix (see canonicalToolName).
 */
export function matchToolCategory(rawMap: Record<string, string>, rawName: string): string | null {
  const toolName = canonicalToolName(rawName)
  const toolMap = Object.fromEntries(Object.entries(rawMap).map(([p, c]) => [canonicalToolName(p), c]))
  if (toolMap[toolName]) return toolMap[toolName]
  const globs = Object.entries(toolMap)
    .filter(([p]) => p.includes('*'))
    .sort(([a], [b]) => b.length - a.length) // most specific first
  for (const [pattern, category] of globs) {
    const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
    if (re.test(toolName)) return category
  }
  return null
}

/** The reserved tool-rule category for a tool that reads untrusted content: never refused, it marks the run. */
export const UNTRUSTED_CATEGORY = 'untrusted'

/**
 * Tools that read untrusted content whatever the goal's tool rules say: web
 * fetches and searches, the browsers, and Gmail's readers (under either
 * spelling of the connector's or a server's name).
 */
export const BUILTIN_UNTRUSTED: readonly string[] = [
  'WebFetch', 'WebSearch',
  'mcp__claude-in-chrome__*', 'mcp__*Claude_Browser__*',
  ...['get_*', 'search_*', 'list_drafts', 'download_*'].flatMap((t) => [`mcp__*Gmail*__${t}`, `mcp__*gmail*__${t}`]),
]
const BUILTIN_UNTRUSTED_MAP = Object.fromEntries(BUILTIN_UNTRUSTED.map((p) => [p, UNTRUSTED_CATEGORY]))

/** Whether a tool reads untrusted content: the built-in list, or the goal maps it to `untrusted`. */
export function readsUntrusted(toolMap: Goal['tool_map'], toolName: string): boolean {
  return matchToolCategory(toolMap, toolName) === UNTRUSTED_CATEGORY || matchToolCategory(BUILTIN_UNTRUSTED_MAP, toolName) !== null
}

/** The reserved category a refusal to touch Quarterdeck's own data is recorded under. */
export const QUARTERDECK_DATA_CATEGORY = 'quarterdeck-data'

/** Where Quarterdeck keeps its data: its folders, and the database file wherever it is. */
export interface QuarterdeckDataPaths {
  /** `~/.quarterdeck` and `~/.conductor`. */
  dirs: string[]
  /** The database file (with its `-wal` and `-shm` files) when `QUARTERDECK_DB` puts it elsewhere. */
  db: string | null
}

export function quarterdeckDataPaths(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): QuarterdeckDataPaths {
  const db = defaultDbPath(env, home)
  const dirs = [join(home, '.quarterdeck'), join(home, '.conductor')]
  const inDirs = dirs.some((d) => isInside(normPath(db), normPath(d)))
  return { dirs, db: db === ':memory:' || inDirs ? null : db }
}

/** A path compared case- and slash-insensitively, as the to-do lists compare folders. */
const normPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const isInside = (path: string, dir: string) => path === dir || path.startsWith(dir + '/')
/** `path` against `base`, with either slash and a drive letter or not, the same on every platform. */
function resolvePath(base: string, path: string): string {
  const p = path.replace(/\\/g, '/')
  return posix.normalize(/^([a-z]:)?\//i.test(p) ? p : posix.join(base.replace(/\\/g, '/'), p))
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep'])
/** A path segment naming Quarterdeck's folder (`~/.quarterdeck`, `$HOME\.conductor`, `cd .quarterdeck`). */
const DATA_DIR_SEGMENT = /(^|[\\/\s"'`=])\.(quarterdeck|conductor)(?![\w-])/i
/** The database's file name, with or without its -wal/-shm files. */
const DB_FILE_NAME = /(^|[\\/\s"'`=])tasks\.db(-wal|-shm)?(?![\w.-])/i
/** The variables that say where the database is. */
const DB_VARIABLE = /\b(QUARTERDECK|CONDUCTOR)_DB\b/i

/**
 * What a call would touch of Quarterdeck's own data, or null: a shell command
 * naming its folder, database file or the variables that point to it, or a
 * file tool's path inside the folder or at the database.
 */
export function touchesQuarterdeckData(
  toolName: string,
  input: Record<string, unknown> | undefined,
  workingDir: string,
  paths: QuarterdeckDataPaths = quarterdeckDataPaths(),
  home: string = homedir(),
): string | null {
  if (!input) return null
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  if (SHELL_TOOLS.has(toolName)) {
    const command = str('command')
    if (!command) return null
    const found = DATA_DIR_SEGMENT.exec(command) ?? DB_FILE_NAME.exec(command) ?? DB_VARIABLE.exec(command)
    if (found) return found[0].replace(/^[\\/\s"'`=]/, '')
    if (paths.db && normPath(command).includes(normPath(paths.db))) return paths.db
    return null
  }
  if (FILE_TOOLS.has(toolName)) {
    const fields = ['file_path', 'notebook_path', 'path', ...(toolName === 'Glob' ? ['pattern'] : [])]
    const base = str('path') || workingDir
    for (const field of fields) {
      const raw = str(field)
      if (!raw) continue
      const expanded = raw.replace(/^~(?=$|[\\/])/, home)
      const full = normPath(resolvePath(field === 'pattern' ? base : workingDir, expanded))
      if (paths.dirs.some((d) => isInside(full, normPath(d)))) return raw
      if (/(^|\/)tasks\.db(-wal|-shm)?$/.test(full)) return raw
      if (paths.db && [paths.db, `${paths.db}-wal`, `${paths.db}-shm`].some((f) => full === normPath(f))) return raw
      if (DATA_DIR_SEGMENT.test(raw)) return raw
    }
  }
  return null
}

function record(db: Database, run: GoalRun, toolName: string, category: string, decision: 'allow' | 'deny', reason: string | null): void {
  db.prepare(`
    INSERT INTO goal_tool_calls (id, plan_id, run_id, tool_name, category, decision, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newId('tc'), run.plan_id, run.id, toolName, category, decision, reason, new Date().toISOString())
}

/**
 * Guard for a call made by a goal run's agent, by the run's id. `input` is the
 * call's input (the plugin sends the command and path fields), for the rule on
 * Quarterdeck's own data.
 */
export function guardToolCallForRun(
  db: Database, runId: string, toolName: string,
  input?: Record<string, unknown>, paths: QuarterdeckDataPaths = quarterdeckDataPaths(),
): GuardDecision {
  const run = db.prepare("SELECT * FROM goal_runs WHERE id = ? AND status IN ('queued', 'running')").get(runId) as GoalRun | undefined
  return run ? guardRun(db, run, toolName, input, paths) : { decision: 'allow' }
}

function guardRun(db: Database, run: GoalRun, toolName: string, input: Record<string, unknown> | undefined, paths: QuarterdeckDataPaths): GuardDecision {
  const goal = getGoal(db, run.plan_id)
  if (!goal) return { decision: 'allow' }
  const workingDir = (db.prepare('SELECT working_dir FROM plans WHERE id = ?').get(run.plan_id) as { working_dir: string } | undefined)?.working_dir ?? process.cwd()
  const touched = touchesQuarterdeckData(toolName, input, workingDir, paths)
  if (touched !== null) {
    const reason = `Quarterdeck goal guard: a goal run can't read or change Quarterdeck's own data (${touched}). Use the goal tools (add_item, remember, end_run) instead, and don't try another way round.`
    record(db, run, toolName, QUARTERDECK_DATA_CATEGORY, 'deny', reason)
    return { decision: 'deny', category: QUARTERDECK_DATA_CATEGORY, run_id: run.id, reason }
  }
  if (readsUntrusted(goal.tool_map, toolName)) markRunUntrusted(db, run.id, toolName)
  const category = matchToolCategory(goal.tool_map, toolName)
  if (!category) return { decision: 'allow', run_id: run.id }
  if (category === UNTRUSTED_CATEGORY) {
    record(db, run, toolName, category, 'allow', null)
    return { decision: 'allow', category, run_id: run.id }
  }

  const mode = autonomyFor(goal, category)
  // Once the run has read untrusted content, its auto categories need approval like propose ones
  const untrusted = mode === 'auto' ? getRun(db, run.id)?.untrusted_source ?? null : null
  if (mode === 'auto' && untrusted === null) {
    record(db, run, toolName, category, 'allow', null)
    return { decision: 'allow', category, run_id: run.id }
  }
  if (mode === 'off') {
    const reason = `Quarterdeck goal guard: "${category}" is off for this goal, so ${toolName} is not allowed. Don't take or propose this action.`
    record(db, run, toolName, category, 'deny', reason)
    return { decision: 'deny', category, run_id: run.id, reason }
  }

  // propose: allowed while an approved proposal for this category is still being carried out
  // (active and not done). One action can take many calls; completing the item ends it.
  const approved = (db.prepare(`
    SELECT COUNT(*) AS n FROM tasks
    WHERE plan_id = ? AND status = 'active' AND archived_at IS NULL AND approved_at IS NOT NULL
      AND json_extract(state, '$.action.category') = ?
  `).get(run.plan_id, category) as { n: number }).n
  if (approved > 0) {
    record(db, run, toolName, category, 'allow', null)
    return { decision: 'allow', category, run_id: run.id }
  }
  const how = `Propose it with add_item (action.category "${category}") and wait until it shows approved_to_execute; once approved, carry it out and then complete the item.`
  const reason = untrusted !== null
    ? `Quarterdeck goal guard: this run has read untrusted content (${untrusted}), so "${category}" needs approval for the rest of the run, in case that content asked for it. ${how}`
    : `Quarterdeck goal guard: "${category}" needs approval first. ${how}`
  record(db, run, toolName, category, 'deny', reason)
  return { decision: 'deny', category, run_id: run.id, reason }
}

/**
 * Whether the standing session can start with a tool pattern as an allow rule
 * as it stands: a plain name, or a whole server (`mcp__<server>__*`), the
 * forms Claude Code documents. A glob inside a tool's name (`trash_*`) is left
 * to the names seen, as a rule Claude Code refuses could keep the session from
 * starting at all.
 */
export function usableAsAllowRule(pattern: string): boolean {
  return !pattern.includes('*') || /^mcp__[^*]+?__\*$/.test(pattern)
}

/**
 * The allow rules the standing session starts with besides Quarterdeck's own:
 * the tools every active goal maps to a category that isn't `off`. The guard
 * still refuses a `propose` one until its item is approved, so allowing them
 * here only stops Claude Code asking (or auto mode refusing) a second time,
 * where nobody is there to answer. A pattern Claude Code can't take
 * (`mcp__*Gmail*__trash_*`) becomes the names the guard has seen it match in
 * that goal's runs. Quarterdeck's own tools are left out (OWN_TOOL_RULES).
 */
export function standingAllowRules(db: Database): string[] {
  const rules = new Set<string>()
  const goals = db.prepare("SELECT g.plan_id FROM goals g JOIN plans p ON p.id = g.plan_id WHERE g.status = 'active'").all() as { plan_id: string }[]
  for (const { plan_id } of goals) {
    const goal = getGoal(db, plan_id)
    if (!goal) continue
    const allowed = (category: string | null) => category !== null && autonomyFor(goal, category) !== 'off'
    for (const [pattern, category] of Object.entries(goal.tool_map)) {
      if (allowed(category) && usableAsAllowRule(pattern)) rules.add(pattern)
    }
    const seen = db.prepare('SELECT DISTINCT tool_name FROM goal_tool_calls WHERE plan_id = ?').all(plan_id) as { tool_name: string }[]
    for (const { tool_name } of seen) {
      if (allowed(matchToolCategory(goal.tool_map, tool_name))) rules.add(tool_name)
    }
  }
  const own = [QUARTERDECK_TOOL_PREFIX, PLUGIN_QUARTERDECK_TOOL_PREFIX]
  return [...rules].filter((r) => !own.some((p) => r.startsWith(p))).sort()
}

export function listToolCalls(db: Database, planId: string, limit = 50): ToolCallRecord[] {
  return db.prepare('SELECT * FROM goal_tool_calls WHERE plan_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(planId, limit) as ToolCallRecord[]
}
