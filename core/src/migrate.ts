import type { Database } from './sqlite.js'

/** Triggers that keep plans.revision current; `quarterdeck doctor` checks they all exist. */
export const REVISION_TRIGGERS = [
  'trg_tasks_insert_revision',
  'trg_tasks_update_revision',
  'trg_tasks_delete_revision',
  'trg_plans_update_revision',
  'trg_verifications_insert_revision',
  'trg_goals_update_revision',
  'trg_goal_runs_insert_revision',
  'trg_goal_runs_update_revision',
  'trg_goal_memory_insert_revision',
  'trg_goal_memory_update_revision',
  'trg_goal_memory_delete_revision',
  'trg_goal_health_insert_revision',
  'trg_goal_tool_calls_insert_revision',
  'trg_goal_watches_insert_revision',
  'trg_goal_watches_update_revision',
  'trg_goal_watches_delete_revision',
] as const

/**
 * The single source of truth for the Quarterdeck schema. Both the MCP server
 * and the web app call this on startup, so whichever opens the database first
 * produces the same schema.
 *
 * Safe to call repeatedly — every step is idempotent. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so column additions are wrapped in try/catch.
 * New columns added to a CREATE TABLE below must also get an ALTER TABLE
 * entry for databases created before the column existed.
 */
/**
 * The schema this code writes, stored in the database as `PRAGMA user_version`.
 * Bump it with every schema change (new table, column, trigger or data rewrite):
 * a session still running older code then sees it is outdated (`schemaOutdated`)
 * and leaves scheduling to the newer one.
 */
export const SCHEMA_VERSION = 2

/** The schema version recorded in the database (0 before versions existed). */
export function dbSchemaVersion(db: Database): number {
  return Number(db.pragma('user_version', { simple: true }) ?? 0)
}

/** True when another session's newer Quarterdeck has upgraded the database past this code. */
export function schemaOutdated(db: Database): boolean {
  return dbSchemaVersion(db) > SCHEMA_VERSION
}

export function runMigrations(db: Database): void {
  // Legacy renames: projects → plans (idempotent via try/catch)
  try { db.exec('ALTER TABLE projects RENAME TO plans') } catch { /* already renamed or never existed */ }
  try { db.exec('ALTER TABLE tasks RENAME COLUMN project_id TO plan_id') } catch { /* already renamed */ }
  try { db.exec('ALTER TABLE agent_sessions RENAME COLUMN project_id TO plan_id') } catch { /* already renamed */ }
  try { db.exec('ALTER TABLE events RENAME COLUMN project_id TO plan_id') } catch { /* already renamed */ }

  db.exec(`
    DROP INDEX IF EXISTS idx_tasks_project;
    DROP INDEX IF EXISTS idx_projects_status;
    DROP INDEX IF EXISTS idx_projects_updated;
    DROP INDEX IF EXISTS idx_sessions_project;
    DROP INDEX IF EXISTS idx_events_project;
  `)

  // ── Plans and tasks ─────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT,
      status        TEXT NOT NULL DEFAULT 'active',
      working_dir   TEXT,
      focus_task_id TEXT,
      kind          TEXT NOT NULL DEFAULT 'plan',
      revision      INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id                TEXT NOT NULL,
      plan_id           TEXT NOT NULL REFERENCES plans(id),
      goal              TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'active',
      result            TEXT,
      abandon_reason    TEXT,
      state             TEXT NOT NULL DEFAULT '{}',
      depends_on        TEXT,
      notes             TEXT,
      locked_by         TEXT,
      locked_at         TEXT,
      requires_approval INTEGER DEFAULT 0,
      approved_by       TEXT,
      approved_at       TEXT,
      created_by        TEXT DEFAULT 'human',
      assigned_to       TEXT,
      acceptance_criteria TEXT,
      verify_command    TEXT,
      verify_timeout_s  INTEGER,
      review_requested_at TEXT,
      run_id            TEXT,
      external_ref      TEXT,
      archived_at       TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      PRIMARY KEY (id, plan_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_plan    ON tasks(plan_id);
    CREATE INDEX IF NOT EXISTS idx_plans_status  ON plans(status);
    CREATE INDEX IF NOT EXISTS idx_plans_updated ON plans(updated_at DESC);
  `)

  const addedPlanColumns: [string, string][] = [
    ['working_dir', 'TEXT'],
    ['focus_task_id', 'TEXT'],
    ['revision', 'INTEGER NOT NULL DEFAULT 0'],
    ['kind', "TEXT NOT NULL DEFAULT 'plan'"],
  ]
  for (const [col, def] of addedPlanColumns) {
    try { db.exec(`ALTER TABLE plans ADD COLUMN ${col} ${def}`) } catch { /* already exists */ }
  }
  db.exec(`UPDATE plans SET working_dir = '(unknown)' WHERE working_dir IS NULL`)

  const addedTaskColumns: [string, string][] = [
    ['notes', 'TEXT'],
    ['locked_by', 'TEXT'],
    ['locked_at', 'TEXT'],
    ['requires_approval', 'INTEGER DEFAULT 0'],
    ['approved_by', 'TEXT'],
    ['approved_at', 'TEXT'],
    ['created_by', "TEXT DEFAULT 'human'"],
    ['assigned_to', 'TEXT'],
    ['acceptance_criteria', 'TEXT'],
    ['verify_command', 'TEXT'],
    ['verify_timeout_s', 'INTEGER'],
    ['review_requested_at', 'TEXT'],
    ['run_id', 'TEXT'],
    ['external_ref', 'TEXT'],
    ['archived_at', 'TEXT'],
  ]
  for (const [col, def] of addedTaskColumns) {
    try { db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${def}`) } catch { /* already exists */ }
  }
  // A goal never creates two items for the same external thing (e.g. one email)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_external_ref ON tasks(plan_id, external_ref) WHERE external_ref IS NOT NULL`)

  // Legacy plan/step columns (SQLite 3.35+)
  for (const col of ['plan', 'step']) {
    try { db.exec(`ALTER TABLE tasks DROP COLUMN ${col}`) } catch { /* already gone */ }
  }

  // ── Revision triggers ───────────────────────────────────────────────────────
  // Any insert/update/delete of a task, from any process, bumps its plan's
  // revision. The web app polls this number to push live updates, which also
  // catches deletions (a timestamp column can't). The plans trigger skips
  // updates that already changed revision, so it never loops.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_tasks_insert_revision AFTER INSERT ON tasks
    BEGIN UPDATE plans SET revision = revision + 1 WHERE id = NEW.plan_id; END;

    CREATE TRIGGER IF NOT EXISTS trg_tasks_update_revision AFTER UPDATE ON tasks
    BEGIN UPDATE plans SET revision = revision + 1 WHERE id = NEW.plan_id; END;

    CREATE TRIGGER IF NOT EXISTS trg_tasks_delete_revision AFTER DELETE ON tasks
    BEGIN UPDATE plans SET revision = revision + 1 WHERE id = OLD.plan_id; END;

    CREATE TRIGGER IF NOT EXISTS trg_plans_update_revision AFTER UPDATE ON plans
    WHEN NEW.revision = OLD.revision
    BEGIN UPDATE plans SET revision = revision + 1 WHERE id = NEW.id; END;
  `)

  // ── Agent sessions ──────────────────────────────────────────────────────────
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
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_plan ON agent_sessions(plan_id, status);
  `)
  try {
    db.exec(`ALTER TABLE agent_sessions ADD COLUMN nickname TEXT NOT NULL DEFAULT ''`)
  } catch { /* already exists */ }

  // ── Event log (immutable) ───────────────────────────────────────────────────
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
    );
    CREATE INDEX IF NOT EXISTS idx_events_task ON events(plan_id, task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_plan ON events(plan_id, created_at);
  `)

  // ── Verification results (gate evidence) ────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS verifications (
      id          TEXT PRIMARY KEY,
      plan_id     TEXT NOT NULL REFERENCES plans(id),
      task_id     TEXT NOT NULL,
      gate        TEXT NOT NULL CHECK (gate IN ('criteria', 'command', 'approval', 'override')),
      passed      INTEGER NOT NULL,
      actor       TEXT NOT NULL CHECK (actor IN ('human', 'agent')),
      command     TEXT,
      exit_code   INTEGER,
      output      TEXT,
      evidence    TEXT,
      duration_ms INTEGER,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_verifications_task ON verifications(plan_id, task_id, created_at);

    CREATE TRIGGER IF NOT EXISTS trg_verifications_insert_revision AFTER INSERT ON verifications
    BEGIN UPDATE plans SET revision = revision + 1 WHERE id = NEW.plan_id; END;
  `)

  // ── Persistent goals (specs/persistent-goals.md) ───────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      plan_id             TEXT PRIMARY KEY REFERENCES plans(id),
      objective           TEXT NOT NULL,
      instructions        TEXT NOT NULL DEFAULT '',
      status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
      autonomy            TEXT NOT NULL DEFAULT '{}',
      limits              TEXT NOT NULL DEFAULT '{}',
      item_retention_days INTEGER NOT NULL DEFAULT 7,
      last_run_at         TEXT,
      next_run_at         TEXT
    );

    CREATE TABLE IF NOT EXISTS goal_triggers (
      id      TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES plans(id),
      kind    TEXT NOT NULL CHECK (kind IN ('manual', 'interval', 'cron', 'event')),
      config  TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_goal_triggers_plan ON goal_triggers(plan_id);

    CREATE TABLE IF NOT EXISTS goal_runs (
      id             TEXT PRIMARY KEY,
      plan_id        TEXT NOT NULL REFERENCES plans(id),
      trigger        TEXT NOT NULL,
      status         TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'timed_out', 'skipped')),
      session_id     TEXT REFERENCES agent_sessions(id),
      summary        TEXT,
      skip_reason    TEXT,
      items_created  INTEGER NOT NULL DEFAULT 0,
      items_resolved INTEGER NOT NULL DEFAULT 0,
      started_at     TEXT NOT NULL,
      ended_at       TEXT,
      input_tokens   INTEGER NOT NULL DEFAULT 0,
      output_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      model          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_goal_runs_plan ON goal_runs(plan_id, started_at);

    CREATE TABLE IF NOT EXISTS goal_memory (
      id           TEXT PRIMARY KEY,
      plan_id      TEXT NOT NULL REFERENCES plans(id),
      kind         TEXT NOT NULL CHECK (kind IN ('fact', 'rule', 'preference')),
      text         TEXT NOT NULL,
      source       TEXT NOT NULL CHECK (source IN ('human', 'agent', 'feedback')),
      source_ref   TEXT,
      pinned       INTEGER NOT NULL DEFAULT 0,
      active       INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL,
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_goal_memory_plan ON goal_memory(plan_id, active);

    CREATE TRIGGER IF NOT EXISTS trg_goals_update_revision AFTER UPDATE ON goals
    BEGIN UPDATE plans SET revision = revision + 1 WHERE id = NEW.plan_id; END;
    CREATE TRIGGER IF NOT EXISTS trg_goal_runs_insert_revision AFTER INSERT ON goal_runs
    BEGIN UPDATE plans SET revision = revision + 1 WHERE id = NEW.plan_id; END;
    CREATE TRIGGER IF NOT EXISTS trg_goal_runs_update_revision AFTER UPDATE ON goal_runs
    BEGIN UPDATE plans SET revision = revision + 1 WHERE id = NEW.plan_id; END;
    CREATE TRIGGER IF NOT EXISTS trg_goal_memory_insert_revision AFTER INSERT ON goal_memory
    BEGIN UPDATE plans SET revision = revision + 1 WHERE id = NEW.plan_id; END;
    CREATE TRIGGER IF NOT EXISTS trg_goal_memory_update_revision AFTER UPDATE ON goal_memory
    BEGIN UPDATE plans SET revision = revision + 1 WHERE id = NEW.plan_id; END;
    CREATE TRIGGER IF NOT EXISTS trg_goal_memory_delete_revision AFTER DELETE ON goal_memory
    BEGIN UPDATE plans SET revision = revision + 1 WHERE id = OLD.plan_id; END;
  `)

  // ── Persistent goals, phase 2: health checks, guard hook, more triggers ────
  const addedGoalColumns: [string, string][] = [
    ['tool_map', "TEXT NOT NULL DEFAULT '{}'"],
    ['health_command', 'TEXT'],
    ['health_every_minutes', 'INTEGER NOT NULL DEFAULT 60'],
    ['health_triggers_run', 'INTEGER NOT NULL DEFAULT 1'],
    ['last_health_at', 'TEXT'],
    // 1: runs once; when its run ends with nothing open it is done (status 'retired')
    ['one_off', 'INTEGER NOT NULL DEFAULT 0'],
  ]
  for (const [col, def] of addedGoalColumns) {
    try { db.exec(`ALTER TABLE goals ADD COLUMN ${col} ${def}`) } catch { /* already exists */ }
  }
  try { db.exec('ALTER TABLE goal_runs ADD COLUMN cc_session_id TEXT') } catch { /* already exists */ }
  // What each run cost, from its agent's turns (reported by the guard plugin)
  for (const col of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']) {
    try { db.exec(`ALTER TABLE goal_runs ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`) } catch { /* already exists */ }
  }
  try { db.exec('ALTER TABLE goal_runs ADD COLUMN model TEXT') } catch { /* already exists */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_health (
      id          TEXT PRIMARY KEY,
      plan_id     TEXT NOT NULL REFERENCES plans(id),
      passed      INTEGER NOT NULL,
      exit_code   INTEGER,
      value       REAL,
      output      TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_goal_health_plan ON goal_health(plan_id, created_at);

    CREATE TABLE IF NOT EXISTS goal_tool_calls (
      id         TEXT PRIMARY KEY,
      plan_id    TEXT NOT NULL REFERENCES plans(id),
      run_id     TEXT NOT NULL,
      tool_name  TEXT NOT NULL,
      category   TEXT NOT NULL,
      decision   TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
      reason     TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_goal_tool_calls ON goal_tool_calls(plan_id, category, created_at);
    CREATE INDEX IF NOT EXISTS idx_goal_runs_cc_session ON goal_runs(cc_session_id);

    CREATE TRIGGER IF NOT EXISTS trg_goal_health_insert_revision AFTER INSERT ON goal_health
    BEGIN UPDATE plans SET revision = revision + 1 WHERE id = NEW.plan_id; END;
    CREATE TRIGGER IF NOT EXISTS trg_goal_tool_calls_insert_revision AFTER INSERT ON goal_tool_calls
    BEGIN UPDATE plans SET revision = revision + 1 WHERE id = NEW.plan_id; END;
  `)

  // ── Persistent goals, phase 3: runs started by the Claude Code plugin ──────
  // holder: the Claude Code session whose plugin claimed the run; agent_id: the subagent doing it
  for (const col of ['holder', 'agent_id']) {
    try { db.exec(`ALTER TABLE goal_runs ADD COLUMN ${col} TEXT`) } catch { /* already exists */ }
  }
  db.exec(`
    -- One row per scheduler; only the holder whose lease hasn't expired starts runs
    CREATE TABLE IF NOT EXISTS scheduler_lease (
      name       TEXT PRIMARY KEY,
      holder     TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    -- At most one row: while it's in force no goal run starts (the person's usage limit is reached)
    CREATE TABLE IF NOT EXISTS goal_run_hold (
      id     INTEGER PRIMARY KEY CHECK (id = 1),
      until  TEXT NOT NULL,
      reason TEXT NOT NULL
    );
  `)

  // ── Watches: a check whose new lines start a run (schema version 2) ─────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_watches (
      id              TEXT PRIMARY KEY,
      plan_id         TEXT NOT NULL REFERENCES plans(id),
      name            TEXT NOT NULL,
      kind            TEXT NOT NULL CHECK (kind IN ('command', 'tool')),
      command         TEXT,
      tool            TEXT,
      tool_input      TEXT NOT NULL DEFAULT '{}',
      match           TEXT,
      every_minutes   INTEGER NOT NULL DEFAULT 5,
      -- JSON array of the lines seen so far, capped
      seen            TEXT NOT NULL DEFAULT '[]',
      -- null until the first check that worked: that one only records what is there
      baseline_at     TEXT,
      last_checked_at TEXT,
      asked_at        TEXT,
      last_fired_at   TEXT,
      last_error      TEXT,
      fail_count      INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL,
      UNIQUE (plan_id, name)
    );

    -- One row per new line; it waits (run_id null) until a run's brief carries it
    CREATE TABLE IF NOT EXISTS goal_watch_events (
      id         TEXT PRIMARY KEY,
      watch_id   TEXT NOT NULL,
      plan_id    TEXT NOT NULL REFERENCES plans(id),
      line       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      queued_at  TEXT,
      run_id     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_goal_watch_events_plan ON goal_watch_events(plan_id, run_id);

  `)
  // Added while version 2 was being built: a database that already has the table needs the column
  try { db.exec('ALTER TABLE goal_watches ADD COLUMN asked_at TEXT') } catch { /* already exists */ }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_goal_watches_insert_revision AFTER INSERT ON goal_watches
    BEGIN UPDATE plans SET revision = revision + 1 WHERE id = NEW.plan_id; END;
    -- Not on every check: only when what the pane shows changes
    CREATE TRIGGER IF NOT EXISTS trg_goal_watches_update_revision AFTER UPDATE OF name, kind, command, tool, tool_input, match, every_minutes, last_fired_at, last_error ON goal_watches
    BEGIN UPDATE plans SET revision = revision + 1 WHERE id = NEW.plan_id; END;
    CREATE TRIGGER IF NOT EXISTS trg_goal_watches_delete_revision AFTER DELETE ON goal_watches
    BEGIN UPDATE plans SET revision = revision + 1 WHERE id = OLD.plan_id; END;
  `)

  // ── Agent transcripts ───────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES agent_sessions(id),
      plan_id     TEXT NOT NULL REFERENCES plans(id),
      role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content     TEXT NOT NULL,
      turn_index  INTEGER NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_transcript_session ON transcript_messages(session_id, turn_index);
  `)

  // ── Renamed from Conductor: the MCP server's tools moved from mcp__conductor__* ──
  db.exec(`
    UPDATE goals SET tool_map = replace(tool_map, '"mcp__conductor__', '"mcp__quarterdeck__')
    WHERE instr(tool_map, '"mcp__conductor__') > 0
  `)

  // Record the schema version, never lowering one a newer session wrote
  if (dbSchemaVersion(db) < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}
