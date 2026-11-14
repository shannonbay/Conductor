import { Database } from './sqlite.js'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { defaultDbPath } from './paths.js'
import { runMigrations } from './migrate.js'

export { Database, Statement, type RunResult } from './sqlite.js'
export * from './types.js'
export * from './queries.js'
export * from './gates.js'
export * from './goals.js'
export * from './goal-engine.js'
export * from './schedule.js'
export * from './health.js'
export * from './watches.js'
export * from './guard.js'
export * from './goal-tick.js'
export * from './status-check.js'
export * from './goal-overview.js'
export * from './todos.js'
export * from './goal-changes.js'
export { envVar, defaultDbPath } from './paths.js'
export { runMigrations, REVISION_TRIGGERS, SCHEMA_VERSION, dbSchemaVersion, schemaOutdated } from './migrate.js'

/** Opens the shared database in WAL mode and brings its schema up to date. */
export function openDatabase(path: string = defaultDbPath()): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}
