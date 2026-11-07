import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { runMigrations } from './migrate.js'

export type { Database } from 'better-sqlite3'
export * from './types.js'
export * from './queries.js'
export * from './gates.js'
export * from './goals.js'
export * from './goal-engine.js'
export { runMigrations, REVISION_TRIGGERS } from './migrate.js'

/** `CONDUCTOR_DB` if set, otherwise `~/.conductor/tasks.db`. */
export function defaultDbPath(): string {
  return process.env.CONDUCTOR_DB ?? join(homedir(), '.conductor', 'tasks.db')
}

/** Opens the shared database in WAL mode and brings its schema up to date. */
export function openDatabase(path: string = defaultDbPath()): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}
