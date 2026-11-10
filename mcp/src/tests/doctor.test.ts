import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  checkNode, checkBuild, checkMcpConfig, checkHooks, checkPlugin, checkDatabase, checkUserScope, checkRenameLeftovers, nativeLoadProblem, formatResults,
  type DoctorOptions,
} from '../doctor.js'

let dir: string
let o: DoctorOptions

function write(path: string, content: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quarterdeck-doctor-'))
  o = { repoRoot: dir, cwd: dir, home: dir, env: { QUARTERDECK_DB: ':memory:' }, nodeVersion: '24.1.0', fetchTimeoutMs: 300 }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('doctor', () => {
  it('checkNode fails below Node 22', () => {
    expect(checkNode(o).level).toBe('ok')
    expect(checkNode({ ...o, nodeVersion: '20.11.0' })).toMatchObject({ level: 'fail' })
  })

  it('checkDatabase opens and migrates the database', async () => {
    const results = await checkDatabase(o)
    expect(results.map((r) => [r.name, r.level])).toEqual([
      ['SQLite native module', 'ok'], ['Database', 'ok'], ['Schema', 'ok'],
    ])
  })

  describe('checkBuild', () => {
    it('fails when the build is missing', () => {
      write(join(dir, 'mcp/src/index.ts'), '')
      expect(checkBuild(o, 'mcp')).toMatchObject({ level: 'fail', fix: expect.stringContaining('npm run build --prefix mcp') })
    })

    it('warns when sources are newer than the build', () => {
      write(join(dir, 'core/dist/index.js'), '')
      write(join(dir, 'core/src/index.ts'), '')
      const old = new Date(Date.now() - 60_000)
      utimesSync(join(dir, 'core/dist/index.js'), old, old)
      expect(checkBuild(o, 'core').level).toBe('warn')
    })

    it('ignores test files when checking staleness', () => {
      write(join(dir, 'core/src/index.ts'), '')
      const old = new Date(Date.now() - 60_000)
      utimesSync(join(dir, 'core/src/index.ts'), old, old)
      write(join(dir, 'core/dist/index.js'), '')
      write(join(dir, 'core/src/x.test.ts'), '')
      expect(checkBuild(o, 'core').level).toBe('ok')
    })
  })

  describe('checkMcpConfig', () => {
    it('warns when .mcp.json is missing', () => {
      expect(checkMcpConfig(o)[0].level).toBe('warn')
    })

    it('fails on invalid JSON', () => {
      write(join(dir, '.mcp.json'), '{ nope')
      expect(checkMcpConfig(o)[0].level).toBe('fail')
    })

    it('fails when the quarterdeck server script does not exist', () => {
      write(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { quarterdeck: { command: 'node', args: ['missing/index.js'] } } }))
      expect(checkMcpConfig(o)[0]).toMatchObject({ level: 'fail', detail: expect.stringContaining('missing/index.js') })
    })

    it('passes and lists enabled flags', () => {
      write(join(dir, 'mcp/dist/index.js'), '')
      write(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: {
        quarterdeck: { command: 'node', args: [join(dir, 'mcp/dist/index.js')], env: { QUARTERDECK_STRICT_COMPLETE: '1' } },
      } }))
      const [r] = checkMcpConfig(o)
      expect(r).toMatchObject({ level: 'ok', detail: expect.stringContaining('QUARTERDECK_STRICT_COMPLETE') })
    })

    it('warns about a leftover conductor-channel entry', () => {
      write(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { quarterdeck: { command: 'node', args: [] } } }))
      expect(checkMcpConfig(o).some((r) => r.name.includes('conductor-channel'))).toBe(false)
      write(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { quarterdeck: { command: 'node', args: [] }, 'conductor-channel': { command: 'node', args: [] } } }))
      expect(checkMcpConfig(o).some((r) => r.name.includes('conductor-channel') && r.level === 'warn')).toBe(true)
    })
  })

  describe('checkUserScope', () => {
    it('warns until quarterdeck is added for the user, with the command', () => {
      expect(checkUserScope(o)).toMatchObject({ level: 'warn', fix: expect.stringContaining('claude mcp add --scope user quarterdeck -- node ') })
      write(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { quarterdeck: { command: 'node', args: ['x.js'] } } }))
      expect(checkUserScope(o)).toMatchObject({ level: 'ok' })
    })
  })

  describe('checkHooks', () => {
    it('warns about the obsolete decompose hook and the retired plan reminders', () => {
      write(join(dir, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'python conductor-decompose.py' }] }], Stop: [{ hooks: [{ command: 'mcp__conductor__update_task' }] }] } }))
      const r = checkHooks(o)
      expect(r.level).toBe('warn')
      expect(r.detail).toMatch(/obsolete decompose hook.*retired plan reminder/)
    })

    it('passes with no hooks, and warns about the old goal-guard hook', () => {
      expect(checkHooks(o).level).toBe('ok')
      write(join(dir, '.claude/settings.json'), JSON.stringify({ hooks: {} }))
      expect(checkHooks(o)).toMatchObject({ level: 'ok', detail: 'up to date (none needed)' })
      write(join(dir, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'node goal-guard.js' }] }] } }))
      expect(checkHooks(o)).toMatchObject({ level: 'warn', detail: expect.stringContaining('old goal-guard hook') })
    })
  })

  describe('checkRenameLeftovers', () => {
    it('is quiet when nothing is left from Conductor', () => {
      expect(checkRenameLeftovers({ ...o, env: {} })).toBeNull()
    })

    it('names the old data folder, server entries and plugins, with fixes', () => {
      write(join(dir, '.conductor/tasks.db'), '')
      write(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { conductor: { command: 'node' } } }))
      write(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { conductor: { command: 'node' } } }))
      write(join(dir, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'conductor-goals@conductor': true } }))
      const r = checkRenameLeftovers({ ...o, env: {} })
      expect(r?.level).toBe('warn')
      expect(r?.detail).toMatch(/~\/\.conductor.*user.*\.mcp\.json.*conductor-goals@conductor/)
      expect(r?.fix).toMatch(/~\/\.quarterdeck.*claude mcp remove --scope user conductor.*claude plugin uninstall conductor-goals@conductor/)
    })

    it('ignores the old data folder once the new one exists or a path is set', () => {
      write(join(dir, '.conductor/tasks.db'), '')
      expect(checkRenameLeftovers(o)).toBeNull()
      write(join(dir, '.quarterdeck/tasks.db'), '')
      expect(checkRenameLeftovers({ ...o, env: {} })).toBeNull()
    })
  })

  describe('checkPlugin', () => {
    it('warns with install steps when the plugin is not installed', () => {
      expect(checkPlugin(o)).toMatchObject({ level: 'warn', fix: expect.stringContaining('claude plugin install quarterdeck-goals@quarterdeck') })
    })

    it('warns when it is disabled, and until the guard plugin is enabled too', () => {
      write(join(dir, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'quarterdeck-goals@quarterdeck': false } }))
      expect(checkPlugin(o)).toMatchObject({ level: 'warn', fix: expect.stringContaining('claude plugin enable') })
      write(join(dir, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'quarterdeck-goals@quarterdeck': true } }))
      expect(checkPlugin(o)).toMatchObject({ level: 'warn', detail: expect.stringContaining('goal runs are paused'), fix: expect.stringContaining('quarterdeck-guard@quarterdeck') })
      write(join(dir, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'quarterdeck-goals@quarterdeck': true, 'quarterdeck-guard@quarterdeck': true } }))
      expect(checkPlugin(o).level).toBe('ok')
  })
  })


  it('formatResults summarises problems', () => {
    const text = formatResults([
      { name: 'A', level: 'ok', detail: 'fine' },
      { name: 'B', level: 'fail', detail: 'broken', fix: 'do x' },
    ])
    expect(text).toContain('[FAIL] B: broken')
    expect(text).toContain('fix: do x')
    expect(text).toContain('1 problem(s) to fix')
  })
})

describe('checkGoals', () => {
  it('is silent without active goals and warns when goals cannot run', async () => {
    const { checkGoals } = await import('../doctor.js')
    const okR = { name: 'x', level: 'ok' as const, detail: '' }
    const warnR = { name: 'x', level: 'warn' as const, detail: '' }
    const dbFile = join(dir, 'goals.db')
    const opts = { ...o, env: { QUARTERDECK_DB: dbFile } }
    expect(await checkGoals(opts, okR)).toBeNull()

    const core = await import('@quarterdeck/core')
    const db = core.openDatabase(dbFile)
    const now = new Date().toISOString()
    core.createGoal(db, { id: 'g', name: 'Inbox', description: null, status: 'active', working_dir: dir, created_at: now, updated_at: now }, { objective: 'x' })
    db.close()

    expect(await checkGoals(opts, okR)).toMatchObject({ level: 'ok', detail: expect.stringContaining('Inbox') })
    expect(await checkGoals(opts, { ...warnR, detail: 'quarterdeck-guard@quarterdeck not installed' })).toMatchObject({ level: 'warn', detail: expect.stringContaining('quarterdeck-guard') })
  })
})

describe('nativeLoadProblem', () => {
  it('tells a version mismatch from a native part that was never built', () => {
    expect(nativeLoadProblem('was compiled against a different Node.js version using NODE_MODULE_VERSION 127')?.fix).toContain('npm rebuild better-sqlite3')
    expect(nativeLoadProblem('Could not locate the bindings file. Tried: .../better_sqlite3.node')?.fix).toContain('npm install-scripts approve better-sqlite3')
    expect(nativeLoadProblem("Cannot find module '@quarterdeck/core'")).toBeNull()
  })
})
