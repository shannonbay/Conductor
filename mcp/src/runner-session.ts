/**
 * `quarterdeck runner …` — the standing session: one Claude Code session with
 * Remote Control on, in its own folder and a terminal nobody looks at (a
 * hidden console on Windows, a tmux session on Linux), that runs goals
 * while no Claude Code window is open. It is an ordinary session, so the
 * quarterdeck-goals runner, the guard, alerts and phone approvals work in it
 * as anywhere; it takes the scheduler lease when no other session holds it.
 *
 * Not `claude --bg`: Claude Code's background service retires a background
 * session a few minutes after it finishes a turn (an alert passed to the
 * phone, a reply from it), which stopped goals each time (seen Nov 2026).
 *
 * `ensure` keeps it alive (a scheduled task on Windows, a systemd user timer
 * on Linux, runs it every few minutes): it
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
/** Linux: the systemd user units (.service runs `ensure`, .timer runs it) and the tmux socket and session that hold the session. */
export const UNIT_NAME = 'quarterdeck-runner'
export const TMUX_SOCKET = 'quarterdeck'
export const TMUX_SESSION = 'quarterdeck-goals'
export const ENSURE_MINUTES = 5
const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']

/** What `ensure` remembers between its runs (runner/state.json). */
export interface RunnerState {
  /** The session's id, chosen at start (`--session-id`): the scheduler lease's holder when it runs goals. */
  sessionId: string
  /** The hidden console's process (Windows) or `claude`'s in the tmux pane (Linux); 0 once stopped. Claude Code doesn't list this session, so this is how it is found. */
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
  /** Starts `claude` with these arguments in a terminal nobody looks at, in `dir`, on its own; answers the process id to find it by. */
  spawnSession(args: string[]): number
  /** Whether that session is still running. */
  pidAlive(pid: number): boolean
  /** Ends the session and everything under it. */
  killTree(pid: number): void
  /** What the session's terminal shows now, where it can be read (tmux); null otherwise. */
  screenText?(pid: number): string | null
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
  /** It is stopped at a question only someone at its terminal can answer. */
  waiting: Waiting | null
}

export type Waiting = 'trust'

/** A question on the session's screen that stops it: before the folder is trusted, no plugin loads and no goal runs. */
export function waitingOn(screen: string | null | undefined): Waiting | null {
  return screen && /trust this folder/i.test(screen) ? 'trust' : null
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
    waiting: live ? waitingOn(deps.screenText?.(live.pid)) : null,
  }
}

/** What to do about a session stopped at a question. */
export const ATTACH_HINT = 'Run `quarterdeck runner attach`, choose "Yes, I trust this folder", then leave with Ctrl-b d (it keeps running).'

export function statusText(s: RunnerStatus): string {
  if (!s.running) return 'The standing session is not running. Start it with: quarterdeck runner start'
  const who = s.holdsLease
    ? 'it is the session starting goal runs'
    : s.leaseElsewhere
      ? 'another session holds the goal runs (an open Claude Code window, or a session that just stopped); it takes over within 90 seconds of that one going quiet'
      : 'no session has started goal runs in the last minutes (it takes over within 90 seconds)'
  if (s.waiting) return `The standing session is running (${s.sessionId}) but waiting to be told its folder is safe, so no goal runs in it yet. ${ATTACH_HINT}`
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

// ── Keeping it alive: a scheduled task (Windows), a systemd timer (Linux) ─────

/** launch.mjs: the fixed file the scheduled task or timer runs. It finds the current CLI (its folder changes with each plugin version) and runs `runner ensure`. */
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

/** systemd's quoting for one word of ExecStart= or Environment= (% is a specifier, $ expands a variable). */
function sdQuote(s: string, exec: boolean): string {
  const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')
  return `"${exec ? escaped.replace(/\$/g, '$$$$') : escaped}"`
}

/**
 * The systemd user units: the timer runs the service a minute after it starts
 * (at login, or at install) and every 5 minutes after; the service runs
 * `ensure` once. KillMode=process: by default systemd ends everything a
 * finished oneshot service left behind, the tmux server holding the session
 * with it. PATH is the installing shell's, with this Node first: the plugin
 * starts its server with `node`, which must be one that has node:sqlite.
 */
export function systemdUnits(p: { node: string; launcher: string; dir: string; path: string }): { service: string; timer: string } {
  const description = 'Keeps the Quarterdeck standing session running, so goals run with no Claude Code window open. Remove with: quarterdeck runner uninstall'
  const path = [dirname(p.node), ...p.path.split(':').filter((d) => d && d !== dirname(p.node))].join(':')
  return {
    service: `[Unit]
Description=${description}

[Service]
Type=oneshot
ExecStart=${sdQuote(p.node, true)} ${sdQuote(p.launcher, true)}
WorkingDirectory=${p.dir.replace(/%/g, '%%')}
Environment=${sdQuote(`PATH=${path}`, false)}
KillMode=process
TimeoutStartSec=5min
`,
    timer: `[Unit]
Description=${description}

[Timer]
OnActiveSec=1min
OnUnitActiveSec=${ENSURE_MINUTES}min

[Install]
WantedBy=timers.target
`,
  }
}

/** What keeps the session alive here, by name, for messages. */
export function keepAliveName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? `the scheduled task "${TASK_NAME}"` : `the systemd timer ${UNIT_NAME}.timer`
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
  /** Linux: `systemctl --user …`. */
  systemctl(args: string[]): string
  /** Linux: where user units go (~/.config/systemd/user). */
  systemdDir: string
  /** Linux: this shell's PATH, for the session the timer starts (it finds `claude` and `node` there). */
  path: string
  /** Linux: puts this terminal in the session's tmux session until Ctrl-b d. */
  attach(): void
  /** Linux under WSL, which stops the whole distro once its last window closes, the standing session with it. */
  wsl: boolean
  /** Waits, blocking. */
  sleep(ms: number): void
}

const SUPPORTED: NodeJS.Platform[] = ['win32', 'linux']

/** WSL stops the distro about a minute after its last window closes (seen Nov 2026, WSL 2.6), so the standing session runs only while one is open. */
export const WSL_WARNING = 'This is WSL, which stops a minute or so after its last window closes, and the standing session with it: goals run here only while a WSL window is open. To run them with every window closed, use the standing session on Windows instead (`runner install` from a Windows terminal).'

/** Writes the launcher and creates the scheduled task (Windows) or systemd timer (Linux), then starts the session. */
export function install(deps: InstallDeps, opts: { permissionMode?: string } = {}): string {
  if (!SUPPORTED.includes(deps.platform)) throw new Error('The standing session is set up for Windows and Linux only so far.')
  if (!deps.cliPath) throw new Error('Run this from the built CLI: node plugins/quarterdeck-goals/server/quarterdeck-cli.mjs runner install (after `npm run build --prefix mcp`).')
  checkMode(opts.permissionMode)
  const launcher = join(deps.dir, 'launch.mjs')
  deps.writeFile(launcher, LAUNCHER)
  deps.writeFile(join(deps.dir, 'cli-path'), deps.cliPath)
  const lines: string[] = []
  if (deps.platform === 'win32') {
    const file = join(deps.dir, 'task.xml')
    // schtasks reads UTF-16 with a byte order mark
    deps.writeFile(file, '\ufeff' + taskXml({ user: deps.user, node: deps.node, launcher }), 'utf16le')
    deps.schtasks(['/create', '/tn', TASK_NAME, '/xml', file, '/f'])
    lines.push(`Created the scheduled task "${TASK_NAME}": it checks at logon and every ${ENSURE_MINUTES} minutes that the standing session is running.`)
  } else {
    const units = systemdUnits({ node: deps.node, launcher, dir: deps.dir, path: deps.path })
    deps.writeFile(join(deps.systemdDir, `${UNIT_NAME}.service`), units.service)
    deps.writeFile(join(deps.systemdDir, `${UNIT_NAME}.timer`), units.timer)
    deps.systemctl(['daemon-reload'])
    deps.systemctl(['enable', '--now', `${UNIT_NAME}.timer`])
    lines.push(`Created the systemd user timer ${UNIT_NAME}.timer: it checks at login and every ${ENSURE_MINUTES} minutes that the standing session is running.`)
  }
  lines.push(startByTask(deps, opts).text)
  lines.push('Goals now run while this computer is on and you are logged in, with no Claude Code window open. Remove with: quarterdeck runner uninstall')
  if (deps.platform === 'linux' && deps.wsl) lines.push(WSL_WARNING)
  else if (deps.platform === 'linux') lines.push('To keep it running after you log out too: loginctl enable-linger')
  return lines.join('\n')
}

/**
 * Starts the session by running the scheduled task (or the systemd service),
 * so Task Scheduler or systemd is its parent. A session started from a command
 * inside Claude Code would be a child of that window and may end with it.
 * On Linux it then looks at the session's screen for the folder trust
 * question, which only someone at its terminal can answer.
 */
export function startByTask(deps: InstallDeps, opts: { permissionMode?: string } = {}): StartResult {
  checkMode(opts.permissionMode)
  const live = liveState(deps)
  if (live) return { started: false, sessionId: live.sessionId, text: `The standing session is already running (${live.sessionId}).` }
  // The task's `ensure` reads the permission mode from the state
  if (opts.permissionMode) deps.writeState({ sessionId: deps.readState()?.sessionId ?? '', pid: 0, build: deps.build, permissionMode: opts.permissionMode })
  if (deps.platform === 'win32') deps.schtasks(['/run', '/tn', TASK_NAME])
  else deps.systemctl(['start', `${UNIT_NAME}.service`])
  let made: RunnerState | null = null
  for (let i = 0; i < 40 && !made; i++) {
    deps.sleep(500)
    made = liveState(deps)
  }
  if (!made) throw new Error(`${keepAliveName(deps.platform).replace(/^t/, 'T')} ran but no session appeared. See ${join(deps.dir, 'ensure.log')}.`)
  return { started: true, sessionId: made.sessionId, text: `Started the standing session (${made.sessionId}). It appears as "${SESSION_NAME}" in the Claude app and at claude.ai/code.${questionNote(deps, made.pid)}` }
}

/**
 * Where the session's screen can be read (Linux), watches it for a few seconds
 * after a start: the folder trust question comes up before Remote Control
 * connects, and only someone at its terminal can answer it. Answers a line to
 * add to the start's text, or ''.
 */
export function questionNote(deps: RunnerDeps & { sleep(ms: number): void }, pid: number): string {
  if (!deps.screenText) return ''
  for (let i = 0; i < 16; i++) {
    deps.sleep(500)
    if (waitingOn(deps.screenText(pid))) return `\nIt is waiting to be told its folder (${deps.dir}) is safe; no goal runs in it until then. ${ATTACH_HINT}`
  }
  return ''
}

/** Deletes the scheduled task or systemd timer and stops the session. The folder stays (its settings and log). */
export function uninstall(deps: InstallDeps): string {
  const lines: string[] = []
  if (deps.platform === 'win32') {
    try {
      deps.schtasks(['/delete', '/tn', TASK_NAME, '/f'])
      lines.push(`Deleted the scheduled task "${TASK_NAME}".`)
    } catch {
      lines.push(`There was no scheduled task "${TASK_NAME}".`)
    }
  } else if (deps.platform === 'linux') {
    const had = taskInstalled(deps)
    try { deps.systemctl(['disable', '--now', `${UNIT_NAME}.timer`]) } catch { /* not there */ }
    deps.removeFile(join(deps.systemdDir, `${UNIT_NAME}.timer`))
    deps.removeFile(join(deps.systemdDir, `${UNIT_NAME}.service`))
    try { deps.systemctl(['daemon-reload']) } catch { /* no user manager */ }
    lines.push(had ? `Deleted the systemd timer ${UNIT_NAME}.timer.` : `There was no systemd timer ${UNIT_NAME}.timer.`)
  }
  deps.removeFile(join(deps.dir, 'launch.mjs'))
  deps.removeFile(join(deps.dir, 'task.xml'))
  lines.push(stop(deps).text)
  return lines.join('\n')
}

/** Whether the scheduled task (Windows) or the systemd timer (Linux) is set up. */
export function taskInstalled(deps: Pick<InstallDeps, 'platform' | 'schtasks' | 'systemctl'>): boolean {
  try {
    if (deps.platform === 'win32') deps.schtasks(['/query', '/tn', TASK_NAME])
    else if (deps.platform === 'linux') deps.systemctl(['is-enabled', '--quiet', `${UNIT_NAME}.timer`])
    else return false
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

/** Runs tmux on Quarterdeck's own socket, apart from the person's tmux sessions (and their server's environment). */
function tmux(args: string[], env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync('tmux', ['-L', TMUX_SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('The standing session needs tmux on Linux: install it (for example `sudo apt install tmux`).')
    throw err
  }
}

/** The first `name` on this PATH, or null. */
function onPath(name: string, path: string): string | null {
  for (const d of path.split(':')) if (d && existsSync(join(d, name))) return join(d, name)
  return null
}

/**
 * Linux: `claude` in a detached tmux session, a real terminal nobody looks at
 * that outlives whatever started it. tmux runs the arguments as they are (no
 * shell), so the pane's process is `claude` itself.
 */
function spawnInTmux(dir: string, args: string[]): number {
  const env = sessionEnv()
  delete env.TMUX
  delete env.TMUX_PANE
  // The plugin starts its server with `node`: this one has node:sqlite, the PATH's first may not
  env.PATH = [dirname(process.execPath), env.PATH ?? ''].join(':')
  const claude = onPath('claude', env.PATH)
  if (!claude) throw new Error('`claude` is not on the PATH.')
  // One standing session: an older one whose state.json was lost goes
  try { tmux(['kill-session', '-t', TMUX_SESSION]) } catch { /* none */ }
  const newSession = ['new-session', '-d', '-s', TMUX_SESSION, '-x', '200', '-y', '50', '-c', dir, '-P', '-F', '#{pane_pid}', '--', claude, ...args]
  let out: string
  try {
    // In a scope of its own, the tmux server isn't left behind in `ensure`'s service, which systemd
    // logs as an unclean stop at every check (seen Nov 2026)
    out = execFileSync('systemd-run', ['--user', '--scope', '--collect', '--quiet', '--description=Quarterdeck standing session', 'tmux', '-L', TMUX_SOCKET, ...newSession],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env })
  } catch {
    // No systemd user manager: tmux alone
    out = tmux(newSession, env)
  }
  const pid = Number(out.trim())
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Could not start the tmux session: ${out.trim().slice(0, 200)}`)
  return pid
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Linux: whether `pid` is the standing session's pane (not some later process that got the same id). */
function tmuxPaneAlive(pid: number): boolean {
  try { return tmux(['list-panes', '-t', TMUX_SESSION, '-F', '#{pane_pid}']).split('\n').includes(String(pid)) } catch { return false }
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
    // On Linux, a detached tmux session instead
    spawnSession: (args) => {
      if (process.platform === 'linux') return spawnInTmux(dir, args)
      if (process.platform !== 'win32') throw new Error('The standing session is set up for Windows and Linux only so far.')
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
      if (process.platform === 'linux') return tmuxPaneAlive(pid)
      try {
        if (process.platform !== 'win32') { process.kill(pid, 0); return true }
        return /conhost\.exe/i.test(execFileSync('tasklist.exe', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }))
      } catch { return false }
    },
    killTree: (pid) => {
      try {
        if (process.platform === 'win32') execFileSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
        else if (process.platform === 'linux') {
          tmux(['kill-session', '-t', TMUX_SESSION])
          // claude takes a few seconds to exit after the hang-up (seen Nov 2026); stopped means stopped
          for (let i = 0; i < 20 && processAlive(pid); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
          if (processAlive(pid)) process.kill(pid, 'SIGKILL')
        } else process.kill(pid)
      } catch { /* already gone */ }
    },
    screenText: (pid) => {
      if (process.platform !== 'linux' || !tmuxPaneAlive(pid)) return null
      try { return tmux(['capture-pane', '-p', '-t', TMUX_SESSION]) } catch { return null }
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
    writeFile: (path, content, encoding) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content, encoding ?? 'utf8')
    },
    removeFile: (path) => rmSync(path, { force: true }),
    schtasks: (args) => execFileSync('schtasks.exe', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
    systemctl: (args) => execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    systemdDir: join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user'),
    path: process.env.PATH ?? '',
    wsl: process.platform === 'linux' && (() => { try { return /microsoft/i.test(readFileSync('/proc/version', 'utf8')) } catch { return false } })(),
    attach: () => {
      if (process.platform !== 'linux') throw new Error('attach is for Linux, where the session is in tmux.')
      if (!process.stdin.isTTY) throw new Error(`attach needs a terminal: run it in one of its own (or: tmux -L ${TMUX_SOCKET} attach -t ${TMUX_SESSION}).`)
      const env = { ...process.env }
      delete env.TMUX
      execFileSync('tmux', ['-L', TMUX_SOCKET, 'attach', '-t', TMUX_SESSION], { stdio: 'inherit', env })
    },
    sleep: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) },
  }
}

export const RUNNER_USAGE = [
  'Usage: quarterdeck runner <command>',
  '',
  'The standing session: a Claude Code session with Remote Control on, in a hidden console (Windows) or a',
  'tmux session (Linux), which runs goals while no Claude Code window is open (the computer must be on',
  'and you logged in).',
  '',
  '  install [--permission-mode <mode>]   Start it, and keep it running (a scheduled task; on Linux a systemd timer)',
  '  uninstall                            Stop it and delete the scheduled task or timer',
  '  start [--permission-mode <mode>]     Start it now',
  '  stop                                 Stop it',
  '  status                               Whether it is running and starting goal runs',
  '  ensure                               Start it if it is missing; restart it after an update',
  '  attach                               Linux: open its terminal (to answer a question); Ctrl-b d leaves it running',
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
        if (taskInstalled(d)) return { text: startByTask(d, { permissionMode }).text, code: 0 }
        const r = start(d, { permissionMode })
        const live = r.started ? liveState(d) : null
        if (live) r.text += questionNote(d, live.pid)
        const warning = r.started && d.insideClaudeCode ? '\nStarted from inside Claude Code, so it may stop when this window closes. Run `quarterdeck runner install` (or start it from a terminal of its own) to keep it.' : ''
        return { text: r.text + warning, code: 0 }
      }
      case 'stop': return { text: stop(d).text, code: 0 }
      case 'status': {
        const s = status(d)
        return { text: statusText(s), code: s.running ? 0 : 1 }
      }
      case 'ensure': return { text: ensure(d).text, code: 0 }
      case 'attach': {
        if (!liveState(d)) return { text: 'The standing session is not running. Start it with: quarterdeck runner start', code: 1 }
        d.attach()
        return { text: '', code: 0 }
      }
      default: return { text: RUNNER_USAGE, code: 1 }
    }
  } catch (err) {
    return { text: `quarterdeck runner: ${firstLine(err)}`, code: 1 }
  }
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).trim().split('\n')[0]!
}
