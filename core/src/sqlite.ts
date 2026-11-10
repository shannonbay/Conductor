/**
 * A thin layer over Node's built-in `node:sqlite` with the parts of the
 * better-sqlite3 API Quarterdeck uses (`prepare`, `exec`, `transaction`,
 * `pragma`). Being built in, it needs no native build step, so the MCP server
 * can ship as one bundled file inside the Claude Code plugin.
 */
import type { DatabaseSync as DatabaseSyncType, StatementSync, SQLInputValue } from 'node:sqlite'

// Loaded at run time rather than imported, so bundlers and Vitest leave it alone.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')

type Params = unknown

export interface RunResult {
  changes: number
  lastInsertRowid: number
}

/** A prepared statement. Rows come back as plain objects. */
export class Statement {
  constructor(private readonly stmt: StatementSync) {
    stmt.setAllowUnknownNamedParameters(true)
  }

  run(...params: Params[]): RunResult {
    const r = this.stmt.run(...(params as SQLInputValue[]))
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(...params: Params[]): any {
    const row = this.stmt.get(...(params as SQLInputValue[]))
    return row === undefined ? undefined : { ...row }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  all(...params: Params[]): any[] {
    return this.stmt.all(...(params as SQLInputValue[])).map((row: Record<string, unknown>) => ({ ...row }))
  }
}

export class Database {
  private readonly db: DatabaseSyncType
  private depth = 0

  /** Waits up to 5 s for another connection's lock, as better-sqlite3 did. */
  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 5000 })
  }

  prepare(sql: string): Statement {
    return new Statement(this.db.prepare(sql))
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  close(): void {
    this.db.close()
  }

  /**
   * Wraps `fn` so each call runs in a transaction: committed when it returns,
   * rolled back when it throws. The outermost one takes the write lock at once
   * (`BEGIN IMMEDIATE`); nested calls use savepoints.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const outer = this.depth === 0
      const savepoint = `qd_sp_${this.depth}`
      this.db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
      this.depth++
      try {
        const result = fn(...args)
        this.depth--
        this.db.exec(outer ? 'COMMIT' : `RELEASE ${savepoint}`)
        return result
      } catch (err) {
        this.depth--
        try {
          this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
        } catch {
          // already rolled back by SQLite
        }
        throw err
      }
    }
  }

  /** `PRAGMA <sql>`: its rows, or with `simple` the first column of the first row. */
  pragma(sql: string, options: { simple?: boolean } = {}): unknown {
    const rows = this.db.prepare(`PRAGMA ${sql}`).all()
    if (!options.simple) return rows.map((row: Record<string, unknown>) => ({ ...row }))
    const first = rows[0]
    return first === undefined ? undefined : Object.values(first)[0]
  }
}
