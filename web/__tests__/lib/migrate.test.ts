import { describe, it, expect } from 'vitest'
import { getDb } from '@/lib/db.js'

describe('migrate', () => {
  it('adds new columns to the tasks table', () => {
    const db = getDb()
    const info = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
    const cols = info.map((c) => c.name)
    expect(cols).toContain('locked_by')
    expect(cols).toContain('locked_at')
    expect(cols).toContain('requires_approval')
    expect(cols).toContain('approved_by')
    expect(cols).toContain('approved_at')
    expect(cols).toContain('created_by')
    expect(cols).toContain('assigned_to')
    expect(cols).toContain('notes')
  })

  it('creates agent_sessions table with correct schema', () => {
    const db = getDb()
    const info = db.prepare("PRAGMA table_info(agent_sessions)").all() as { name: string }[]
    const cols = info.map((c) => c.name)
    expect(cols).toContain('id')
    expect(cols).toContain('project_id')
    expect(cols).toContain('root_task_id')
    expect(cols).toContain('status')
    expect(cols).toContain('autonomy_level')
    expect(cols).toContain('model')
    expect(cols).toContain('input_tokens')
    expect(cols).toContain('output_tokens')
    expect(cols).toContain('total_cost')
    expect(cols).toContain('started_at')
    expect(cols).toContain('ended_at')
  })

  it('creates events table with correct schema', () => {
    const db = getDb()
    const info = db.prepare("PRAGMA table_info(events)").all() as { name: string }[]
    const cols = info.map((c) => c.name)
    expect(cols).toContain('id')
    expect(cols).toContain('project_id')
    expect(cols).toContain('task_id')
    expect(cols).toContain('event_type')
    expect(cols).toContain('actor')
    expect(cols).toContain('session_id')
    expect(cols).toContain('payload')
    expect(cols).toContain('created_at')
  })

  it('is idempotent — running twice does not error', async () => {
    const { runMigrations } = await import('@/lib/migrate.js')
    const db = getDb()
    expect(() => runMigrations(db)).not.toThrow()
    expect(() => runMigrations(db)).not.toThrow()
  })
})
