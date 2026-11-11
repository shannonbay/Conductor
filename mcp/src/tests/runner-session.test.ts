import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ensure, install, runnerCommand, start, startArgs, startByTask, status, statusText, stop, taskXml, uninstall, SESSION_NAME, TASK_NAME,
  type InstallDeps, type RunnerState,
} from '../runner-session.js'
import { checkRunner } from '../doctor.js'

const DIR = 'C:\\Users\\me\\.quarterdeck\\runner'

/** A fake computer: started sessions are process ids in `alive`; running the scheduled task runs `ensure`, as Task Scheduler would. */
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
    expect(world.spawned).toEqual([['--remote-control', SESSION_NAME, '--name', SESSION_NAME, '--session-id', 'session-1']])
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

  it('status says who starts goal runs', () => {
    const { deps, world } = fake()
    expect(statusText(status(deps))).toMatch(/not running/)
    start(deps)
    world.holder = 'session-1'
    expect(status(deps)).toMatchObject({ running: true, holdsLease: true, leaseElsewhere: false, stale: false })
    world.holder = 'a-window'
    expect(statusText(status(deps))).toMatch(/an open Claude Code window is starting goal runs/)
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

  it('install needs the built CLI, and Windows', () => {
    expect(() => install(fake({ cliPath: null }).deps)).toThrow(/built CLI/)
    expect(() => install(fake({ platform: 'linux' }).deps)).toThrow(/Windows only/)
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
      expect(await checkRunner(o, deps)).toMatchObject({ level: 'ok' })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
