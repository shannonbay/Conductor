import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

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
