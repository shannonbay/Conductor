import type { Database } from 'better-sqlite3'

/**
 * Runs all migrations on the shared Conductor SQLite database.
 * Safe to call multiple times — all operations are idempotent.
 * Creates the base MCP schema (projects + tasks) if not present, then adds UI extensions.
 * This allows the web app to work standalone (e.g. in tests) without a running MCP server.
 */
export function runMigrations(db: Database): void {
  // Base schema — mirrors mcp/src/db.ts (CREATE TABLE IF NOT EXISTS is idempotent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
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
      project_id     TEXT NOT NULL REFERENCES projects(id),
      goal           TEXT NOT NULL,
      plan           TEXT NOT NULL,
      step           INTEGER NOT NULL DEFAULT 0,
      status         TEXT NOT NULL DEFAULT 'active',
      result         TEXT,
      abandon_reason TEXT,
      state          TEXT NOT NULL DEFAULT '{}',
      depends_on     TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (id, project_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project    ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_projects_status  ON projects(status);
    CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);
  `)

  // Add working_dir column to projects table and backfill existing rows
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN working_dir TEXT`)
  } catch {
    // Column already exists — ignore
  }
  db.exec(`UPDATE projects SET working_dir = '(unknown)' WHERE working_dir IS NULL`)

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

  // Agent sessions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
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
    CREATE INDEX IF NOT EXISTS idx_sessions_project
      ON agent_sessions(project_id, status)
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
      project_id TEXT NOT NULL REFERENCES projects(id),
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
      ON events(project_id, task_id, created_at)
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_project
      ON events(project_id, created_at)
  `)
}
