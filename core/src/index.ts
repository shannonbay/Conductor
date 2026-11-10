import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { runMigrations } from './migrate.js'

export type { Database } from 'better-sqlite3'
export * from './types.js'
export * from './queries.js'
export * from './gates.js'
export * from './goals.js'
export * from './goal-engine.js'
export * from './schedule.js'
export * from './health.js'
export * from './guard.js'
export * from './goal-tick.js'
export * from './goal-overview.js'
export * from './todos.js'
export * from './goal-changes.js'
export { runMigrations, REVISION_TRIGGERS } from './migrate.js'

/**
 * A `QUARTERDECK_<name>` setting from the environment, or its `CONDUCTOR_<name>`
 * spelling from before the rename.
 */
export function envVar(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`QUARTERDECK_${name}`] ?? env[`CONDUCTOR_${name}`]
}

/**
 * The database: `QUARTERDECK_DB` (or `CONDUCTOR_DB`) if set, otherwise
 * `~/.quarterdeck/tasks.db`. A database still in `~/.conductor` from before the
 * rename is used where it is until it is moved (`npm run doctor` says how).
 */
export function defaultDbPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const set = envVar('DB', env)
  if (set) return set
  const path = join(home, '.quarterdeck', 'tasks.db')
  const old = join(home, '.conductor', 'tasks.db')
  return !existsSync(path) && existsSync(old) ? old : path
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
