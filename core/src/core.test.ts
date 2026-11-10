import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  openDatabase, runMigrations, insertPlan, insertTask, updateTask, updatePlan, touchPlan,
  deleteTaskTree, getPlanRevision, getTask, getChildren, getSiblings, nextChildId,
  insertVerification, getVerifications, getLatestVerification, REVISION_TRIGGERS,
  createGoal, getGoal, envVar, defaultDbPath, type NewTask,
} from './index.js'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const now = '2026-01-01T00:00:00.000Z'

function plan(id = 'p1') {
  return { id, name: 'P', description: null, status: 'active' as const, working_dir: '/tmp', created_at: now, updated_at: now }
}

function task(id: string, planId = 'p1'): NewTask {
  return { id, plan_id: planId, goal: `Task ${id}`, status: 'pending', result: null, abandon_reason: null, state: {}, depends_on: null, created_at: now, updated_at: now }
}

let db: Database.Database
beforeEach(() => { db = openDatabase(':memory:') })

describe('runMigrations', () => {
  it('is idempotent', () => {
    expect(() => { runMigrations(db); runMigrations(db) }).not.toThrow()
  })

  it('upgrades a database created by the old standalone MCP schema', () => {
    const legacy = new Database(':memory:')
    legacy.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT NOT NULL, project_id TEXT NOT NULL, goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', result TEXT, abandon_reason TEXT,
        state TEXT NOT NULL DEFAULT '{}', depends_on TEXT, plan TEXT, step INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (id, project_id));
      INSERT INTO projects VALUES ('p1', 'Old', NULL, 'active', '${now}', '${now}');
      INSERT INTO tasks (id, project_id, goal, created_at, updated_at) VALUES ('1', 'p1', 'root', '${now}', '${now}');
    `)
    runMigrations(legacy)

    const t = getTask(legacy, 'p1', '1')!
    expect(t.goal).toBe('root')
    expect(t.notes).toBeNull()
    expect(t.requires_approval).toBe(false)
    const cols = (legacy.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).not.toContain('plan')
    expect(cols).toContain('locked_by')
    expect(getPlanRevision(legacy, 'p1')).toBe(0)
    expect((legacy.prepare('SELECT working_dir FROM plans').get() as { working_dir: string }).working_dir).toBe('(unknown)')
  })

  it('moves goal tool maps from the old conductor server name to quarterdeck', () => {
    createGoal(db, { ...plan('g1'), kind: 'goal' }, { objective: 'Inbox' })
    db.prepare('UPDATE goals SET tool_map = ? WHERE plan_id = ?')
      .run(JSON.stringify({ mcp__conductor__unsubscribe_one_click: 'email.unsubscribe', 'mcp__claude_ai_Gmail__*': 'email.delete' }), 'g1')
    runMigrations(db)
    runMigrations(db)
    expect(getGoal(db, 'g1')!.tool_map).toEqual({ mcp__quarterdeck__unsubscribe_one_click: 'email.unsubscribe', 'mcp__claude_ai_Gmail__*': 'email.delete' })
  })
})

describe('settings from before the rename', () => {
  it('envVar prefers QUARTERDECK_ and falls back to CONDUCTOR_', () => {
    expect(envVar('DB', { CONDUCTOR_DB: 'old' })).toBe('old')
    expect(envVar('DB', { CONDUCTOR_DB: 'old', QUARTERDECK_DB: 'new' })).toBe('new')
    expect(envVar('DB', {})).toBeUndefined()
  })

  it('defaultDbPath uses ~/.conductor only while ~/.quarterdeck has no database', () => {
    const home = mkdtempSync(join(tmpdir(), 'quarterdeck-home-'))
    try {
      expect(defaultDbPath({}, home)).toBe(join(home, '.quarterdeck', 'tasks.db'))
      mkdirSync(join(home, '.conductor'))
      writeFileSync(join(home, '.conductor', 'tasks.db'), '')
      expect(defaultDbPath({}, home)).toBe(join(home, '.conductor', 'tasks.db'))
      mkdirSync(join(home, '.quarterdeck'))
      writeFileSync(join(home, '.quarterdeck', 'tasks.db'), '')
      expect(defaultDbPath({}, home)).toBe(join(home, '.quarterdeck', 'tasks.db'))
      expect(defaultDbPath({ QUARTERDECK_DB: ':memory:' }, home)).toBe(':memory:')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('plan revision triggers', () => {
  beforeEach(() => insertPlan(db, plan()))

  it('starts at 0', () => {
    expect(getPlanRevision(db, 'p1')).toBe(0)
  })

  it('bumps on task insert, update and delete', () => {
    insertTask(db, task('1'))
    const afterInsert = getPlanRevision(db, 'p1')!
    expect(afterInsert).toBeGreaterThan(0)

    updateTask(db, 'p1', '1', { status: 'active' })
    const afterUpdate = getPlanRevision(db, 'p1')!
    expect(afterUpdate).toBeGreaterThan(afterInsert)

    deleteTaskTree(db, 'p1', '1')
    expect(getPlanRevision(db, 'p1')!).toBeGreaterThan(afterUpdate)
  })

  it('bumps on plan-level changes', () => {
    updatePlan(db, 'p1', { status: 'archived' })
    expect(getPlanRevision(db, 'p1')).toBe(1)
    touchPlan(db, 'p1')
    expect(getPlanRevision(db, 'p1')).toBe(2)
  })

  it('only bumps the plan that changed', () => {
    insertPlan(db, plan('p2'))
    insertTask(db, task('1', 'p2'))
    expect(getPlanRevision(db, 'p1')).toBe(0)
  })
})

describe('gate fields and verifications', () => {
  beforeEach(() => insertPlan(db, plan()))

  it('round-trips gate fields on a task', () => {
    insertTask(db, { ...task('1'), acceptance_criteria: ['a', 'b'], verify_command: 'npm test', verify_timeout_s: 60, requires_approval: true })
    const t = getTask(db, 'p1', '1')!
    expect(t).toMatchObject({ acceptance_criteria: ['a', 'b'], verify_command: 'npm test', verify_timeout_s: 60, requires_approval: true, review_requested_at: null })
    updateTask(db, 'p1', '1', { acceptance_criteria: [], verify_command: null })
    expect(getTask(db, 'p1', '1')).toMatchObject({ acceptance_criteria: null, verify_command: null })
  })

  it('defaults gate fields to empty', () => {
    insertTask(db, task('1'))
    expect(getTask(db, 'p1', '1')).toMatchObject({ acceptance_criteria: null, verify_command: null, verify_timeout_s: null, requires_approval: false })
  })

  it('stores verifications newest first and bumps the plan revision', () => {
    insertTask(db, task('1'))
    const before = getPlanRevision(db, 'p1')!
    insertVerification(db, { plan_id: 'p1', task_id: '1', gate: 'command', passed: false, actor: 'agent', command: 'x', exit_code: 1, output: 'boom', created_at: '2026-01-01T00:00:01Z' })
    insertVerification(db, { plan_id: 'p1', task_id: '1', gate: 'criteria', passed: true, actor: 'agent', evidence: ['e1'], created_at: '2026-01-01T00:00:02Z' })
    expect(getPlanRevision(db, 'p1')!).toBeGreaterThan(before)
    const all = getVerifications(db, 'p1', '1')
    expect(all.map((v) => v.gate)).toEqual(['criteria', 'command'])
    expect(all[0]).toMatchObject({ passed: true, evidence: ['e1'] })
    expect(getLatestVerification(db, 'p1', '1', 'command')).toMatchObject({ passed: false, exit_code: 1, output: 'boom' })
  })

  it('creates every revision trigger', () => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]).map((r) => r.name)
    for (const t of REVISION_TRIGGERS) expect(names).toContain(t)
  })
})

describe('tree queries', () => {
  beforeEach(() => {
    insertPlan(db, plan())
    for (const id of ['1', '2', '1.1', '1.2', '1.1.1']) insertTask(db, task(id))
  })

  it('getChildren returns direct children only', () => {
    expect(getChildren(db, 'p1', '1').map((t) => t.id).sort()).toEqual(['1.1', '1.2'])
    expect(getChildren(db, 'p1', '').map((t) => t.id).sort()).toEqual(['1', '2'])
  })

  it('getSiblings works at root and nested levels', () => {
    expect(getSiblings(db, 'p1', '1').map((t) => t.id)).toEqual(['2'])
    expect(getSiblings(db, 'p1', '1.2').map((t) => t.id)).toEqual(['1.1'])
  })

  it('nextChildId skips gaps', () => {
    deleteTaskTree(db, 'p1', '1.1')
    expect(nextChildId(db, 'p1', '1')).toBe('1.3')
    expect(nextChildId(db, 'p1', null)).toBe('3')
  })
})
