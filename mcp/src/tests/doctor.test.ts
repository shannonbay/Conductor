import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  checkNode, checkBuild, checkBundle, checkServerSetup, checkPermissionRules, checkUpdates, checkHooks, checkPlugin, checkDatabase, checkRenameLeftovers, formatResults,
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
  it('checkNode fails below Node 22.13 (node:sqlite without a flag)', () => {
    expect(checkNode(o).level).toBe('ok')
    expect(checkNode({ ...o, nodeVersion: '22.13.0' }).level).toBe('ok')
    expect(checkNode({ ...o, nodeVersion: '22.12.0' })).toMatchObject({ level: 'fail' })
    expect(checkNode({ ...o, nodeVersion: '20.11.0' })).toMatchObject({ level: 'fail' })
  })

  it('checkDatabase opens and migrates the database', async () => {
    const results = await checkDatabase(o)
    expect(results.map((r) => [r.name, r.level])).toEqual([['Database', 'ok'], ['Schema', 'ok']])
    expect(results[1].detail).toMatch(/version \d+/)
  })

  it('checkDatabase warns when a newer Quarterdeck has upgraded the database', async () => {
    const core = await import('@quarterdeck/core')
    const dbFile = join(dir, 'newer.db')
    const db = core.openDatabase(dbFile)
    db.exec(`PRAGMA user_version = ${core.SCHEMA_VERSION + 1}`)
    db.close()
    const schema = (await checkDatabase({ ...o, env: { QUARTERDECK_DB: dbFile } })).find((r) => r.name === 'Schema')
    expect(schema).toMatchObject({ level: 'warn', fix: expect.stringContaining('/reload-plugins') })
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

  describe('checkBundle', () => {
    it('fails without the bundle and warns when sources are newer', () => {
      write(join(dir, 'mcp/src/index.ts'), '')
      write(join(dir, 'core/src/index.ts'), '')
      expect(checkBundle(o)).toMatchObject({ level: 'fail', fix: expect.stringContaining('npm run build --prefix mcp') })
      const bundle = join(dir, 'plugins/quarterdeck-goals/server/quarterdeck-mcp.mjs')
      write(bundle, '')
      expect(checkBundle(o).level).toBe('ok')
      const old = new Date(Date.now() - 60_000)
      utimesSync(bundle, old, old)
      expect(checkBundle(o).level).toBe('warn')
    })
  })

  describe('checkServerSetup', () => {
    const enable = () => write(join(dir, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'quarterdeck-goals@quarterdeck': true } }))

    it('is ok when only the plugin provides the server', () => {
      enable()
      expect(checkServerSetup(o)).toEqual([expect.objectContaining({ level: 'ok', detail: expect.stringContaining('plugin') })])
    })

    it('warns about a second copy set up by hand, with how to remove it', () => {
      enable()
      write(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { quarterdeck: { command: 'node', args: ['x.js'] } } }))
      expect(checkServerSetup(o)[0]).toMatchObject({ level: 'warn', detail: expect.stringContaining('two copies'), fix: expect.stringContaining('claude mcp remove --scope user quarterdeck') })
    })

    it('warns that a hand-added server without the plugin does not update', () => {
      write(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { quarterdeck: { command: 'node', args: [] } } }))
      expect(checkServerSetup(o)[0]).toMatchObject({ level: 'warn', detail: expect.stringContaining("doesn't update") })
    })

    it('says nothing when neither is set up (checkPlugin covers it)', () => {
      expect(checkServerSetup(o)).toEqual([])
    })

    it('warns about a leftover conductor-channel entry', () => {
      write(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { 'conductor-channel': { command: 'node', args: [] } } }))
      expect(checkServerSetup(o).some((r) => r.name.includes('conductor-channel') && r.level === 'warn')).toBe(true)
    })
  })

  describe('checkPermissionRules', () => {
    it('warns about rules for the old tool names once the plugin provides the server', () => {
      write(join(dir, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['mcp__quarterdeck__goals_overview'] } }))
      expect(checkPermissionRules(o)).toBeNull() // plugin not enabled: the old names are still right
      write(join(dir, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'quarterdeck-goals@quarterdeck': true }, permissions: { allow: ['mcp__quarterdeck__goals_overview'] } }))
      expect(checkPermissionRules(o)).toMatchObject({ level: 'warn', detail: expect.stringContaining('mcp__plugin_quarterdeck-goals_quarterdeck__') })
    })
  })

  describe('checkUpdates', () => {
    const known = (entry: unknown) => write(join(dir, '.claude/plugins/known_marketplaces.json'), JSON.stringify({ quarterdeck: entry }))

    it('is silent without the marketplace, ok for a local folder', () => {
      expect(checkUpdates(o)).toBeNull()
      known({ source: { source: 'directory', path: '/src/Quarterdeck' } })
      expect(checkUpdates(o)).toMatchObject({ level: 'ok', detail: expect.stringContaining('local folder') })
    })

    it('warns until auto-update is on for a GitHub marketplace', () => {
      known({ source: { source: 'github', repo: 'shannonbay/Quarterdeck' } })
      expect(checkUpdates(o)).toMatchObject({ level: 'warn', fix: expect.stringContaining('Enable auto-update') })
      known({ source: { source: 'github', repo: 'shannonbay/Quarterdeck' }, autoUpdate: true })
      expect(checkUpdates(o)?.level).toBe('ok')
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
      expect(checkPlugin(o)).toMatchObject({ level: 'warn', fix: expect.stringMatching(/marketplace add shannonbay\/Quarterdeck#release.*claude plugin install quarterdeck-goals@quarterdeck/) })
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
