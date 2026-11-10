import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ensure, install, runnerCommand, start, startArgs, status, statusText, stop, taskXml, uninstall, SESSION_NAME, TASK_NAME,
  type AgentRow, type InstallDeps, type RunnerState,
} from '../runner-session.js'
import { checkRunner } from '../doctor.js'

const DIR = 'C:\\Users\\me\\.quarterdeck\\runner'

/** A fake Claude Code: `--bg` adds a background session in the folder it is started in, `stop` and `rm` remove one. */
function fake(over: Partial<InstallDeps> = {}) {
  const world = {
    rows: [
      { pid: 1, cwd: 'C:\\Users\\me\\GitHub\\app', kind: 'interactive', sessionId: 'aaaaaaaa-0000', name: 'app', status: 'idle' },
    ] as AgentRow[],
    calls: [] as string[][],
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
    claude: (args, cwd) => {
      world.calls.push(args)
      if (args[0] === 'agents') return JSON.stringify(world.rows)
      if (args[0] === '--bg') {
        const n = ++world.made
        world.rows.push({ pid: 100 + n, id: `bg00000${n}`, cwd: cwd!.replace(/\\/g, '/').toUpperCase(), kind: 'background', sessionId: `bg00000${n}-1111`, name: SESSION_NAME, status: 'idle' })
        return 'backgrounded'
      }
      if (args[0] === 'stop' || args[0] === 'rm') {
        world.rows = world.rows.filter((r) => r.id !== args[1])
        return 'stopped'
      }
      throw new Error(`unexpected: claude ${args.join(' ')}`)
    },
    runsRunning: () => world.running,
    leaseHolder: () => world.holder,
    readState: () => world.state,
    writeState: (s) => { world.state = s },
    platform: 'win32',
    cliPath: 'C:\\plugins\\quarterdeck-goals\\0.14.0\\server\\quarterdeck-cli.mjs',
    user: 'PC\\me',
    node: 'C:\\Program Files\\nodejs\\node.exe',
    writeFile: (path, content) => { world.files[path] = content },
    removeFile: (path) => { delete world.files[path] },
    schtasks: (args) => {
      world.tasks.push(args)
      if (args[0] === '/query' && !world.tasks.some((t) => t[0] === '/create')) throw new Error('ERROR: The system cannot find the file specified.')
      return 'SUCCESS'
    },
    ...over,
  }
  return { deps, world }
}

const started = (world: { calls: string[][] }) => world.calls.filter((c) => c[0] === '--bg')

describe('the standing session', () => {
  it('starts in its folder with Remote Control on, and remembers the session and build', () => {
    const { deps, world } = fake()
    const r = start(deps)
    expect(r.started).toBe(true)
    expect(started(world)).toEqual([['--bg', '--remote-control', SESSION_NAME, '--name', SESSION_NAME]])
    expect(world.state).toEqual({ sessionId: 'bg000001-1111', build: '0.14.0+1' })
    // A second start leaves the live one alone (its folder is matched whatever the case and slashes)
    expect(start(deps).started).toBe(false)
    expect(started(world)).toHaveLength(1)
  })

  it('keeps a permission mode for later starts, and refuses an unknown one', () => {
    const { deps, world } = fake()
    start(deps, { permissionMode: 'auto' })
    expect(startArgs('auto').slice(-2)).toEqual(['--permission-mode', 'auto'])
    stop(deps)
    start(deps)
    expect(started(world)[1]).toContain('auto')
    expect(() => start(fake().deps, { permissionMode: 'yolo' })).toThrow(/Unknown permission mode/)
  })

  it('clears a session that died before starting a new one', () => {
    const { deps, world } = fake()
    world.rows.push({ id: 'dead0001', cwd: DIR, kind: 'background', sessionId: 'dead0001-2222', state: 'blocked' })
    start(deps)
    expect(world.calls).toContainEqual(['rm', 'dead0001'])
    expect(world.rows.filter((r) => r.kind === 'background')).toHaveLength(1)
  })

  it('ensure starts a missing session and leaves a live one alone', () => {
    const { deps, world } = fake()
    expect(ensure(deps).action).toBe('started')
    expect(ensure(deps).action).toBe('running')
    expect(started(world)).toHaveLength(1)
  })

  it('ensure restarts after an update, but only when no run is going', () => {
    const { deps, world } = fake()
    ensure(deps)
    const updated = { ...deps, build: '0.15.0+2' }
    world.running = 1
    expect(ensure(updated).action).toBe('restart-waits')
    expect(started(world)).toHaveLength(1)
    world.running = 0
    expect(ensure(updated).action).toBe('restarted')
    expect(world.state).toEqual({ sessionId: 'bg000002-1111', build: '0.15.0+2' })
    expect(world.rows.filter((r) => r.kind === 'background')).toHaveLength(1)
    expect(ensure(updated).action).toBe('running')
  })

  it('ensure takes a session started by hand as it is', () => {
    const { deps, world } = fake()
    world.rows.push({ pid: 7, id: 'hand0001', cwd: DIR, kind: 'background', sessionId: 'hand0001-3333', status: 'idle' })
    expect(ensure(deps).action).toBe('running')
    expect(world.state?.sessionId).toBe('hand0001-3333')
    expect(started(world)).toHaveLength(0)
  })

  it('status says who starts goal runs', () => {
    const { deps, world } = fake()
    expect(statusText(status(deps))).toMatch(/not running/)
    start(deps)
    world.holder = 'bg000001-1111'
    expect(status(deps)).toMatchObject({ running: true, holdsLease: true, leaseElsewhere: false, stale: false })
    world.holder = 'aaaaaaaa-0000'
    expect(statusText(status(deps))).toMatch(/an open Claude Code window is starting goal runs/)
    expect(status({ ...deps, build: 'newer' }).stale).toBe(true)
  })

  it('install writes the launcher and the task, then starts; uninstall undoes it', () => {
    const { deps, world } = fake()
    const text = install(deps)
    expect(world.files[join(DIR, 'launch.mjs')]).toMatch(/runner', 'ensure'/)
    expect(world.files[join(DIR, 'cli-path')]).toBe(deps.cliPath)
    expect(world.tasks[0]).toEqual(['/create', '/tn', TASK_NAME, '/xml', join(DIR, 'task.xml'), '/f'])
    expect(world.files[join(DIR, 'task.xml')]!.startsWith('\ufeff<?xml')).toBe(true)
    expect(started(world)).toHaveLength(1)
    expect(text).toMatch(/no Claude Code window open/)

    expect(uninstall(deps)).toMatch(/Deleted the scheduled task/)
    expect(world.tasks.at(-1)).toEqual(['/delete', '/tn', TASK_NAME, '/f'])
    expect(world.files[join(DIR, 'launch.mjs')]).toBeUndefined()
    expect(world.rows.filter((r) => r.kind === 'background')).toHaveLength(0)
  })

  it('the task runs at logon and every 15 minutes, as the person, on battery too, with no window', () => {
    const x = taskXml({ user: 'PC\\me', node: 'C:\\Program Files\\nodejs\\node.exe', launcher: 'C:\\Users\\R&D\\launch.mjs', now: new Date('2026-11-11T02:03:04Z') })
    expect(x).toContain('<LogonTrigger>')
    expect(x).toContain('<Interval>PT15M</Interval>')
    expect(x).toContain('<UserId>PC\\me</UserId>')
    expect(x).toContain('<LogonType>InteractiveToken</LogonType>')
    expect(x).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>')
    expect(x).toContain('<Command>conhost.exe</Command>')
    expect(x).toContain('--headless "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\R&amp;D\\launch.mjs"')
    expect(x).toContain('<StartBoundary>2026-11-10T02:03:04</StartBoundary>')
  })

  it('install needs the built CLI, and other systems get a crontab line', () => {
    expect(() => install(fake({ cliPath: null }).deps)).toThrow(/built CLI/)
    const { deps, world } = fake({ platform: 'linux', node: '/usr/bin/node', dir: '/home/me/.quarterdeck/runner' })
    expect(install(deps)).toMatch(/\*\/15 \* \* \* \* "\/usr\/bin\/node" ".*launch\.mjs"/)
    expect(world.tasks).toHaveLength(0)
  })

  it('the command answers text and an exit code', async () => {
    const { deps } = fake()
    expect(await runnerCommand(['status'], deps)).toMatchObject({ code: 1 })
    expect(await runnerCommand(['start', '--permission-mode', 'auto'], deps)).toMatchObject({ code: 0 })
    expect(await runnerCommand(['status'], deps)).toMatchObject({ code: 0 })
    expect((await runnerCommand([], deps)).text).toMatch(/Usage: quarterdeck runner/)
    expect(await runnerCommand(['nonsense'], deps)).toMatchObject({ code: 1 })
    const broken = fake({ claude: () => { throw new Error('claude: command not found\nmore') } }).deps
    expect(await runnerCommand(['status'], broken)).toEqual({ code: 1, text: "quarterdeck runner: Couldn't list Claude Code sessions (claude agents --json): claude: command not found" })
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
