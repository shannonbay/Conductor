import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ensure, install, runnerCommand, start, startArgs, startByTask, status, statusText, stop, systemdUnits, taskXml, transcriptPath, uninstall, waitingOn,
  RESUME_MAX_BYTES, SESSION_NAME, TASK_NAME, UNIT_NAME, type InstallDeps, type RunnerState,
} from '../runner-session.js'
import { checkRunner } from '../doctor.js'

const DIR = 'C:\\Users\\me\\.quarterdeck\\runner'

const UNITS = '/home/me/.config/systemd/user'
const TRUST = ' Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder\n'

/** A fake computer: started sessions are process ids in `alive`; running the scheduled task (or the systemd service) runs `ensure`, as Task Scheduler or systemd would. */
function fake(over: Partial<InstallDeps> = {}) {
  const world = {
    alive: new Set<number>(),
    spawned: [] as string[][],
    killed: [] as number[],
    state: null as RunnerState | null,
    files: {} as Record<string, string>,
    tasks: [] as string[][],
    running: 0,
    holder: null as string | null,
    made: 0,
    systemctl: [] as string[][],
    enabled: false,
    screen: null as string | null,
    attached: 0,
    /** Transcript sizes by session id; none means no transcript. */
    transcripts: {} as Record<string, number>,
  }
  const deps: InstallDeps = {
    dir: DIR,
    build: '0.14.0+1',
    spawnSession: (args) => {
      world.spawned.push(args)
      const pid = 100 + world.spawned.length
      world.alive.add(pid)
      return pid
    },
    pidAlive: (pid) => world.alive.has(pid),
    killTree: (pid) => {
      world.killed.push(pid)
      world.alive.delete(pid)
    },
    newId: () => `session-${++world.made}`,
    transcriptBytes: (id) => world.transcripts[id] ?? null,
    runsRunning: () => world.running,
    leaseHolder: () => world.holder,
    readState: () => world.state,
    writeState: (s) => { world.state = s },
    platform: 'win32',
    insideClaudeCode: false,
    cliPath: 'C:\\plugins\\quarterdeck-goals\\0.14.0\\server\\quarterdeck-cli.mjs',
    user: 'PC\\me',
    node: 'C:\\Program Files\\nodejs\\node.exe',
    writeFile: (path, content) => { world.files[path] = content },
    removeFile: (path) => { delete world.files[path] },
    schtasks: (args) => {
      world.tasks.push(args)
      if (args[0] === '/query' && !world.tasks.some((t) => t[0] === '/create')) throw new Error('ERROR: The system cannot find the file specified.')
      if (args[0] === '/run') ensure(deps)
      return 'SUCCESS'
    },
    systemctl: (args) => {
      world.systemctl.push(args)
      if (args[0] === 'enable') world.enabled = true
      if (args[0] === 'disable') world.enabled = false
      if (args[0] === 'is-enabled' && !world.enabled) throw new Error('disabled')
      if (args[0] === 'start') ensure(deps)
      return ''
    },
    systemdDir: UNITS,
    path: '/usr/local/bin:/home/me/.local/bin:/usr/bin',
    attach: () => { world.attached++ },
    wsl: false,
    screenText: () => world.screen,
    sleep: () => {},
    ...over,
  }
  return { deps, world }
}

describe('the standing session', () => {
  it('starts in a hidden console with Remote Control on and an id of its own, and remembers it', () => {
    const { deps, world } = fake()
    const r = start(deps)
    expect(r).toMatchObject({ started: true, sessionId: 'session-1' })
    expect(world.spawned).toEqual([['--remote-control', SESSION_NAME, '--name', SESSION_NAME, '--session-id', 'session-1', '--allowedTools', 'mcp__plugin_quarterdeck-goals_quarterdeck,mcp__quarterdeck']])
    expect(world.state).toEqual({ sessionId: 'session-1', pid: 101, build: '0.14.0+1' })
    // Not `claude --bg`: the background service retires such a session after a turn
    expect(startArgs('x')).not.toContain('--bg')
    // A second start leaves the live one alone
    expect(start(deps).started).toBe(false)
    expect(world.spawned).toHaveLength(1)
  })

  it('keeps a permission mode for later starts, and refuses an unknown one', () => {
    const { deps, world } = fake()
    start(deps, { permissionMode: 'auto' })
    expect(startArgs('x', 'auto').slice(-2)).toEqual(['--permission-mode', 'auto'])
    expect(stop(deps).stopped).toBe(true)
    expect(world.killed).toEqual([101])
    expect(world.state).toMatchObject({ pid: 0, permissionMode: 'auto' })
    start(deps)
    expect(world.spawned[1]).toContain('auto')
    expect(() => start(fake().deps, { permissionMode: 'yolo' })).toThrow(/Unknown permission mode/)
  })

  it('ensure starts a missing session, leaves a live one alone, and starts again after it dies', () => {
    const { deps, world } = fake()
    expect(ensure(deps).action).toBe('started')
    expect(ensure(deps).action).toBe('running')
    expect(world.spawned).toHaveLength(1)
    world.alive.clear() // the computer restarted, or the session crashed
    expect(ensure(deps).action).toBe('started')
    expect(world.state).toMatchObject({ sessionId: 'session-2', pid: 102 })
  })

  it('ensure restarts after an update, but only when no run is going', () => {
    const { deps, world } = fake()
    ensure(deps)
    const updated = { ...deps, build: '0.15.0+2' }
    world.running = 1
    expect(ensure(updated).action).toBe('restart-waits')
    expect(world.spawned).toHaveLength(1)
    world.running = 0
    expect(ensure(updated).action).toBe('restarted')
    expect(world.killed).toEqual([101])
    expect(world.state).toEqual({ sessionId: 'session-2', pid: 102, build: '0.15.0+2' })
    expect(ensure(updated).action).toBe('running')
  })

  it('a restart resumes the earlier session, so it stays one chat in the Claude app', () => {
    const { deps, world } = fake()
    start(deps, { permissionMode: 'auto' })
    world.transcripts['session-1'] = 50_000
    world.alive.clear() // a restart of the computer
    const r = start(deps)
    expect(r).toMatchObject({ started: true, sessionId: 'session-1' })
    expect(r.text).toMatch(/again/)
    expect(world.spawned[1]).toEqual(['--remote-control', SESSION_NAME, '--name', SESSION_NAME, '--resume', 'session-1', '--allowedTools', 'mcp__plugin_quarterdeck-goals_quarterdeck,mcp__quarterdeck', '--permission-mode', 'auto'])
    expect(world.state).toEqual({ sessionId: 'session-1', pid: 102, build: '0.14.0+1', permissionMode: 'auto' })
    // After an update too
    world.running = 0
    expect(ensure({ ...deps, build: '0.15.0+2' }).action).toBe('restarted')
    expect(world.spawned[2]).toContain('--resume')
    expect(world.state).toMatchObject({ sessionId: 'session-1', build: '0.15.0+2' })
  })

  it('starts a new session when the transcript is missing or too long, or the resume dies at once', () => {
    // No transcript: new
    const a = fake()
    a.world.state = { sessionId: 'old', pid: 0, build: '0.14.0+1' }
    expect(start(a.deps).sessionId).toBe('session-1')
    expect(a.world.spawned[0]).toContain('--session-id')

    // Too long: new
    const b = fake()
    b.world.state = { sessionId: 'old', pid: 0, build: '0.14.0+1' }
    b.world.transcripts.old = RESUME_MAX_BYTES
    expect(start(b.deps).sessionId).toBe('session-1')

    // The resumed session exits at once: a new one
    const c = fake()
    c.world.state = { sessionId: 'old', pid: 0, build: '0.14.0+1' }
    c.world.transcripts.old = 10
    const spawn = c.deps.spawnSession
    c.deps.spawnSession = (args) => {
      const pid = spawn(args)
      if (args.includes('--resume')) c.world.alive.delete(pid)
      return pid
    }
    expect(start(c.deps)).toMatchObject({ started: true, sessionId: 'session-1' })
    expect(c.world.spawned.map((s) => s[4])).toEqual(['--resume', '--session-id'])
    expect(c.world.state).toMatchObject({ sessionId: 'session-1', pid: 102 })
  })

  it('finds the transcript where Claude Code keeps it', () => {
    expect(transcriptPath('C:\\Users\\me\\.quarterdeck\\runner', 'abc', 'C:\\Users\\me\\.claude')).toBe(join('C:\\Users\\me\\.claude', 'projects', 'C--Users-me--quarterdeck-runner', 'abc.jsonl'))
    expect(transcriptPath('/home/me/.quarterdeck/runner', 'abc', '/home/me/.claude')).toBe(join('/home/me/.claude', 'projects', '-home-me--quarterdeck-runner', 'abc.jsonl'))
  })

  it('status says who starts goal runs', () => {
    const { deps, world } = fake()
    expect(statusText(status(deps))).toMatch(/not running/)
    start(deps)
    world.holder = 'session-1'
    expect(status(deps)).toMatchObject({ running: true, holdsLease: true, leaseElsewhere: false, stale: false })
    world.holder = 'a-window'
    expect(statusText(status(deps))).toMatch(/another session holds the goal runs \(an open Claude Code window, or a session that just stopped\)/)
    expect(status({ ...deps, build: 'newer' }).stale).toBe(true)
    stop(deps)
    expect(status(deps)).toMatchObject({ running: false, sessionId: null })
  })

  it('install writes the launcher and the task, and the task starts the session; uninstall undoes it', () => {
    const { deps, world } = fake()
    const text = install(deps, { permissionMode: 'auto' })
    expect(world.files[join(DIR, 'launch.mjs')]).toMatch(/runner', 'ensure'/)
    expect(world.files[join(DIR, 'cli-path')]).toBe(deps.cliPath)
    expect(world.tasks[0]).toEqual(['/create', '/tn', TASK_NAME, '/xml', join(DIR, 'task.xml'), '/f'])
    expect(world.files[join(DIR, 'task.xml')]!.startsWith('\ufeff<?xml')).toBe(true)
    // The task starts the session, not this command: started from inside Claude Code it would be that window's child
    expect(world.tasks[1]).toEqual(['/run', '/tn', TASK_NAME])
    expect(world.spawned).toHaveLength(1)
    expect(world.spawned[0]).toContain('auto')
    expect(text).toMatch(/no Claude Code window open/)

    expect(uninstall(deps)).toMatch(/Deleted the scheduled task/)
    expect(world.tasks.at(-1)).toEqual(['/delete', '/tn', TASK_NAME, '/f'])
    expect(world.files[join(DIR, 'launch.mjs')]).toBeUndefined()
    expect(world.alive.size).toBe(0)
  })

  it('says so when the task ran but no session appeared', () => {
    const { deps } = fake({ schtasks: () => 'SUCCESS' })
    expect(() => startByTask(deps)).toThrow(/no session appeared/)
  })

  it('the task runs at logon and every 5 minutes, as the person, on battery too, with no window', () => {
    const x = taskXml({ user: 'PC\\me', node: 'C:\\Program Files\\nodejs\\node.exe', launcher: 'C:\\Users\\R&D\\launch.mjs', now: new Date('2026-11-11T02:03:04Z') })
    expect(x).toContain('<LogonTrigger>')
    expect(x).toContain('<Interval>PT5M</Interval>')
    expect(x).toContain('<UserId>PC\\me</UserId>')
    expect(x).toContain('<LogonType>InteractiveToken</LogonType>')
    expect(x).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>')
    expect(x).toContain('<Command>conhost.exe</Command>')
    expect(x).toContain('--headless "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\R&amp;D\\launch.mjs"')
    expect(x).toContain('<StartBoundary>2026-11-10T02:03:04</StartBoundary>')
  })

  it('install needs the built CLI, and Windows or Linux', () => {
    expect(() => install(fake({ cliPath: null }).deps)).toThrow(/built CLI/)
    expect(() => install(fake({ platform: 'darwin' }).deps)).toThrow(/Windows and Linux only/)
  })

  it('on Linux, install writes a systemd timer and service, and the service starts the session; uninstall undoes it', async () => {
    const { deps, world } = fake({ platform: 'linux', dir: '/home/me/.quarterdeck/runner', node: '/opt/node22/bin/node', cliPath: '/plugins/quarterdeck-goals/server/quarterdeck-cli.mjs' })
    const text = install(deps, { permissionMode: 'auto' })
    // The paths are joined as this computer joins them (backslashes when the tests run on Windows); systemdUnits' own test has the Linux text
    const service = join(UNITS, `${UNIT_NAME}.service`)
    const timer = join(UNITS, `${UNIT_NAME}.timer`)
    expect(world.files[service]).toMatch(/^ExecStart="\/opt\/node22\/bin\/node" ".*launch\.mjs"$/m)
    expect(world.files[timer]).toContain('OnUnitActiveSec=5min')
    expect(world.systemctl).toEqual([['daemon-reload'], ['enable', '--now', `${UNIT_NAME}.timer`], ['start', `${UNIT_NAME}.service`]])
    expect(world.tasks).toEqual([])
    expect(world.spawned[0]).toContain('auto')
    expect(text).toMatch(/systemd user timer .* every 5 minutes/)
    expect(text).toMatch(/loginctl enable-linger/)
    expect(text).not.toMatch(/WSL/)
    // Started again, it goes through systemd too, not as this window's child
    stop(deps)
    await expect(runnerCommand(['start'], { ...deps, insideClaudeCode: true })).resolves.toMatchObject({ code: 0, text: expect.not.stringMatching(/may stop when/) })

    expect(uninstall(deps)).toMatch(/Deleted the systemd timer/)
    expect(world.systemctl).toContainEqual(['disable', '--now', `${UNIT_NAME}.timer`])
    expect(world.files[service]).toBeUndefined()
    expect(world.files[timer]).toBeUndefined()
    expect(world.alive.size).toBe(0)
  })

  it('on WSL, install and the doctor say it runs only while a WSL window is open', async () => {
    const { deps } = fake({ platform: 'linux', wsl: true })
    const text = install(deps)
    expect(text).toMatch(/This is WSL.*use the standing session on Windows/)
    expect(text).not.toMatch(/enable-linger/)
    const home = mkdtempSync(join(tmpdir(), 'quarterdeck-runner-'))
    try {
      mkdirSync(join(home, '.quarterdeck', 'runner'), { recursive: true })
      writeFileSync(join(home, '.quarterdeck', 'runner', 'launch.mjs'), '')
      const o = { repoRoot: home, cwd: home, home, env: {}, nodeVersion: '24.1.0', fetchTimeoutMs: 300 }
      expect(await checkRunner(o, deps)).toMatchObject({ level: 'warn', detail: expect.stringMatching(/WSL stops/), fix: expect.stringMatching(/Windows terminal/) })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('the systemd service leaves the tmux session running when it ends, and finds this Node first', () => {
    const u = systemdUnits({ node: '/opt/node 22/bin/node', launcher: '/home/me/100%/launch.mjs', dir: '/home/me/.quarterdeck/runner', path: '/usr/bin:/opt/node 22/bin:/mnt/c/Program Files (x86)/x' })
    // By default systemd ends what a finished oneshot service left behind: the tmux server with the session (seen Nov 2026)
    expect(u.service).toContain('KillMode=process')
    expect(u.service).toContain('Type=oneshot')
    expect(u.service).toContain('ExecStart="/opt/node 22/bin/node" "/home/me/100%%/launch.mjs"')
    expect(u.service).toContain('Environment="PATH=/opt/node 22/bin:/usr/bin:/mnt/c/Program Files (x86)/x"')
    expect(u.timer).toContain('OnActiveSec=1min')
    expect(u.timer).toContain('WantedBy=timers.target')
    expect(systemdUnits({ node: '/n/node', launcher: '/a$b"c', dir: '/d', path: '' }).service).toContain('"/n/node" "/a$$b\\"c"')
  })

  it('says when the session waits at the folder trust question, and how to answer it', async () => {
    expect(waitingOn(TRUST)).toBe('trust')
    expect(waitingOn('❯ \n /remote-control is active')).toBeNull()
    const { deps, world } = fake({ platform: 'linux' })
    world.enabled = true
    world.screen = TRUST
    const r = startByTask(deps)
    expect(r.text).toMatch(/waiting to be told its folder .* is safe/)
    expect(r.text).toMatch(/quarterdeck runner attach/)
    expect(status(deps).waiting).toBe('trust')
    expect(statusText(status(deps))).toMatch(/no goal runs in it yet/)
    expect(await runnerCommand(['attach'], deps)).toEqual({ text: '', code: 0 })
    expect(world.attached).toBe(1)
    world.screen = '❯ '
    expect(status(deps).waiting).toBeNull()
    stop(deps)
    expect(await runnerCommand(['attach'], deps)).toMatchObject({ code: 1, text: expect.stringMatching(/not running/) })
    // Started directly (no timer yet), it looks too
    world.enabled = false
    world.screen = TRUST
    expect((await runnerCommand(['start'], deps)).text).toMatch(/runner attach/)
  })

  it('start goes through the task once it is installed, and warns when it would be this window\'s child', async () => {
    const { deps, world } = fake({ insideClaudeCode: true })
    expect((await runnerCommand(['start'], deps)).text).toMatch(/may stop when this window closes/)
    stop(deps)
    world.tasks.push(['/create'])
    expect((await runnerCommand(['start', '--permission-mode', 'auto'], deps)).text).not.toMatch(/may stop when/)
    expect(world.tasks.at(-1)).toEqual(['/run', '/tn', TASK_NAME])
    expect(world.spawned.at(-1)).toContain('auto')
  })

  it('the command answers text and an exit code', async () => {
    const { deps } = fake()
    expect(await runnerCommand(['status'], deps)).toMatchObject({ code: 1 })
    expect(await runnerCommand(['start', '--permission-mode', 'auto'], deps)).toMatchObject({ code: 0 })
    expect(await runnerCommand(['status'], deps)).toMatchObject({ code: 0 })
    expect((await runnerCommand([], deps)).text).toMatch(/Usage: quarterdeck runner/)
    expect(await runnerCommand(['nonsense'], deps)).toMatchObject({ code: 1 })
    const broken = fake({ spawnSession: () => { throw new Error('conhost.exe not found\nmore') } }).deps
    expect(await runnerCommand(['start'], broken)).toEqual({ code: 1, text: 'quarterdeck runner: conhost.exe not found' })
  })

  it("install uses auto mode unless told otherwise, and the session starts with Quarterdeck's own tools allowed", () => {
    const { deps, world } = fake()
    const text = install(deps)
    expect(world.spawned[0]).toEqual(expect.arrayContaining(['--permission-mode', 'auto']))
    // Quarterdeck's server under both of its names, as one argument with no spaces
    expect(world.spawned[0]).toEqual(expect.arrayContaining(['--allowedTools', 'mcp__plugin_quarterdeck-goals_quarterdeck,mcp__quarterdeck']))
    expect(world.state).toMatchObject({ permissionMode: 'auto' })
    expect(text).toContain('Permission mode: auto (the default')
    expect(Object.keys(world.files).some((p) => p.includes('settings.json'))).toBe(false)
    // Again with a mode: the running session keeps its own until it restarts
    const again = install(deps, { permissionMode: 'dontAsk' })
    expect(again).toMatch(/keeps its current permission mode until it next restarts/)
    expect(world.state).toMatchObject({ permissionMode: 'dontAsk' })
  })

  it('the doctor reports it only once it is set up', async () => {
    const home = mkdtempSync(join(tmpdir(), 'quarterdeck-runner-'))
    try {
      const o = { repoRoot: home, cwd: home, home, env: {}, nodeVersion: '24.1.0', fetchTimeoutMs: 300 }
      const { deps, world } = fake()
      expect(await checkRunner(o, deps)).toBeNull()
      mkdirSync(join(home, '.quarterdeck', 'runner'), { recursive: true })
      writeFileSync(join(home, '.quarterdeck', 'runner', 'launch.mjs'), '')
      expect(await checkRunner(o, deps)).toMatchObject({ level: 'warn', detail: expect.stringMatching(/^not running/) })
      start(deps)
      expect(await checkRunner(o, deps)).toMatchObject({ level: 'warn', detail: expect.stringMatching(/scheduled task .* is missing/) })
      world.tasks.push(['/create'])
      // No mode of its own, or one that asks: its runs would wait with nobody to answer
      expect(await checkRunner(o, deps)).toMatchObject({ level: 'warn', detail: expect.stringMatching(/no permission mode of its own/) })
      world.state = { ...world.state!, permissionMode: 'manual' }
      expect(await checkRunner(o, deps)).toMatchObject({ level: 'warn', detail: expect.stringMatching(/"manual", which asks/) })
      world.state = { ...world.state!, permissionMode: 'auto' }
      expect(await checkRunner(o, deps)).toMatchObject({ level: 'ok' })
      world.screen = TRUST
      expect(await checkRunner(o, deps)).toMatchObject({ level: 'warn', fix: expect.stringMatching(/runner attach/) })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
