import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from './sqlite.js'

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

function mem(): Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
  return db
}

describe('sqlite layer', () => {
  it('binds positional and bare named parameters and ignores extra keys', () => {
    const db = mem()
    const r = db.prepare('INSERT INTO t (name) VALUES (@name)').run({ name: 'a', unused: 1 })
    expect(r).toEqual({ changes: 1, lastInsertRowid: 1 })
    db.prepare('INSERT INTO t (name) VALUES (?)').run('b')
    expect(db.prepare('SELECT name FROM t WHERE id = ?').get(2)).toEqual({ name: 'b' })
    expect(db.prepare('SELECT name FROM t ORDER BY id').all()).toEqual([{ name: 'a' }, { name: 'b' }])
    expect(db.prepare('SELECT name FROM t WHERE id = 9').get()).toBeUndefined()
  })

  it('returns plain objects', () => {
    const db = mem()
    db.prepare('INSERT INTO t (name) VALUES (?)').run('a')
    expect(Object.getPrototypeOf(db.prepare('SELECT * FROM t').get())).toBe(Object.prototype)
  })

  it('commits a transaction and rolls it back on throw', () => {
    const db = mem()
    const insert = db.prepare('INSERT INTO t (name) VALUES (?)')
    db.transaction(() => { insert.run('kept') })()
    expect(() => db.transaction(() => { insert.run('lost'); throw new Error('boom') })()).toThrow('boom')
    expect(db.prepare('SELECT name FROM t').all()).toEqual([{ name: 'kept' }])
  })

  it('nests with savepoints: an inner throw caught by the outer keeps the outer work', () => {
    const db = mem()
    const insert = db.prepare('INSERT INTO t (name) VALUES (?)')
    const inner = db.transaction(() => { insert.run('inner'); throw new Error('inner') })
    const result = db.transaction(() => {
      insert.run('outer')
      try { inner() } catch { /* expected */ }
      return 'done'
    })()
    expect(result).toBe('done')
    expect(db.prepare('SELECT name FROM t').all()).toEqual([{ name: 'outer' }])
  })

  it('reads pragmas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qd-sqlite-'))
    dirs.push(dir)
    const db = new Database(join(dir, 'x.db'))
    db.pragma('journal_mode = WAL')
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('user_version')).toEqual([{ user_version: 0 }])
    db.close()
  })

  it('takes the write lock at BEGIN, so a second connection waits rather than both writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qd-sqlite-'))
    dirs.push(dir)
    const path = join(dir, 'x.db')
    const a = new Database(path)
    a.pragma('journal_mode = WAL')
    a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    a.exec('BEGIN IMMEDIATE')
    const b = new Database(path)
    b.exec('PRAGMA busy_timeout = 50')
    expect(() => b.transaction(() => b.prepare('INSERT INTO t DEFAULT VALUES').run())()).toThrow(/locked|busy/i)
    a.exec('COMMIT')
    b.transaction(() => b.prepare('INSERT INTO t DEFAULT VALUES').run())()
    expect(a.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 1 })
    a.close()
    b.close()
  })
})
