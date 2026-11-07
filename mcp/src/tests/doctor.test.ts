import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  checkNode, checkBuild, checkMcpConfig, checkHooks, checkChannel, checkDatabase, formatResults,
  type DoctorOptions,
} from '../doctor.js'

let dir: string
let o: DoctorOptions

function write(path: string, content: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conductor-doctor-'))
  o = { repoRoot: dir, cwd: dir, home: dir, env: { CONDUCTOR_DB: ':memory:' }, nodeVersion: '24.1.0', fetchTimeoutMs: 300 }
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

    it('fails when the conductor server script does not exist', () => {
      write(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { conductor: { command: 'node', args: ['missing/index.js'] }, 'conductor-channel': {} } }))
      expect(checkMcpConfig(o)[0]).toMatchObject({ level: 'fail', detail: expect.stringContaining('missing/index.js') })
    })

    it('passes and lists enabled flags', () => {
      write(join(dir, 'mcp/dist/index.js'), '')
      write(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: {
        conductor: { command: 'node', args: [join(dir, 'mcp/dist/index.js')], env: { CONDUCTOR_STRICT_COMPLETE: '1' } },
        'conductor-channel': { command: 'node', args: [] },
      } }))
      const [r] = checkMcpConfig(o)
      expect(r).toMatchObject({ level: 'ok', detail: expect.stringContaining('CONDUCTOR_STRICT_COMPLETE') })
    })

    it('warns when conductor-channel is missing', () => {
      write(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { conductor: { command: 'node', args: [] } } }))
      expect(checkMcpConfig(o).some((r) => r.name.includes('conductor-channel') && r.level === 'warn')).toBe(true)
    })
  })

  describe('checkHooks', () => {
    it('warns about the obsolete decompose hook and old tool names', () => {
      write(join(dir, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'python conductor-decompose.py' }] }], UserPromptSubmit: [{ hooks: [{ command: 'mcp__conductor__list_projects' }] }] } }))
      const r = checkHooks(o)
      expect(r.level).toBe('warn')
      expect(r.detail).toMatch(/obsolete decompose hook.*old \*_project/)
    })

    it('passes with current hooks', () => {
      write(join(dir, '.claude/settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'mcp__conductor__update_task' }] }] } }))
      expect(checkHooks(o).level).toBe('ok')
    })
  })

  it('checkChannel warns when the channel server is unreachable', async () => {
    const r = await checkChannel({ ...o, env: { CONDUCTOR_CHANNEL_URL: 'http://127.0.0.1:1' } })
    expect(r).toMatchObject({ level: 'warn', detail: expect.stringContaining('not reachable') })
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
    const opts = { ...o, env: { CONDUCTOR_DB: dbFile } }
    expect(await checkGoals(opts, okR, okR)).toBeNull()

    const core = await import('@conductor/core')
    const db = core.openDatabase(dbFile)
    const now = new Date().toISOString()
    core.createGoal(db, { id: 'g', name: 'Inbox', description: null, status: 'active', working_dir: dir, created_at: now, updated_at: now }, { objective: 'x' })
    db.close()

    expect(await checkGoals(opts, okR, okR)).toMatchObject({ level: 'ok', detail: expect.stringContaining('Inbox') })
    expect(await checkGoals(opts, warnR, okR)).toMatchObject({ level: 'warn', detail: expect.stringContaining('channel-connected Claude Code') })
  })
})
