import type { Database } from 'better-sqlite3'

/**
 * Runs all migrations on the shared Conductor SQLite database.
 * Safe to call multiple times — all operations are idempotent.
 * Creates the base MCP schema (plans + tasks) if not present, then adds UI extensions.
 * This allows the web app to work standalone (e.g. in tests) without a running MCP server.
 */
export function runMigrations(db: Database): void {
  // Rename projects → plans for existing databases (idempotent via try/catch)
  try { db.exec('ALTER TABLE projects RENAME TO plans') } catch { /* already renamed or doesn't exist */ }
  try { db.exec('ALTER TABLE tasks RENAME COLUMN project_id TO plan_id') } catch { /* already renamed */ }
  try { db.exec('ALTER TABLE agent_sessions RENAME COLUMN project_id TO plan_id') } catch { /* already renamed */ }
  try { db.exec('ALTER TABLE events RENAME COLUMN project_id TO plan_id') } catch { /* already renamed */ }

  // Drop old indexes (idempotent)
  db.exec(`
    DROP INDEX IF EXISTS idx_tasks_project;
    DROP INDEX IF EXISTS idx_projects_status;
    DROP INDEX IF EXISTS idx_projects_updated;
    DROP INDEX IF EXISTS idx_sessions_project;
    DROP INDEX IF EXISTS idx_events_project;
  `)

  // Base schema — mirrors mcp/src/db.ts (CREATE TABLE IF NOT EXISTS is idempotent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT,
      status        TEXT NOT NULL DEFAULT 'active',
      working_dir   TEXT,
      focus_task_id TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id             TEXT NOT NULL,
      plan_id        TEXT NOT NULL REFERENCES plans(id),
      goal           TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'active',
      result         TEXT,
      abandon_reason TEXT,
      state          TEXT NOT NULL DEFAULT '{}',
      depends_on     TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (id, plan_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_plan    ON tasks(plan_id);
    CREATE INDEX IF NOT EXISTS idx_plans_status  ON plans(status);
    CREATE INDEX IF NOT EXISTS idx_plans_updated ON plans(updated_at DESC);
  `)

  // Add working_dir column to plans table and backfill existing rows
  try {
    db.exec(`ALTER TABLE plans ADD COLUMN working_dir TEXT`)
  } catch {
    // Column already exists — ignore
  }
  db.exec(`UPDATE plans SET working_dir = '(unknown)' WHERE working_dir IS NULL`)

  // Add UI-layer columns to tasks table (wrapped in try/catch — SQLite lacks IF NOT EXISTS for ALTER TABLE)
  const newTaskColumns: [string, string][] = [
    ['locked_by', 'TEXT'],
    ['locked_at', 'TEXT'],
    ['requires_approval', 'INTEGER DEFAULT 0'],
    ['approved_by', 'TEXT'],
    ['approved_at', 'TEXT'],
    ['created_by', "TEXT DEFAULT 'human'"],
    ['assigned_to', 'TEXT'],
    ['notes', 'TEXT'],
  ]

  for (const [col, def] of newTaskColumns) {
    try {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${def}`)
    } catch {
      // Column already exists — ignore
    }
  }

  // Drop legacy plan/step columns from existing databases (SQLite 3.35+)
  for (const col of ['plan', 'step']) {
    try {
      db.exec(`ALTER TABLE tasks DROP COLUMN ${col}`)
    } catch {
      // Column already gone — ignore
    }
  }

  // Agent sessions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES plans(id),
      root_task_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'paused', 'completed', 'failed', 'cancelled')),
      autonomy_level TEXT NOT NULL DEFAULT 'full'
        CHECK (autonomy_level IN ('full', 'approve_decompositions', 'approve_steps', 'manual')),
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0.0,
      error TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    )
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_plan
      ON agent_sessions(plan_id, status)
  `)

  try {
    db.exec(`ALTER TABLE agent_sessions ADD COLUMN nickname TEXT NOT NULL DEFAULT ''`)
  } catch {
    // Column already exists — ignore
  }

  // Immutable event log
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES plans(id),
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL CHECK (actor IN ('human', 'agent')),
      session_id TEXT REFERENCES agent_sessions(id),
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_task
      ON events(plan_id, task_id, created_at)
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_plan
      ON events(plan_id, created_at)
  `)
}
