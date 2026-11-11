/**
 * `quarterdeck runner …` — the standing session: one Claude Code session with
 * Remote Control on, in its own folder and a hidden console, that runs goals
 * while no Claude Code window is open. It is an ordinary session, so the
 * quarterdeck-goals runner, the guard, alerts and phone approvals work in it
 * as anywhere; it takes the scheduler lease when no other session holds it.
 *
 * Not `claude --bg`: Claude Code's background service retires a background
 * session a few minutes after it finishes a turn (an alert passed to the
 * phone, a reply from it), which stopped goals each time (seen Nov 2026).
 *
 * `ensure` keeps it alive (a scheduled task runs it every few minutes): it
 * starts the session when it is missing and restarts it after an update.
 * The decisions here are pure; everything that touches processes, the
 * database or the disk comes in through RunnerDeps.
 */
import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir, userInfo } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

export const SESSION_NAME = 'Quarterdeck goals'
export const TASK_NAME = 'Quarterdeck goals runner'
export const ENSURE_MINUTES = 5
const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']

/** What `ensure` remembers between its runs (runner/state.json). */
export interface RunnerState {
  /** The session's id, chosen at start (`--session-id`): the scheduler lease's holder when it runs goals. */
  sessionId: string
  /** The hidden console's process; 0 once stopped. Claude Code doesn't list this session, so this is how it is found. */
  pid: number
  /** The Quarterdeck build that session started with; a different one now means restart. */
  build: string
  /** `--permission-mode` for the session, kept so a restart uses it again. */
  permissionMode?: string
}

export interface RunnerDeps {
  /** The standing session's folder (~/.quarterdeck/runner). */
  dir: string
  /** This Quarterdeck's build id. */
  build: string
  /** Starts `claude` with these arguments in a hidden console in `dir`, on its own; answers the console's process id. */
  spawnSession(args: string[]): number
  /** Whether that console is still running. */
  pidAlive(pid: number): boolean
  /** Ends the console and everything under it. */
  killTree(pid: number): void
  newId(): string
  /** Goal runs going now: no restart while one is. */
  runsRunning(): number
  /** The session id holding the scheduler lease, or null. */
  leaseHolder(): string | null
  readState(): RunnerState | null
  writeState(state: RunnerState | null): void
}

/** The state of a session that is running now, or null. */
function liveState(deps: RunnerDeps): RunnerState | null {
  const state = deps.readState()
  return state && state.pid > 0 && deps.pidAlive(state.pid) ? state : null
}

export interface RunnerStatus {
  running: boolean
  sessionId: string | null
  /** True when the standing session is the one scheduling goal runs. */
  holdsLease: boolean
  /** The lease is another session's: an open Claude Code window runs goals, and the standing session takes over when it closes. */
  leaseElsewhere: boolean
  /** The session started with another build than this one. */
  stale: boolean
}

export function status(deps: RunnerDeps): RunnerStatus {
  const live = liveState(deps)
  const holder = deps.leaseHolder()
  return {
    running: live !== null,
    sessionId: live?.sessionId ?? null,
    holdsLease: live !== null && holder === live.sessionId,
    leaseElsewhere: holder !== null && holder !== live?.sessionId,
    stale: live !== null && live.build !== deps.build,
  }
}

export function statusText(s: RunnerStatus): string {
  if (!s.running) return 'The standing session is not running. Start it with: quarterdeck runner start'
  const who = s.holdsLease
    ? 'it is the session starting goal runs'
    : s.leaseElsewhere
      ? 'an open Claude Code window is starting goal runs now; it takes over when that closes'
      : 'no session has started goal runs in the last minutes (it takes over within 90 seconds)'
  return `The standing session is running (${s.sessionId}); ${who}.${s.stale ? ' It started with an older Quarterdeck and restarts at the next check with no run going.' : ''}`
}

/** The `claude` arguments that start the standing session. */
export function startArgs(sessionId: string, permissionMode?: string): string[] {
  return ['--remote-control', SESSION_NAME, '--name', SESSION_NAME, '--session-id', sessionId, ...(permissionMode ? ['--permission-mode', permissionMode] : [])]
}

export type StartResult = { started: boolean; sessionId: string | null; text: string }

function checkMode(permissionMode: string | undefined): void {
  if (permissionMode && !PERMISSION_MODES.includes(permissionMode)) throw new Error(`Unknown permission mode "${permissionMode}" (one of: ${PERMISSION_MODES.join(', ')}).`)
}

/** Starts the standing session unless one is alive. */
export function start(deps: RunnerDeps, opts: { permissionMode?: string } = {}): StartResult {
  const permissionMode = opts.permissionMode ?? deps.readState()?.permissionMode
  checkMode(permissionMode)
  const live = liveState(deps)
  if (live) return { started: false, sessionId: live.sessionId, text: `The standing session is already running (${live.sessionId}).` }
  const sessionId = deps.newId()
  const pid = deps.spawnSession(startArgs(sessionId, permissionMode))
  deps.writeState({ sessionId, pid, build: deps.build, ...(permissionMode ? { permissionMode } : {}) })
  return { started: true, sessionId, text: `Started the standing session (${sessionId}). It appears as "${SESSION_NAME}" in the Claude app and at claude.ai/code.` }
}

/** Stops the standing session. Its settings (the permission mode) are kept for the next start. */
export function stop(deps: RunnerDeps): { stopped: boolean; text: string } {
  const live = liveState(deps)
  if (!live) return { stopped: false, text: 'The standing session was not running.' }
  deps.killTree(live.pid)
  deps.writeState({ ...live, pid: 0 })
  return { stopped: true, text: 'Stopped the standing session.' }
}

export type EnsureAction = 'running' | 'started' | 'restarted' | 'restart-waits'

/**
 * What the scheduled task runs: starts the session when it is missing, and
 * restarts one that started with another build (after an update), but never
 * while a goal run is going.
 */
export function ensure(deps: RunnerDeps): { action: EnsureAction; text: string } {
  const live = liveState(deps)
  if (!live) return { action: 'started', text: start(deps).text }
  if (live.build === deps.build) return { action: 'running', text: `The standing session is running (${live.sessionId}).` }
  if (deps.runsRunning() > 0) return { action: 'restart-waits', text: 'Quarterdeck was updated; the standing session restarts once no goal run is going.' }
  stop(deps)
  const r = start(deps)
  return { action: 'restarted', text: `Quarterdeck was updated: restarted the standing session (${r.sessionId}).` }
}

// ── The scheduled task (Windows) ──────────────────────────────────────────────

/** launch.mjs: the fixed file the scheduled task runs. It finds the current CLI (its folder changes with each plugin version) and runs `runner ensure`. */
export const LAUNCHER = `// Written by \`quarterdeck runner install\`. Runs \`quarterdeck runner ensure\` with the current Quarterdeck.
import { execFileSync } from 'child_process'
import { appendFileSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const dir = dirname(fileURLToPath(import.meta.url))
let out
try {
  const cli = readFileSync(join(dir, 'cli-path'), 'utf8').trim()
  out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'runner', 'ensure'], { encoding: 'utf8', windowsHide: true })
} catch (err) {
  out = 'failed: ' + (err && err.stderr ? String(err.stderr) : '') + (err && err.message ? err.message : String(err))
}
// One line a check, except the usual "is running"
if (!/^The standing session is running/.test(out.trim())) appendFileSync(join(dir, 'ensure.log'), new Date().toISOString() + ' ' + out.trim().replace(/\\s+/g, ' ') + '\\n')
`

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The task's definition: at logon and every 15 minutes, as the person, only
 * while they are logged on (Claude Code's sign-in is theirs), on battery too,
 * with no window (conhost --headless).
 */
export function taskXml(p: { user: string; node: string; launcher: string; now?: Date }): string {
  // Read as local time: a day back, so it is in the past in every time zone and the repetition starts at once
  const start = new Date((p.now ?? new Date()).getTime() - 86_400_000).toISOString().slice(0, 19)
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Keeps the Quarterdeck standing session running, so goals run with no Claude Code window open. Remove with: quarterdeck runner uninstall</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(p.user)}</UserId>
      <Delay>PT1M</Delay>
    </LogonTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>PT${ENSURE_MINUTES}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>${start}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(p.user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>conhost.exe</Command>
      <Arguments>--headless "${xml(p.node)}" "${xml(p.launcher)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`
}

export interface InstallDeps extends RunnerDeps {
  platform: NodeJS.Platform
  /** True when this command runs inside a Claude Code session (its Bash tool): what it starts ends with that window. */
  insideClaudeCode: boolean
  /** The built CLI to run (server/quarterdeck-cli.mjs), or null when this isn't one (tsx in a checkout). */
  cliPath: string | null
  /** `DOMAIN\user`, for the task. */
  user: string
  node: string
  writeFile(path: string, content: string, encoding?: 'utf16le'): void
  removeFile(path: string): void
  schtasks(args: string[]): string
  /** Waits, blocking. */
  sleep(ms: number): void
}

/** Writes the launcher and creates the scheduled task, then starts the session. */
export function install(deps: InstallDeps, opts: { permissionMode?: string } = {}): string {
  if (deps.platform !== 'win32') throw new Error('The standing session is set up for Windows only so far (it needs a hidden console and Task Scheduler).')
  if (!deps.cliPath) throw new Error('Run this from the built CLI: node plugins/quarterdeck-goals/server/quarterdeck-cli.mjs runner install (after `npm run build --prefix mcp`).')
  const launcher = join(deps.dir, 'launch.mjs')
  deps.writeFile(launcher, LAUNCHER)
  deps.writeFile(join(deps.dir, 'cli-path'), deps.cliPath)
  const file = join(deps.dir, 'task.xml')
  // schtasks reads UTF-16 with a byte order mark
  deps.writeFile(file, '\ufeff' + taskXml({ user: deps.user, node: deps.node, launcher }), 'utf16le')
  deps.schtasks(['/create', '/tn', TASK_NAME, '/xml', file, '/f'])
  const lines = [
    `Created the scheduled task "${TASK_NAME}": it checks at logon and every ${ENSURE_MINUTES} minutes that the standing session is running.`,
    startByTask(deps, opts).text,
  ]
  lines.push('Goals now run while this computer is on and you are logged in, with no Claude Code window open. Remove with: quarterdeck runner uninstall')
  return lines.join('\n')
}

/**
 * Starts the session by running the scheduled task, so Task Scheduler is its
 * parent. A session started from a command inside Claude Code would be a child
 * of that window and may end with it.
 */
export function startByTask(deps: InstallDeps, opts: { permissionMode?: string } = {}): StartResult {
  checkMode(opts.permissionMode)
  const live = liveState(deps)
  if (live) return { started: false, sessionId: live.sessionId, text: `The standing session is already running (${live.sessionId}).` }
  // The task's `ensure` reads the permission mode from the state
  if (opts.permissionMode) deps.writeState({ sessionId: deps.readState()?.sessionId ?? '', pid: 0, build: deps.build, permissionMode: opts.permissionMode })
  deps.schtasks(['/run', '/tn', TASK_NAME])
  let made: RunnerState | null = null
  for (let i = 0; i < 40 && !made; i++) {
    deps.sleep(500)
    made = liveState(deps)
  }
  if (!made) throw new Error(`The scheduled task ran but no session appeared. See ${join(deps.dir, 'ensure.log')}.`)
  return { started: true, sessionId: made.sessionId, text: `Started the standing session (${made.sessionId}). It appears as "${SESSION_NAME}" in the Claude app and at claude.ai/code.` }
}

/** Deletes the scheduled task and stops the session. The folder stays (its settings and log). */
export function uninstall(deps: InstallDeps): string {
  const lines: string[] = []
  if (deps.platform === 'win32') {
    try {
      deps.schtasks(['/delete', '/tn', TASK_NAME, '/f'])
      lines.push(`Deleted the scheduled task "${TASK_NAME}".`)
    } catch {
      lines.push(`There was no scheduled task "${TASK_NAME}".`)
    }
  }
  deps.removeFile(join(deps.dir, 'launch.mjs'))
  deps.removeFile(join(deps.dir, 'task.xml'))
  lines.push(stop(deps).text)
  return lines.join('\n')
}

/** Whether the scheduled task exists (Windows). */
export function taskInstalled(deps: Pick<InstallDeps, 'platform' | 'schtasks'>): boolean {
  if (deps.platform !== 'win32') return false
  try {
    deps.schtasks(['/query', '/tn', TASK_NAME])
    return true
  } catch {
    return false
  }
}

// ── The real thing ────────────────────────────────────────────────────────────

/** The standing session's folder: beside the database, in ~/.quarterdeck. */
export function runnerDir(home: string = homedir()): string {
  return join(home, '.quarterdeck', 'runner')
}

/**
 * This Quarterdeck's build: the plugin's version and when its server was
 * bundled, so a rebuild in a checkout (same version) restarts the session too.
 */
export function currentBuild(scriptDir: string = dirname(fileURLToPath(import.meta.url))): string {
  // The bundle sits in <plugin>/server; in a checkout this file is mcp/src or mcp/dist
  const plugin = [join(scriptDir, '..'), join(scriptDir, '..', '..', 'plugins', 'quarterdeck-goals')].find((d) => existsSync(join(d, '.claude-plugin', 'plugin.json')))
  if (!plugin) return 'unknown'
  let version = 'unknown'
  try { version = String((JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: unknown }).version) } catch { /* keep unknown */ }
  const bundle = join(plugin, 'server', 'quarterdeck-mcp.mjs')
  return existsSync(bundle) ? `${version}+${Math.round(statSync(bundle).mtimeMs)}` : version
}

/** Called by the MCP server at start-up: tells the launcher where the current CLI is. Does nothing until the standing session is set up. */
export function recordCliPath(serverDir: string, dir: string = runnerDir()): void {
  try {
    const cli = join(serverDir, 'quarterdeck-cli.mjs')
    if (!existsSync(join(dir, 'launch.mjs')) || !existsSync(cli)) return
    const file = join(dir, 'cli-path')
    if (existsSync(file) && readFileSync(file, 'utf8').trim() === cli) return
    writeFileSync(file, cli)
  } catch { /* never stops the server */ }
}

/** The standing session's id, or null when there is none (read for each overview: a small file). */
export function standingSessionId(dir: string = runnerDir()): string | null {
  try { return (JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as RunnerState).sessionId ?? null } catch { return null }
}

/** The environment for the session: this process's, without what marks it as running inside another Claude Code session. */
function sessionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^CLAUDE(CODE$|_CODE_|_PID$|_EFFORT$)/.test(key)) delete env[key]
  return env
}

export async function realDeps(): Promise<InstallDeps> {
  const core = await import('@quarterdeck/core')
  const dir = runnerDir()
  mkdirSync(dir, { recursive: true })
  const stateFile = join(dir, 'state.json')
  const withDb = <T>(fn: (db: InstanceType<typeof core.Database>) => T): T => {
    const db = core.openDatabase(core.defaultDbPath())
    try { return fn(db) } finally { db.close() }
  }
  const script = process.argv[1] ?? ''
  return {
    dir,
    build: currentBuild(),
    // conhost --headless gives `claude` a console with no window. Started through PowerShell's
    // Start-Process: started by Node's spawn (detached or not, any stdio) it exits within seconds (seen Nov 2026)
    spawnSession: (args) => {
      if (process.platform !== 'win32') throw new Error('The standing session is set up for Windows only so far (it needs a hidden console).')
      const claude = execFileSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0]!.trim()
      const quote = (a: string) => (/[\s"]/.test(a) ? `"${a}"` : a)
      // One PowerShell single-quoted string holds the whole argument line ('' is a quote inside it)
      const ps = (s: string) => `'${s.replace(/'/g, "''")}'`
      const line = ['--headless', quote(claude), ...args.map(quote)].join(' ')
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Start-Process -FilePath conhost.exe -ArgumentList ${ps(line)} -WorkingDirectory ${ps(dir)} -WindowStyle Hidden -PassThru).Id`,
      ], { encoding: 'utf8', windowsHide: true, env: sessionEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
      const pid = Number(out.trim())
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Could not start the hidden console (conhost.exe): ${out.trim().slice(0, 200)}`)
      return pid
    },
    pidAlive: (pid) => {
      try {
        if (process.platform !== 'win32') { process.kill(pid, 0); return true }
        return /conhost\.exe/i.test(execFileSync('tasklist.exe', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }))
      } catch { return false }
    },
    killTree: (pid) => {
      try {
        if (process.platform === 'win32') execFileSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
        else process.kill(pid)
      } catch { /* already gone */ }
    },
    newId: () => randomUUID(),
    runsRunning: () => withDb((db) => (db.prepare("SELECT COUNT(*) n FROM goal_runs WHERE status = 'running'").get() as { n: number }).n),
    leaseHolder: () => withDb((db) => core.leaseHolder(db)),
    readState: () => {
      try { return JSON.parse(readFileSync(stateFile, 'utf8')) as RunnerState } catch { return null }
    },
    writeState: (state) => {
      if (state) writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n')
      else rmSync(stateFile, { force: true })
    },
    platform: process.platform,
    insideClaudeCode: process.env.CLAUDECODE === '1',
    cliPath: /quarterdeck-cli\.mjs$/.test(script) ? script : null,
    user: process.platform === 'win32' && process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${userInfo().username}` : userInfo().username,
    node: process.execPath,
    writeFile: (path, content, encoding) => writeFileSync(path, content, encoding ?? 'utf8'),
    removeFile: (path) => rmSync(path, { force: true }),
    schtasks: (args) => execFileSync('schtasks.exe', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
    sleep: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) },
  }
}

export const RUNNER_USAGE = [
  'Usage: quarterdeck runner <command>',
  '',
  'The standing session: a Claude Code session in a hidden console with Remote Control on, which runs',
  'goals while no Claude Code window is open (the computer must be on and you logged in).',
  '',
  '  install [--permission-mode <mode>]   Start it, and keep it running with a scheduled task',
  '  uninstall                            Stop it and delete the scheduled task',
  '  start [--permission-mode <mode>]     Start it now',
  '  stop                                 Stop it',
  '  status                               Whether it is running and starting goal runs',
  '  ensure                               Start it if it is missing; restart it after an update',
].join('\n')

/** Runs one `quarterdeck runner …` command; answers the text to print and the exit code. */
export async function runnerCommand(args: string[], deps?: InstallDeps): Promise<{ text: string; code: number }> {
  const [command, ...rest] = args
  if (!command || command === 'help' || command === '--help') return { text: RUNNER_USAGE, code: 0 }
  const at = rest.indexOf('--permission-mode')
  const permissionMode = at >= 0 ? rest[at + 1] : undefined
  try {
    const d = deps ?? await realDeps()
    switch (command) {
      case 'install': return { text: install(d, { permissionMode }), code: 0 }
      case 'uninstall': return { text: uninstall(d), code: 0 }
      case 'start': {
        if (d.platform === 'win32' && taskInstalled(d)) return { text: startByTask(d, { permissionMode }).text, code: 0 }
        const r = start(d, { permissionMode })
        const warning = r.started && d.insideClaudeCode ? '\nStarted from inside Claude Code, so it may stop when this window closes. Run `quarterdeck runner install` (or start it from a terminal of its own) to keep it.' : ''
        return { text: r.text + warning, code: 0 }
      }
      case 'stop': return { text: stop(d).text, code: 0 }
      case 'status': {
        const s = status(d)
        return { text: statusText(s), code: s.running ? 0 : 1 }
      }
      case 'ensure': return { text: ensure(d).text, code: 0 }
      default: return { text: RUNNER_USAGE, code: 1 }
    }
  } catch (err) {
    return { text: `quarterdeck runner: ${firstLine(err)}`, code: 1 }
  }
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).trim().split('\n')[0]!
}
