/**
 * `quarterdeck doctor` — checks that a Quarterdeck install is healthy and says how
 * to fix anything that isn't. Each check is independent, so one failure
 * (e.g. a broken native module) doesn't hide the others.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { realDeps, status, statusText, taskInstalled, TASK_NAME, type InstallDeps } from './runner-session.js'

export type Level = 'ok' | 'warn' | 'fail'

export interface CheckResult {
  name: string
  level: Level
  detail: string
  fix?: string
}

export interface DoctorOptions {
  repoRoot: string
  cwd: string
  home: string
  env: NodeJS.ProcessEnv
  nodeVersion: string
  fetchTimeoutMs: number
}

export function defaultOptions(): DoctorOptions {
  return {
    repoRoot: findRepoRoot(dirname(fileURLToPath(import.meta.url))),
    cwd: process.cwd(),
    home: homedir(),
    env: process.env,
    nodeVersion: process.versions.node,
    fetchTimeoutMs: 2000,
  }
}

/**
 * The Quarterdeck checkout this file runs from: mcp/src, mcp/dist, or the
 * plugin's server/ bundle. An installed plugin isn't in a checkout, so this
 * falls back to two levels up and the build checks skip themselves.
 */
function findRepoRoot(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'core', 'src')) && existsSync(join(dir, 'mcp', 'src'))) return dir
    if (dirname(dir) === dir) return resolve(from, '..', '..')
  }
}

const PLUGIN = 'quarterdeck-goals@quarterdeck'
const GUARD_PLUGIN = 'quarterdeck-guard@quarterdeck'

const ok = (name: string, detail: string): CheckResult => ({ name, level: 'ok', detail })
const warn = (name: string, detail: string, fix?: string): CheckResult => ({ name, level: 'warn', detail, fix })
const fail = (name: string, detail: string, fix?: string): CheckResult => ({ name, level: 'fail', detail, fix })

// ── Individual checks ─────────────────────────────────────────────────────────

/** node:sqlite (the built-in database Quarterdeck uses) works without a flag from Node 22.13. */
export function checkNode(o: DoctorOptions): CheckResult {
  const [major, minor] = o.nodeVersion.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 13)
    ? ok('Node.js', `v${o.nodeVersion}`)
    : fail('Node.js', `v${o.nodeVersion} is too old (Quarterdeck's built-in database, node:sqlite, needs Node 22.13+)`, 'Install Node.js 22.13 or newer.')
}

export async function checkDatabase(o: DoctorOptions): Promise<CheckResult[]> {
  let core: typeof import('@quarterdeck/core')
  try {
    core = await import('@quarterdeck/core')
  } catch (e) {
    return [fail('Database', `could not load @quarterdeck/core: ${firstLine((e as Error).message)}`, 'Run `npm install` and `npm run build --prefix core` from the repo root.')]
  }

  const path = core.defaultDbPath(o.env, o.home)
  try {
    const db = core.openDatabase(path)
    try {
      const plans = (db.prepare('SELECT COUNT(*) n FROM plans').get() as { n: number }).n
      const tasks = (db.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n
      const present = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]).map((r) => r.name))
      const missing = core.REVISION_TRIGGERS.filter((t) => !present.has(t))
      const mode = String(db.pragma('journal_mode', { simple: true }))
      const version = core.dbSchemaVersion(db)
      const results = [ok('Database', `${path} — ${plans} plans, ${tasks} tasks`)]
      if (missing.length) {
        results.push(fail('Schema', `missing triggers: ${missing.join(', ')}`, 'Rebuild core (`npm run build --prefix core`) and rerun.'))
      } else if (core.schemaOutdated(db)) {
        results.push(warn('Schema', `version ${version}, newer than this Quarterdeck (${core.SCHEMA_VERSION}): a newer version has used the database`,
          'Update the plugin (`claude plugin update quarterdeck-goals@quarterdeck`), then /reload-plugins in every open session.'))
      } else {
        results.push(ok('Schema', `up to date (version ${version})`))
      }
      if (path !== ':memory:' && mode !== 'wal') {
        results.push(warn('Journal mode', `${mode} (expected wal)`, 'Close other programs using the database and rerun.'))
      }
      return results
    } finally {
      db.close()
    }
  } catch (e) {
    return [
      fail('Database', `cannot open ${path}: ${firstLine((e as Error).message)}`, 'Check the path is writable, or set QUARTERDECK_DB to a writable file.'),
    ]
  }
}

/** Fails if a package's built entry is missing, warns if its sources are newer. */
export function checkBuild(o: DoctorOptions, pkg: 'core' | 'mcp'): CheckResult {
  const name = `${pkg}/ build`
  const srcDir = join(o.repoRoot, pkg, 'src')
  const entry = join(o.repoRoot, pkg, 'dist', 'index.js')
  if (!existsSync(srcDir)) return ok(name, 'not a Quarterdeck checkout (installed plugin) — skipped')
  if (!existsSync(entry)) return fail(name, `${pkg}/dist/index.js is missing`, `Run \`npm run build --prefix ${pkg}\`.`)
  const newestSrc = newestMtime(srcDir)
  const built = statSync(entry).mtimeMs
  return newestSrc > built + 1000
    ? warn(name, 'source files changed since the last build', `Run \`npm run build --prefix ${pkg}\`${pkg === 'mcp' ? ', then reconnect the server with /mcp' : ''}.`)
    : ok(name, 'up to date')
}

/** The bundled server the plugin starts, built from mcp/ and core/ (`npm run build`). */
export function checkBundle(o: DoctorOptions): CheckResult {
  const name = 'Plugin server bundle'
  const srcDir = join(o.repoRoot, 'mcp', 'src')
  const bundle = join(o.repoRoot, 'plugins', 'quarterdeck-goals', 'server', 'quarterdeck-mcp.mjs')
  if (!existsSync(srcDir)) return ok(name, 'not a Quarterdeck checkout (installed plugin) — skipped')
  if (!existsSync(bundle)) return fail(name, 'plugins/quarterdeck-goals/server/quarterdeck-mcp.mjs is missing, so the plugin has no server', 'Run `npm run build --prefix mcp`, then /reload-plugins.')
  const built = statSync(bundle).mtimeMs
  return Math.max(newestMtime(srcDir), newestMtime(join(o.repoRoot, 'core', 'src'))) > built + 1000
    ? warn(name, 'source files changed since the last build', 'Run `npm run build --prefix mcp`, then /reload-plugins.')
    : ok(name, 'up to date')
}

type ServerEntry = { command?: string; args?: string[]; env?: Record<string, string> }

/**
 * Where the `quarterdeck` server comes from. The quarterdeck-goals plugin
 * provides it (and updates it); one also added by hand (`claude mcp add`, or a
 * project .mcp.json) runs a second, older copy beside it.
 */
export function checkServerSetup(o: DoctorOptions): CheckResult[] {
  const name = 'quarterdeck MCP server'
  const user = (readJson(join(o.home, '.claude.json')) as { mcpServers?: Record<string, ServerEntry> }).mcpServers ?? {}
  const projectFile = [join(o.cwd, '.mcp.json'), join(o.repoRoot, '.mcp.json')].find((f) => existsSync(f))
  const project = projectFile ? (readJson(projectFile) as { mcpServers?: Record<string, ServerEntry> }).mcpServers ?? {} : {}
  const plugin = enabledPlugins(o)[PLUGIN] === true
  const byHand = [user.quarterdeck && 'added for your user', project.quarterdeck && `in ${projectFile}`].filter(Boolean) as string[]
  const results: CheckResult[] = []
  if (plugin && byHand.length) {
    const fixes = [user.quarterdeck && 'Run `claude mcp remove --scope user quarterdeck`', project.quarterdeck && `remove "quarterdeck" from ${projectFile}`].filter(Boolean)
    results.push(warn(name, `provided by the ${PLUGIN} plugin, but also set up by hand (${byHand.join('; ')}), so two copies run`,
      `${fixes.join(' and ')}, then restart Claude Code.`.replace(/^r/, 'R')))
  } else if (plugin) {
    results.push(ok(name, `provided by the ${PLUGIN} plugin`))
  } else if (byHand.length) {
    results.push(warn(name, `set up by hand (${byHand.join('; ')}), so it doesn't update`,
      'Install the quarterdeck-goals plugin (see the plugins check), then remove the hand-added server.'))
  }
  if (project['conductor-channel']) {
    results.push(warn('.mcp.json conductor-channel', 'the channel server was removed, so this entry fails to start', 'Remove "conductor-channel" from .mcp.json.'))
  }
  return results
}

/**
 * Permission rules written for the hand-added server's tool names
 * (`mcp__quarterdeck__*`) don't cover the plugin server's
 * (`mcp__plugin_quarterdeck-goals_quarterdeck__*`). Null when there are none.
 */
export function checkPermissionRules(o: DoctorOptions): CheckResult | null {
  if (enabledPlugins(o)[PLUGIN] !== true) return null
  const files = [join(o.home, '.claude', 'settings.json'), join(o.cwd, '.claude', 'settings.json'), join(o.cwd, '.claude', 'settings.local.json')]
  const stale = files.filter((f) => {
    const perms = (readJson(f) as { permissions?: Record<string, unknown> }).permissions
    return perms !== undefined && JSON.stringify(perms).includes('mcp__quarterdeck__')
  })
  if (!stale.length) return null
  return warn('Permission rules', `${stale.join(', ')} ${stale.length === 1 ? 'has' : 'have'} rules for mcp__quarterdeck__* tools, which the plugin's server names mcp__plugin_quarterdeck-goals_quarterdeck__*`,
    'Change those rules to the new prefix (or keep both).')
}

/**
 * Updates reach you when auto-update is on for the quarterdeck marketplace
 * (Claude Code leaves it off for marketplaces other than Anthropic's). Null
 * when the marketplace isn't added (checkPlugin says how).
 */
export function checkUpdates(o: DoctorOptions): CheckResult | null {
  const known = readJson(join(o.home, '.claude', 'plugins', 'known_marketplaces.json')) as Record<string, { source?: { source?: string; path?: string }; autoUpdate?: boolean }>
  const m = known.quarterdeck
  if (!m) return null
  const name = 'Updates'
  if (m.source?.source === 'directory') return ok(name, `from your local folder${m.source.path ? ` ${m.source.path}` : ''} (after changes: \`npm run build\`, then /reload-plugins)`)
  return m.autoUpdate === true
    ? ok(name, 'automatic (after one arrives, /reload-plugins or restart to use it)')
    : warn(name, 'auto-update is off for the quarterdeck marketplace, so new versions arrive only when you update by hand',
        'In Claude Code: /plugin → Marketplaces → quarterdeck → Enable auto-update. Or now: `claude plugin update quarterdeck-goals@quarterdeck`.')
}

export function checkHooks(o: DoctorOptions): CheckResult {
  const file = join(o.home, '.claude', 'settings.json')
  if (!existsSync(file)) return ok('Claude Code hooks', 'none installed (none needed)')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
    JSON.parse(text)
  } catch {
    return fail('Claude Code hooks', '~/.claude/settings.json is not valid JSON', 'Fix the JSON syntax.')
  }
  // Goals need no hooks; these are leftovers from the plan era, costing tokens every turn
  const problems = [
    text.includes('conductor-decompose') && 'the obsolete decompose hook is still installed',
    text.includes('mcp__conductor__') && 'the retired plan reminder hooks are still installed',
    text.includes('goal-guard') && 'the old goal-guard hook is still installed (the guard plugin replaced it)',
  ].filter(Boolean)
  if (problems.length) return warn('Claude Code hooks', problems.join('; '), 'Run `npm run setup-hooks --prefix mcp` to remove them.')
  return ok('Claude Code hooks', 'up to date (none needed)')
}

/** Where releases are published: the `release` branch on GitHub. */
export const MARKETPLACE_SOURCE = 'shannonbay/Quarterdeck#release'

/**
 * The Claude Code plugins that run goals: quarterdeck-goals (Goals pane, the
 * runner that starts goal runs in subagents) and quarterdeck-guard (keeps
 * each run within its goal; without it no run starts).
 */
export function checkPlugin(o: DoctorOptions): CheckResult {
  const install = (p: string) => `Run \`claude plugin marketplace add ${MARKETPLACE_SOURCE}\` then \`claude plugin install ${p} --scope user\`.`
  const enabled = enabledPlugins(o)
  const name = 'Claude Code plugins'
  if (enabled[PLUGIN] === false) return warn(name, `${PLUGIN} is installed but disabled`, `Run \`claude plugin enable ${PLUGIN}\`.`)
  if (enabled[PLUGIN] !== true) return warn(name, `${PLUGIN} not installed (it runs goals and shows the Goals pane)`, install(PLUGIN))
  if (enabled[GUARD_PLUGIN] === false) return warn(name, `${GUARD_PLUGIN} is disabled, so goal runs are paused`, `Run \`claude plugin enable ${GUARD_PLUGIN}\`.`)
  if (enabled[GUARD_PLUGIN] !== true) return warn(name, `${GUARD_PLUGIN} not installed, so goal runs are paused`, install(GUARD_PLUGIN))
  return ok(name, `${PLUGIN} and ${GUARD_PLUGIN} enabled`)
}

/**
 * Leftovers from before Quarterdeck was renamed from Conductor: the old data
 * folder, a `conductor` MCP server entry and the old plugins. Null when none.
 */
export function checkRenameLeftovers(o: DoctorOptions): CheckResult | null {
  const read = (file: string): Record<string, unknown> => {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} }
  }
  const user = read(join(o.home, '.claude.json')) as { mcpServers?: Record<string, unknown> }
  const repo = read(join(o.repoRoot, '.mcp.json')) as { mcpServers?: Record<string, unknown> }
  const enabled = (read(join(o.home, '.claude', 'settings.json')) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins ?? {}
  const found: string[] = []
  const fixes: string[] = []
  if (!o.env.QUARTERDECK_DB && !o.env.CONDUCTOR_DB && existsSync(join(o.home, '.conductor', 'tasks.db')) && !existsSync(join(o.home, '.quarterdeck', 'tasks.db'))) {
    found.push('your goals are still in ~/.conductor')
    fixes.push('with Claude Code and the web app closed, rename ~/.conductor to ~/.quarterdeck')
  }
  if (user.mcpServers?.conductor) {
    found.push('a "conductor" MCP server is still added for your user')
    fixes.push('run `claude mcp remove --scope user conductor`')
  }
  if (repo.mcpServers?.conductor) {
    found.push('.mcp.json still has a "conductor" server')
    fixes.push('remove it from .mcp.json')
  }
  const oldPlugins = ['conductor-goals@conductor', 'conductor-goals-guard@conductor'].filter((p) => p in enabled)
  if (oldPlugins.length) {
    found.push(`the old plugins are still installed (${oldPlugins.join(', ')})`)
    fixes.push(`run ${oldPlugins.map((p) => `\`claude plugin uninstall ${p}\``).join(' and ')}, then \`claude plugin marketplace remove conductor\``)
  }
  if (!found.length) return null
  const fix = fixes.join('; ')
  return warn('Renamed from Conductor', found.join('; '), fix.charAt(0).toUpperCase() + fix.slice(1) + '.')
}

export async function checkWeb(o: DoctorOptions): Promise<CheckResult> {
  const url = `http://localhost:${o.env.PORT ?? '3000'}/api/health`
  return await getJson(url, o.fetchTimeoutMs)
    ? ok('Goal pages (web)', `running at ${url.replace('/api/health', '')}`)
    : ok('Goal pages (web)', 'not running (optional: `npm run dev --prefix web` for goal pages and webhooks)')
}

/**
 * Active goals run while Claude Code is open with both goal plugins (the
 * quarterdeck-goals runner, guarded by quarterdeck-guard).
 */
export async function checkGoals(o: DoctorOptions, plugins: CheckResult): Promise<CheckResult | null> {
  let goals: { plan: { name: string } }[]
  try {
    const core = await import('@quarterdeck/core')
    const db = core.openDatabase(core.defaultDbPath(o.env, o.home))
    try { goals = core.listGoals(db, 'active') } finally { db.close() }
  } catch {
    return null // database problems are reported by checkDatabase
  }
  if (goals.length === 0) return null
  const names = goals.map((g) => g.plan.name).join(', ')
  return plugins.level === 'ok'
    ? ok('Persistent goals', `${goals.length} active (${names}); they run while Claude Code is open`)
    : warn('Persistent goals', `${goals.length} active (${names}) but they won't run: ${plugins.detail}`,
        plugins.fix ?? 'Install the quarterdeck-goals and quarterdeck-guard plugins (see the Claude Code plugins check above).')
}

/**
 * The standing session (`quarterdeck runner install`), which runs goals with no
 * Claude Code window open. Null until it has been set up.
 */
export async function checkRunner(o: DoctorOptions, deps?: InstallDeps): Promise<CheckResult | null> {
  const name = 'Standing session'
  if (!existsSync(join(o.home, '.quarterdeck', 'runner', 'launch.mjs'))) return null
  try {
    const d = deps ?? await realDeps()
    const s = status(d)
    const task = d.platform !== 'win32' || taskInstalled(d)
    if (!s.running) return warn(name, `not running${task ? ' (the scheduled task starts it within 5 minutes)' : ''}, so goals run only while a Claude Code window is open`, 'Run `quarterdeck runner start`, or `quarterdeck runner uninstall` if you no longer want it.')
    if (!task) return warn(name, `${statusText(s)} But the scheduled task "${TASK_NAME}" is missing, so nothing restarts it after a logon or an update`, 'Run `quarterdeck runner install`.')
    return ok(name, statusText(s))
  } catch (e) {
    return warn(name, `could not be checked: ${firstLine((e as Error).message)}`, 'Check that `claude agents --json` works in a terminal.')
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

export async function runDoctor(o: DoctorOptions = defaultOptions()): Promise<CheckResult[]> {
  const node = checkNode(o)
  const plugins = checkPlugin(o)
  const [db, web] = await Promise.all([checkDatabase(o), checkWeb(o)])
  return [
    node,
    ...db,
    checkBuild(o, 'core'),
    checkBuild(o, 'mcp'),
    checkBundle(o),
    ...checkServerSetup(o),
    checkHooks(o),
    plugins,
    ...[checkUpdates(o), checkPermissionRules(o), checkRenameLeftovers(o)].filter((r): r is CheckResult => r !== null),
    web,
    ...[await checkGoals(o, plugins), await checkRunner(o)].filter((r): r is CheckResult => r !== null),
  ]
}

export function formatResults(results: CheckResult[]): string {
  const tag: Record<Level, string> = { ok: '[ ok ]', warn: '[warn]', fail: '[FAIL]' }
  const lines = ['Quarterdeck doctor', '']
  for (const r of results) {
    lines.push(`${tag[r.level]} ${r.name}: ${r.detail}`)
    if (r.fix) lines.push(`       fix: ${r.fix}`)
  }
  const fails = results.filter((r) => r.level === 'fail').length
  const warns = results.filter((r) => r.level === 'warn').length
  lines.push('', fails ? `${fails} problem(s) to fix, ${warns} warning(s).` : warns ? `No problems, ${warns} warning(s).` : 'Everything looks good.')
  return lines.join('\n')
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJson(file: string): Record<string, unknown> {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} }
}

/** Plugins on or off in ~/.claude/settings.json (a missing or broken file is reported by checkHooks). */
function enabledPlugins(o: DoctorOptions): Record<string, unknown> {
  return (readJson(join(o.home, '.claude', 'settings.json')) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins ?? {}
}

function firstLine(s: string): string {
  return s.split('\n')[0]
}

function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(p))
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) newest = Math.max(newest, statSync(p).mtimeMs)
  }
  return newest
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}
