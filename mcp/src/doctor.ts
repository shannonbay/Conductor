/**
 * `quarterdeck doctor` — checks that a Quarterdeck install is healthy and says how
 * to fix anything that isn't. Each check is independent, so one failure
 * (e.g. a broken native module) doesn't hide the others.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

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
    // This file lives in mcp/src (dev) or mcp/dist (built); the repo root is two levels up.
    repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
    cwd: process.cwd(),
    home: homedir(),
    env: process.env,
    nodeVersion: process.versions.node,
    fetchTimeoutMs: 2000,
  }
}

const ok = (name: string, detail: string): CheckResult => ({ name, level: 'ok', detail })
const warn = (name: string, detail: string, fix?: string): CheckResult => ({ name, level: 'warn', detail, fix })
const fail = (name: string, detail: string, fix?: string): CheckResult => ({ name, level: 'fail', detail, fix })

// ── Individual checks ─────────────────────────────────────────────────────────

export function checkNode(o: DoctorOptions): CheckResult {
  const major = Number(o.nodeVersion.split('.')[0])
  return major >= 22
    ? ok('Node.js', `v${o.nodeVersion}`)
    : fail('Node.js', `v${o.nodeVersion} is too old (better-sqlite3 13 needs Node 22+)`, 'Install Node.js 22 or newer, then run `npm install`.')
}

/**
 * Why better-sqlite3's native part didn't load, and the fix; null when the error
 * is something else. Never built usually means npm held back its install script
 * (npm 11 asks before running install scripts).
 */
export function nativeLoadProblem(msg: string): { detail: string; fix: string } | null {
  if (/NODE_MODULE_VERSION/.test(msg)) {
    return { detail: 'better-sqlite3 was built for a different Node.js version', fix: 'Run `npm rebuild better-sqlite3` (or `npm install`) from the repo root.' }
  }
  if (/bindings file|better_sqlite3\.node|Cannot find module.*better-sqlite3|was compiled against|prebuild/i.test(msg)) {
    return {
      detail: "better-sqlite3's native part isn't built (npm may have held back its install script)",
      fix: 'From the repo root, run `npm install-scripts approve better-sqlite3` (npm 11+), then `npm rebuild better-sqlite3`.',
    }
  }
  return null
}

export async function checkDatabase(o: DoctorOptions): Promise<CheckResult[]> {
  let core: typeof import('@quarterdeck/core')
  try {
    core = await import('@quarterdeck/core')
  } catch (e) {
    const msg = (e as Error).message
    const native = nativeLoadProblem(msg)
    return [fail(
      'SQLite native module',
      native ? native.detail : `could not load @quarterdeck/core: ${firstLine(msg)}`,
      native ? native.fix : 'Run `npm install` and `npm run build --prefix core` from the repo root.',
    )]
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
      const results = [
        ok('SQLite native module', 'better-sqlite3 loads'),
        ok('Database', `${path} — ${plans} plans, ${tasks} tasks`),
      ]
      results.push(missing.length === 0
        ? ok('Schema', 'up to date (revision triggers present)')
        : fail('Schema', `missing triggers: ${missing.join(', ')}`, 'Rebuild core (`npm run build --prefix core`) and rerun.'))
      if (path !== ':memory:' && mode !== 'wal') {
        results.push(warn('Journal mode', `${mode} (expected wal)`, 'Close other programs using the database and rerun.'))
      }
      return results
    } finally {
      db.close()
    }
  } catch (e) {
    return [
      ok('SQLite native module', 'better-sqlite3 loads'),
      fail('Database', `cannot open ${path}: ${firstLine((e as Error).message)}`, 'Check the path is writable, or set QUARTERDECK_DB to a writable file.'),
    ]
  }
}

/** Fails if a package's built entry is missing, warns if its sources are newer. */
export function checkBuild(o: DoctorOptions, pkg: 'core' | 'mcp'): CheckResult {
  const name = `${pkg}/ build`
  const srcDir = join(o.repoRoot, pkg, 'src')
  const entry = join(o.repoRoot, pkg, 'dist', 'index.js')
  if (!existsSync(srcDir)) return warn(name, 'not running from a Quarterdeck checkout — skipped')
  if (!existsSync(entry)) return fail(name, `${pkg}/dist/index.js is missing`, `Run \`npm run build --prefix ${pkg}\`.`)
  const newestSrc = newestMtime(srcDir)
  const built = statSync(entry).mtimeMs
  return newestSrc > built + 1000
    ? warn(name, 'source files changed since the last build', `Run \`npm run build --prefix ${pkg}\`${pkg === 'mcp' ? ', then reconnect the server with /mcp' : ''}.`)
    : ok(name, 'up to date')
}

/**
 * Goals work in every session only when `quarterdeck` is added for the user
 * (~/.claude.json). A repo .mcp.json loads only in sessions started in the repo,
 * so elsewhere the plugins find no quarterdeck tools.
 */
export function checkUserScope(o: DoctorOptions): CheckResult {
  const name = 'quarterdeck in every project'
  let servers: Record<string, unknown> = {}
  try {
    servers = JSON.parse(readFileSync(join(o.home, '.claude.json'), 'utf8')).mcpServers ?? {}
  } catch {
    // no user config yet: treated as not added
  }
  if (servers.quarterdeck) return ok(name, 'added for your user')
  const script = join(o.repoRoot, 'mcp', 'dist', 'index.js').replace(/\\/g, '/')
  return warn(name, "only in this repo's .mcp.json, so goals, the Goals pane and /goal-new work only in sessions started here",
    `Run \`claude mcp add --scope user quarterdeck -- node ${script}\`, then restart Claude Code.`)
}

export function checkMcpConfig(o: DoctorOptions): CheckResult[] {
  const file = [join(o.cwd, '.mcp.json'), join(o.repoRoot, '.mcp.json')].find((f) => existsSync(f))
  if (!file) {
    return [warn('.mcp.json', 'not found in this directory or the repo root',
      'Add a `quarterdeck` server entry pointing at mcp/dist/index.js (see README).')]
  }
  let servers: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>
  try {
    servers = JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? {}
  } catch (e) {
    return [fail('.mcp.json', `${file} is not valid JSON: ${firstLine((e as Error).message)}`, 'Fix the JSON syntax.')]
  }

  const results: CheckResult[] = []
  const quarterdeck = servers.quarterdeck
  if (!quarterdeck) {
    results.push(fail('.mcp.json quarterdeck', `no "quarterdeck" server in ${file}`, 'Add one with command "node" and args ["<repo>/mcp/dist/index.js"].'))
  } else {
    const script = (quarterdeck.args ?? []).find((a) => /\.(m?js|ts)$/.test(a))
    if (script && !existsSync(resolve(dirname(file), script))) {
      results.push(fail('.mcp.json quarterdeck', `server script not found: ${script}`, 'Fix the path, or build it with `npm run build --prefix mcp`.'))
    } else {
      const flags = ['REQUIRE_DECOMPOSE', 'STRICT_COMPLETE'].filter((k) => (quarterdeck.env?.[`QUARTERDECK_${k}`] ?? quarterdeck.env?.[`CONDUCTOR_${k}`]) === '1').map((k) => `QUARTERDECK_${k}`)
      results.push(ok('.mcp.json quarterdeck', `configured${flags.length ? ` (${flags.join(', ')})` : ''}`))
    }
  }
  if (servers['conductor-channel']) {
    results.push(warn('.mcp.json conductor-channel', 'the channel server was removed, so this entry fails to start', 'Remove "conductor-channel" from .mcp.json.'))
  }
  for (const [name, s] of Object.entries(servers)) {
    if (process.platform === 'win32' && s.command === 'npx') {
      results.push(warn(`.mcp.json ${name}`, '"npx" can\'t be launched directly on Windows', 'Use "command": "cmd" with args ["/c", "npx", ...].'))
    }
  }
  return results
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

const PLUGIN = 'quarterdeck-goals@quarterdeck'
const GUARD_PLUGIN = 'quarterdeck-guard@quarterdeck'

/**
 * The Claude Code plugins that run goals: quarterdeck-goals (Goals pane, the
 * runner that starts goal runs in subagents) and quarterdeck-guard (keeps
 * each run within its goal; without it no run starts).
 */
export function checkPlugin(o: DoctorOptions): CheckResult {
  const install = (p: string) => `Run \`claude plugin marketplace add ${o.repoRoot}\` then \`claude plugin install ${p} --scope user\`.`
  const file = join(o.home, '.claude', 'settings.json')
  let enabled: Record<string, unknown> = {}
  try {
    enabled = (JSON.parse(readFileSync(file, 'utf8')) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins ?? {}
  } catch {
    // a missing or broken settings file is reported by checkHooks
  }
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
    ...checkMcpConfig(o),
    checkUserScope(o),
    checkHooks(o),
    plugins,
    ...[checkRenameLeftovers(o)].filter((r): r is CheckResult => r !== null),
    web,
    ...[await checkGoals(o, plugins)].filter((r): r is CheckResult => r !== null),
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
