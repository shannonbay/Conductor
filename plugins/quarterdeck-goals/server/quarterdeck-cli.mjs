#!/usr/bin/env node
// Quarterdeck MCP server 0.18.0, bundled by mcp/scripts/bundle.mjs. Edit mcp/ and core/, not this file.
import { createRequire as __qdCreateRequire } from 'module'; const require = __qdCreateRequire(import.meta.url);
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// ../core/src/sqlite.ts
var DatabaseSync, Statement, Database;
var init_sqlite = __esm({
  "../core/src/sqlite.ts"() {
    "use strict";
    ({ DatabaseSync } = process.getBuiltinModule("node:sqlite"));
    Statement = class {
      constructor(stmt) {
        this.stmt = stmt;
        stmt.setAllowUnknownNamedParameters(true);
      }
      run(...params) {
        const r = this.stmt.run(...params);
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      get(...params) {
        const row = this.stmt.get(...params);
        return row === void 0 ? void 0 : { ...row };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      all(...params) {
        return this.stmt.all(...params).map((row) => ({ ...row }));
      }
    };
    Database = class {
      db;
      depth = 0;
      /** Waits up to 5 s for another connection's lock, as better-sqlite3 did. */
      constructor(path) {
        this.db = new DatabaseSync(path, { timeout: 5e3 });
      }
      prepare(sql) {
        return new Statement(this.db.prepare(sql));
      }
      exec(sql) {
        this.db.exec(sql);
      }
      close() {
        this.db.close();
      }
      /**
       * Wraps `fn` so each call runs in a transaction: committed when it returns,
       * rolled back when it throws. The outermost one takes the write lock at once
       * (`BEGIN IMMEDIATE`); nested calls use savepoints.
       */
      transaction(fn) {
        return (...args) => {
          const outer = this.depth === 0;
          const savepoint = `qd_sp_${this.depth}`;
          this.db.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
          this.depth++;
          try {
            const result = fn(...args);
            this.depth--;
            this.db.exec(outer ? "COMMIT" : `RELEASE ${savepoint}`);
            return result;
          } catch (err) {
            this.depth--;
            try {
              this.db.exec(outer ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
            } catch {
            }
            throw err;
          }
        };
      }
      /** `PRAGMA <sql>`: its rows, or with `simple` the first column of the first row. */
      pragma(sql, options = {}) {
        const rows = this.db.prepare(`PRAGMA ${sql}`).all();
        if (!options.simple) return rows.map((row) => ({ ...row }));
        const first = rows[0];
        return first === void 0 ? void 0 : Object.values(first)[0];
      }
    };
  }
});

// ../core/src/migrate.ts
function dbSchemaVersion(db) {
  return Number(db.pragma("user_version", { simple: true }) ?? 0);
}
function schemaOutdated(db) {
  return dbSchemaVersion(db) > SCHEMA_VERSION;
}
function runMigrations(db) {
  try {
    db.exec("ALTER TABLE projects RENAME TO plans");
  } catch {
  }
  try {
    db.exec("ALTER TABLE tasks RENAME COLUMN project_id TO plan_id");
  } catch {
  }
  try {
    db.exec("ALTER TABLE agent_sessions RENAME COLUMN project_id TO plan_id");
  } catch {
  }
  try {
    db.exec("ALTER TABLE events RENAME COLUMN project_id TO plan_id");
  } catch {
  }
  db.exec(`
    DROP INDEX IF EXISTS idx_tasks_project;
    DROP INDEX IF EXISTS idx_projects_status;
    DROP INDEX IF EXISTS idx_projects_updated;
    DROP INDEX IF EXISTS idx_sessions_project;
    DROP INDEX IF EXISTS idx_events_project;
  `);
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
  `);
  const addedPlanColumns = [
    ["working_dir", "TEXT"],
    ["focus_task_id", "TEXT"],
    ["revision", "INTEGER NOT NULL DEFAULT 0"],
    ["kind", "TEXT NOT NULL DEFAULT 'plan'"]
  ];
  for (const [col, def] of addedPlanColumns) {
    try {
      db.exec(`ALTER TABLE plans ADD COLUMN ${col} ${def}`);
    } catch {
    }
  }
  db.exec(`UPDATE plans SET working_dir = '(unknown)' WHERE working_dir IS NULL`);
  const addedTaskColumns = [
    ["notes", "TEXT"],
    ["locked_by", "TEXT"],
    ["locked_at", "TEXT"],
    ["requires_approval", "INTEGER DEFAULT 0"],
    ["approved_by", "TEXT"],
    ["approved_at", "TEXT"],
    ["created_by", "TEXT DEFAULT 'human'"],
    ["assigned_to", "TEXT"],
    ["acceptance_criteria", "TEXT"],
    ["verify_command", "TEXT"],
    ["verify_timeout_s", "INTEGER"],
    ["review_requested_at", "TEXT"],
    ["run_id", "TEXT"],
    ["external_ref", "TEXT"],
    ["archived_at", "TEXT"]
  ];
  for (const [col, def] of addedTaskColumns) {
    try {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${def}`);
    } catch {
    }
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_external_ref ON tasks(plan_id, external_ref) WHERE external_ref IS NOT NULL`);
  for (const col of ["plan", "step"]) {
    try {
      db.exec(`ALTER TABLE tasks DROP COLUMN ${col}`);
    } catch {
    }
  }
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
  `);
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
  `);
  try {
    db.exec(`ALTER TABLE agent_sessions ADD COLUMN nickname TEXT NOT NULL DEFAULT ''`);
  } catch {
  }
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
  `);
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
  `);
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
  `);
  const addedGoalColumns = [
    ["tool_map", "TEXT NOT NULL DEFAULT '{}'"],
    ["health_command", "TEXT"],
    ["health_every_minutes", "INTEGER NOT NULL DEFAULT 60"],
    ["health_triggers_run", "INTEGER NOT NULL DEFAULT 1"],
    ["last_health_at", "TEXT"],
    // 1: runs once; when its run ends with nothing open it is done (status 'retired')
    ["one_off", "INTEGER NOT NULL DEFAULT 0"]
  ];
  for (const [col, def] of addedGoalColumns) {
    try {
      db.exec(`ALTER TABLE goals ADD COLUMN ${col} ${def}`);
    } catch {
    }
  }
  try {
    db.exec("ALTER TABLE goal_runs ADD COLUMN cc_session_id TEXT");
  } catch {
  }
  for (const col of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"]) {
    try {
      db.exec(`ALTER TABLE goal_runs ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
    } catch {
    }
  }
  try {
    db.exec("ALTER TABLE goal_runs ADD COLUMN model TEXT");
  } catch {
  }
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
  `);
  for (const col of ["holder", "agent_id"]) {
    try {
      db.exec(`ALTER TABLE goal_runs ADD COLUMN ${col} TEXT`);
    } catch {
    }
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
  `);
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

  `);
  try {
    db.exec("ALTER TABLE goal_watches ADD COLUMN asked_at TEXT");
  } catch {
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_goal_watches_insert_revision AFTER INSERT ON goal_watches
    BEGIN UPDATE plans SET revision = revision + 1 WHERE id = NEW.plan_id; END;
    -- Not on every check: only when what the pane shows changes
    CREATE TRIGGER IF NOT EXISTS trg_goal_watches_update_revision AFTER UPDATE OF name, kind, command, tool, tool_input, match, every_minutes, last_fired_at, last_error ON goal_watches
    BEGIN UPDATE plans SET revision = revision + 1 WHERE id = NEW.plan_id; END;
    CREATE TRIGGER IF NOT EXISTS trg_goal_watches_delete_revision AFTER DELETE ON goal_watches
    BEGIN UPDATE plans SET revision = revision + 1 WHERE id = OLD.plan_id; END;
  `);
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
  `);
  db.exec(`
    UPDATE goals SET tool_map = replace(tool_map, '"mcp__conductor__', '"mcp__quarterdeck__')
    WHERE instr(tool_map, '"mcp__conductor__') > 0
  `);
  if (dbSchemaVersion(db) < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
var REVISION_TRIGGERS, SCHEMA_VERSION;
var init_migrate = __esm({
  "../core/src/migrate.ts"() {
    "use strict";
    REVISION_TRIGGERS = [
      "trg_tasks_insert_revision",
      "trg_tasks_update_revision",
      "trg_tasks_delete_revision",
      "trg_plans_update_revision",
      "trg_verifications_insert_revision",
      "trg_goals_update_revision",
      "trg_goal_runs_insert_revision",
      "trg_goal_runs_update_revision",
      "trg_goal_memory_insert_revision",
      "trg_goal_memory_update_revision",
      "trg_goal_memory_delete_revision",
      "trg_goal_health_insert_revision",
      "trg_goal_tool_calls_insert_revision",
      "trg_goal_watches_insert_revision",
      "trg_goal_watches_update_revision",
      "trg_goal_watches_delete_revision"
    ];
    SCHEMA_VERSION = 2;
  }
});

// ../core/src/types.ts
var GATE_FIELDS, DEFAULT_GOAL_LIMITS;
var init_types = __esm({
  "../core/src/types.ts"() {
    "use strict";
    GATE_FIELDS = ["acceptance_criteria", "verify_command", "verify_timeout_s", "requires_approval"];
    DEFAULT_GOAL_LIMITS = { max_run_minutes: 15, max_items_per_run: 50, max_runs_per_day: 48 };
  }
});

// ../core/src/queries.ts
import { randomUUID } from "crypto";
function deserializeTask(row) {
  return {
    ...row,
    state: JSON.parse(row.state),
    depends_on: row.depends_on ? JSON.parse(row.depends_on) : null,
    notes: row.notes ?? null,
    requires_approval: Boolean(row.requires_approval),
    acceptance_criteria: row.acceptance_criteria ? JSON.parse(row.acceptance_criteria) : null,
    verify_command: row.verify_command ?? null,
    verify_timeout_s: row.verify_timeout_s ?? null,
    review_requested_at: row.review_requested_at ?? null,
    run_id: row.run_id ?? null,
    external_ref: row.external_ref ?? null,
    archived_at: row.archived_at ?? null
  };
}
function setClause(fields) {
  const entries = Object.entries(fields);
  return {
    sql: entries.map(([k]) => `${k} = ?`).join(", "),
    values: entries.map(([, v]) => v)
  };
}
function listPlans(db, status2 = "active") {
  if (status2 === "all") {
    return db.prepare("SELECT * FROM plans ORDER BY updated_at DESC").all();
  }
  return db.prepare("SELECT * FROM plans WHERE status = ? ORDER BY updated_at DESC").all(status2);
}
function getPlan(db, id) {
  return db.prepare("SELECT * FROM plans WHERE id = ?").get(id);
}
function getPlanRevision(db, id) {
  const row = db.prepare("SELECT revision FROM plans WHERE id = ?").get(id);
  return row?.revision;
}
function insertPlan(db, plan) {
  db.prepare(`
    INSERT INTO plans (id, name, description, status, working_dir, focus_task_id, kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(plan.id, plan.name, plan.description, plan.status, plan.working_dir, plan.focus_task_id ?? null, plan.kind ?? "plan", plan.created_at, plan.updated_at);
}
function updatePlan(db, id, fields) {
  const { sql, values } = setClause(fields);
  if (!sql) return;
  db.prepare(`UPDATE plans SET ${sql} WHERE id = ?`).run(...values, id);
}
function touchPlan(db, id) {
  updatePlan(db, id, { updated_at: (/* @__PURE__ */ new Date()).toISOString() });
}
function getTask(db, planId, taskId) {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ? AND plan_id = ?").get(taskId, planId);
  return row ? deserializeTask(row) : void 0;
}
function compareTaskIds(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return pa.length - pb.length;
}
function getAllTasks(db, planId) {
  const rows = db.prepare("SELECT * FROM tasks WHERE plan_id = ?").all(planId);
  return rows.map(deserializeTask).sort((a, b) => compareTaskIds(a.id, b.id));
}
function getRootTasks(db, planId) {
  const rows = db.prepare("SELECT * FROM tasks WHERE plan_id = ? AND id NOT LIKE '%.%'").all(planId);
  return rows.map(deserializeTask);
}
function getChildren(db, planId, parentId) {
  if (parentId === "") return getRootTasks(db, planId);
  const rows = db.prepare("SELECT * FROM tasks WHERE plan_id = ? AND id LIKE ? AND id NOT LIKE ?").all(planId, `${parentId}.%`, `${parentId}.%.%`);
  return rows.map(deserializeTask);
}
function getSiblings(db, planId, taskId) {
  const parts = taskId.split(".");
  const parentId = parts.slice(0, -1).join(".");
  return getChildren(db, planId, parentId).filter((t) => t.id !== taskId);
}
function getTreeStats(db, planId) {
  const rows = db.prepare("SELECT status, COUNT(*) as count FROM tasks WHERE plan_id = ? GROUP BY status").all(planId);
  const by = {};
  for (const r of rows) by[r.status] = r.count;
  return {
    total_tasks: rows.reduce((sum, r) => sum + r.count, 0),
    active: by.active ?? 0,
    completed: by.completed ?? 0,
    pending: by.pending ?? 0,
    abandoned: by.abandoned ?? 0
  };
}
function countAllTasks(db, planId) {
  const row = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE plan_id = ?").get(planId);
  return row.count;
}
function nextChildId(db, planId, parentId) {
  const siblings = getChildren(db, planId, parentId ?? "");
  const maxIndex = siblings.reduce((max, t) => Math.max(max, Number(t.id.split(".").pop())), 0);
  return parentId ? `${parentId}.${maxIndex + 1}` : String(maxIndex + 1);
}
function insertTask(db, task) {
  db.prepare(`
    INSERT INTO tasks (
      id, plan_id, goal, status, result, abandon_reason, state, depends_on, notes,
      locked_by, locked_at, requires_approval, approved_by, approved_at, created_by, assigned_to,
      acceptance_criteria, verify_command, verify_timeout_s, review_requested_at,
      run_id, external_ref, archived_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.plan_id,
    task.goal,
    task.status,
    task.result ?? null,
    task.abandon_reason ?? null,
    JSON.stringify(task.state),
    task.depends_on ? JSON.stringify(task.depends_on) : null,
    task.notes ?? null,
    task.locked_by ?? null,
    task.locked_at ?? null,
    task.requires_approval ? 1 : 0,
    task.approved_by ?? null,
    task.approved_at ?? null,
    task.created_by ?? "human",
    task.assigned_to ?? null,
    task.acceptance_criteria?.length ? JSON.stringify(task.acceptance_criteria) : null,
    task.verify_command ?? null,
    task.verify_timeout_s ?? null,
    task.review_requested_at ?? null,
    task.run_id ?? null,
    task.external_ref ?? null,
    task.archived_at ?? null,
    task.created_at,
    task.updated_at
  );
}
function updateTask(db, planId, taskId, fields) {
  const serialized = { ...fields };
  if ("state" in fields) serialized.state = JSON.stringify(fields.state);
  if ("depends_on" in fields) serialized.depends_on = fields.depends_on ? JSON.stringify(fields.depends_on) : null;
  if ("requires_approval" in fields) serialized.requires_approval = fields.requires_approval ? 1 : 0;
  if ("acceptance_criteria" in fields) {
    serialized.acceptance_criteria = fields.acceptance_criteria?.length ? JSON.stringify(fields.acceptance_criteria) : null;
  }
  const { sql, values } = setClause(serialized);
  if (!sql) return;
  db.prepare(`UPDATE tasks SET ${sql} WHERE id = ? AND plan_id = ?`).run(...values, taskId, planId);
}
function deleteTaskTree(db, planId, taskId) {
  db.prepare("DELETE FROM tasks WHERE plan_id = ? AND (id = ? OR id LIKE ?)").run(planId, taskId, `${taskId}.%`);
}
function insertEvent(db, event) {
  db.prepare(`
    INSERT INTO events (id, plan_id, task_id, event_type, actor, session_id, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.plan_id,
    event.task_id,
    event.event_type,
    event.actor,
    event.session_id ?? null,
    JSON.stringify(event.payload),
    event.created_at ?? (/* @__PURE__ */ new Date()).toISOString()
  );
}
function getEvents(db, planId, query = {}) {
  const where = ["plan_id = ?"];
  const params = [planId];
  if (query.taskId) {
    if (query.subtree) {
      where.push("(task_id = ? OR task_id LIKE ?)");
      params.push(query.taskId, `${query.taskId}.%`);
    } else {
      where.push("task_id = ?");
      params.push(query.taskId);
    }
  }
  const limit = query.limit && query.limit > 0 ? ` LIMIT ${Math.floor(query.limit)}` : "";
  const rows = db.prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC${limit}`).all(...params);
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}
function insertVerification(db, v) {
  const row = {
    id: randomUUID(),
    command: null,
    exit_code: null,
    output: null,
    evidence: null,
    duration_ms: null,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    ...v
  };
  db.prepare(`
    INSERT INTO verifications (id, plan_id, task_id, gate, passed, actor, command, exit_code, output, evidence, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.plan_id,
    row.task_id,
    row.gate,
    row.passed ? 1 : 0,
    row.actor,
    row.command,
    row.exit_code,
    row.output,
    row.evidence ? JSON.stringify(row.evidence) : null,
    row.duration_ms,
    row.created_at
  );
  return row;
}
function deserializeVerification(r) {
  return {
    ...r,
    passed: Boolean(r.passed),
    evidence: r.evidence ? JSON.parse(r.evidence) : null
  };
}
function getVerifications(db, planId, taskId, limit = 50) {
  const rows = db.prepare("SELECT * FROM verifications WHERE plan_id = ? AND task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(planId, taskId, limit);
  return rows.map(deserializeVerification);
}
function getLatestVerification(db, planId, taskId, gate) {
  const row = db.prepare("SELECT * FROM verifications WHERE plan_id = ? AND task_id = ? AND gate = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(planId, taskId, gate);
  return row ? deserializeVerification(row) : void 0;
}
function clearAllData(db) {
  db.exec("DELETE FROM goal_run_hold; DELETE FROM scheduler_lease; DELETE FROM goal_watch_events; DELETE FROM goal_watches; DELETE FROM goal_tool_calls; DELETE FROM goal_health; DELETE FROM goal_memory; DELETE FROM goal_runs; DELETE FROM goal_triggers; DELETE FROM goals; DELETE FROM verifications; DELETE FROM transcript_messages; DELETE FROM events; DELETE FROM agent_sessions; DELETE FROM tasks; DELETE FROM plans;");
}
var init_queries = __esm({
  "../core/src/queries.ts"() {
    "use strict";
  }
});

// ../core/src/goals.ts
import { randomUUID as randomUUID2 } from "crypto";
function deserializeGoal(r) {
  return {
    ...r,
    autonomy: JSON.parse(r.autonomy || "{}"),
    limits: { ...DEFAULT_GOAL_LIMITS, ...JSON.parse(r.limits || "{}") },
    tool_map: JSON.parse(r.tool_map || "{}"),
    health_command: r.health_command ?? null,
    health_every_minutes: r.health_every_minutes ?? 60,
    health_triggers_run: r.health_triggers_run === void 0 ? true : Boolean(r.health_triggers_run),
    last_health_at: r.last_health_at ?? null,
    one_off: Boolean(r.one_off)
  };
}
function createGoal(db, plan, goal, interval) {
  db.transaction(() => {
    insertPlan(db, { ...plan, kind: "goal" });
    db.prepare(`
      INSERT INTO goals (plan_id, objective, instructions, status, autonomy, limits, item_retention_days, last_run_at, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      plan.id,
      goal.objective,
      goal.instructions ?? "",
      goal.status ?? "active",
      JSON.stringify(goal.autonomy ?? {}),
      JSON.stringify({ ...DEFAULT_GOAL_LIMITS, ...goal.limits }),
      goal.item_retention_days ?? 7,
      null,
      interval ? (/* @__PURE__ */ new Date()).toISOString() : null
    );
    if (interval) setIntervalTrigger(db, plan.id, interval);
    if (goal.one_off) db.prepare("UPDATE goals SET one_off = 1 WHERE plan_id = ?").run(plan.id);
  })();
  return getGoal(db, plan.id);
}
function getGoal(db, planId) {
  const row = db.prepare("SELECT * FROM goals WHERE plan_id = ?").get(planId);
  return row ? deserializeGoal(row) : void 0;
}
function listGoals(db, status2) {
  const rows = status2 ? db.prepare("SELECT * FROM goals WHERE status = ?").all(status2) : db.prepare("SELECT * FROM goals").all();
  return rows.map((r) => ({ plan: getPlan(db, r.plan_id), goal: deserializeGoal(r) })).filter((g) => g.plan);
}
function updateGoal(db, planId, fields) {
  const current = getGoal(db, planId);
  if (!current) throw new Error(`Goal ${planId} not found`);
  const serialized = { ...fields };
  if (fields.autonomy) serialized.autonomy = JSON.stringify(fields.autonomy);
  if (fields.tool_map) serialized.tool_map = JSON.stringify(fields.tool_map);
  if ("health_triggers_run" in fields) serialized.health_triggers_run = fields.health_triggers_run ? 1 : 0;
  if ("one_off" in fields) serialized.one_off = fields.one_off ? 1 : 0;
  if (fields.limits) serialized.limits = JSON.stringify({ ...current.limits, ...fields.limits });
  const entries = Object.entries(serialized);
  if (!entries.length) return;
  db.prepare(`UPDATE goals SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE plan_id = ?`).run(...entries.map(([, v]) => v), planId);
}
function deserializeTrigger(r) {
  return { ...r, config: JSON.parse(r.config), enabled: Boolean(r.enabled) };
}
function listTriggers(db, planId) {
  return db.prepare("SELECT * FROM goal_triggers WHERE plan_id = ?").all(planId).map(deserializeTrigger);
}
function getIntervalTrigger(db, planId) {
  return listTriggers(db, planId).find((t) => t.kind === "interval");
}
function setIntervalTrigger(db, planId, config) {
  const existing = getIntervalTrigger(db, planId);
  if (!config) {
    if (existing) db.prepare("DELETE FROM goal_triggers WHERE id = ?").run(existing.id);
    return;
  }
  if (!(config.minutes >= 1)) throw new Error("Interval must be at least 1 minute.");
  if (config.active_hours && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(config.active_hours)) {
    throw new Error('active_hours must look like "08:00-20:00".');
  }
  if (existing) {
    db.prepare("UPDATE goal_triggers SET config = ?, enabled = 1 WHERE id = ?").run(JSON.stringify(config), existing.id);
  } else {
    db.prepare("INSERT INTO goal_triggers (id, plan_id, kind, config, enabled) VALUES (?, ?, ?, ?, 1)").run(newId("trg"), planId, "interval", JSON.stringify(config));
  }
}
function insertRun(db, planId, trigger, status2 = "queued", skipReason) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const run = {
    id: newId("run"),
    plan_id: planId,
    trigger,
    status: status2,
    session_id: null,
    cc_session_id: null,
    holder: null,
    agent_id: null,
    summary: null,
    skip_reason: skipReason ?? null,
    items_created: 0,
    items_resolved: 0,
    started_at: now,
    ended_at: status2 === "skipped" ? now : null,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    model: null
  };
  db.prepare(`
    INSERT INTO goal_runs (id, plan_id, trigger, status, session_id, summary, skip_reason, items_created, items_resolved, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(run.id, run.plan_id, run.trigger, run.status, null, null, run.skip_reason, 0, 0, run.started_at, run.ended_at);
  return run;
}
function getRun(db, runId) {
  return db.prepare("SELECT * FROM goal_runs WHERE id = ?").get(runId);
}
function updateRun(db, runId, fields) {
  const entries = Object.entries(fields);
  if (!entries.length) return;
  db.prepare(`UPDATE goal_runs SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...entries.map(([, v]) => v), runId);
}
function listRuns(db, planId, limit = 20, opts = {}) {
  const where = opts.includeSkipped === false ? "AND status != 'skipped'" : "";
  return db.prepare(`SELECT * FROM goal_runs WHERE plan_id = ? ${where} ORDER BY started_at DESC, rowid DESC LIMIT ?`).all(planId, limit);
}
function getOpenRun(db, planId) {
  return db.prepare("SELECT * FROM goal_runs WHERE plan_id = ? AND status IN ('queued', 'running') ORDER BY started_at LIMIT 1").get(planId);
}
function countRunsSince(db, planId, sinceIso) {
  return db.prepare("SELECT COUNT(*) n FROM goal_runs WHERE plan_id = ? AND status != 'skipped' AND started_at >= ?").get(planId, sinceIso).n;
}
function deserializeMemory(r) {
  return { ...r, pinned: Boolean(r.pinned), active: Boolean(r.active) };
}
function insertMemory(db, m) {
  const text = m.text.trim();
  if (!text) throw new Error("Memory text is required.");
  const row = {
    id: newId("mem"),
    plan_id: m.plan_id,
    kind: m.kind,
    text,
    source: m.source,
    source_ref: m.source_ref ?? null,
    pinned: m.pinned ? 1 : 0,
    active: 1,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    last_used_at: null
  };
  db.prepare(`
    INSERT INTO goal_memory (id, plan_id, kind, text, source, source_ref, pinned, active, created_at, last_used_at)
    VALUES (@id, @plan_id, @kind, @text, @source, @source_ref, @pinned, @active, @created_at, @last_used_at)
  `).run(row);
  return deserializeMemory(row);
}
function getMemory(db, id) {
  const r = db.prepare("SELECT * FROM goal_memory WHERE id = ?").get(id);
  return r ? deserializeMemory(r) : void 0;
}
function listMemory(db, planId, opts = {}) {
  const rows = db.prepare(`SELECT * FROM goal_memory WHERE plan_id = ? ${opts.activeOnly ? "AND active = 1" : ""} ORDER BY created_at, rowid`).all(planId);
  return rows.map(deserializeMemory);
}
function updateMemory(db, id, fields) {
  const serialized = { ...fields };
  if ("pinned" in fields) serialized.pinned = fields.pinned ? 1 : 0;
  if ("active" in fields) serialized.active = fields.active ? 1 : 0;
  if (typeof fields.text === "string") {
    if (!fields.text.trim()) throw new Error("Memory text is required.");
    serialized.text = fields.text.trim();
  }
  const entries = Object.entries(serialized);
  if (!entries.length) return;
  db.prepare(`UPDATE goal_memory SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...entries.map(([, v]) => v), id);
}
function deleteMemory(db, id) {
  db.prepare("DELETE FROM goal_memory WHERE id = ?").run(id);
}
function deleteGoal(db, planId) {
  const plan = db.prepare("SELECT name, kind FROM plans WHERE id = ?").get(planId);
  if (!plan || plan.kind !== "goal") throw new Error(`Goal ${planId} not found.`);
  const running = db.prepare("SELECT 1 FROM goal_runs WHERE plan_id = ? AND status IN ('queued', 'running')").get(planId);
  if (running) throw new Error("This goal has a run in progress: cancel it first, then delete the goal.");
  db.transaction(() => {
    for (const table of GOAL_TABLES) db.prepare(`DELETE FROM ${table} WHERE plan_id = ?`).run(planId);
    db.prepare("DELETE FROM plans WHERE id = ?").run(planId);
  })();
  return { name: plan.name };
}
var newId, GOAL_TABLES;
var init_goals = __esm({
  "../core/src/goals.ts"() {
    "use strict";
    init_queries();
    init_types();
    newId = (prefix) => `${prefix}_${randomUUID2().replace(/-/g, "").slice(0, 12)}`;
    GOAL_TABLES = [
      "goal_watch_events",
      "goal_watches",
      "goal_tool_calls",
      "goal_health",
      "goal_memory",
      "goal_runs",
      "goal_triggers",
      "verifications",
      "events",
      "transcript_messages",
      "agent_sessions",
      "tasks",
      "goals"
    ];
  }
});

// ../core/src/gates.ts
import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
function runVerifyCommand(command2, cwd, timeoutS = DEFAULT_VERIFY_TIMEOUT_S, opts = {}) {
  const tailChars = opts.tailChars ?? OUTPUT_TAIL_CHARS;
  const started = Date.now();
  const done = (r) => ({ ...r, duration_ms: Date.now() - started });
  if (!existsSync(cwd)) {
    return Promise.resolve(done({ passed: false, exit_code: null, output: `Working directory not found: ${cwd}`, timed_out: false }));
  }
  return new Promise((resolve2) => {
    let output = "";
    let errors = "";
    let timedOut = false;
    const append = (chunk) => {
      output = (output + chunk.toString()).slice(-tailChars);
    };
    const appendErrors = (chunk) => {
      errors = (errors + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
    };
    const child = spawn(command2, {
      cwd,
      shell: true,
      windowsHide: true,
      // Own process group on POSIX so a timeout can kill the whole tree
      detached: process.platform !== "win32"
    });
    child.stdout?.on("data", append);
    child.stderr?.on("data", opts.stdoutOnly ? appendErrors : append);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutS * 1e3);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve2(done({ passed: false, exit_code: null, output: `Could not run command: ${e.message}`, timed_out: false }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut && !opts.stdoutOnly) output = `${output}
[timed out after ${timeoutS}s]`.slice(-tailChars);
      resolve2(done({ passed: !timedOut && code === 0, exit_code: code, output, timed_out: timedOut, ...opts.stdoutOnly && { stderr: errors } }));
    });
  });
}
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch {
  }
}
function hasGates(task) {
  return Boolean(task.acceptance_criteria?.length || task.verify_command || task.requires_approval);
}
function getGateStatus(db, task) {
  if (!hasGates(task)) return null;
  const last = task.verify_command ? getLatestVerification(db, task.plan_id, task.id, "command") : void 0;
  return {
    acceptance_criteria: task.acceptance_criteria ?? [],
    verify_command: task.verify_command,
    requires_approval: task.requires_approval,
    awaiting_review: task.review_requested_at !== null,
    approved: task.approved_at ? { by: task.approved_by, at: task.approved_at } : null,
    last_command: last ? { passed: last.passed, exit_code: last.exit_code, at: last.created_at, output: last.passed ? null : last.output } : null
  };
}
async function checkCompletion(db, plan, task, input) {
  const { actor } = input;
  if (!hasGates(task)) return { outcome: "pass" };
  if (actor === "agent" && task.review_requested_at) return { outcome: "awaiting_review" };
  const criteria = task.acceptance_criteria ?? [];
  if (actor === "agent" && criteria.length > 0) {
    const evidence = input.evidence ?? [];
    const missing = criteria.filter((_, i) => !evidence[i]?.trim());
    if (missing.length > 0 || evidence.length > criteria.length) {
      return {
        outcome: "blocked",
        blockers: [{
          gate: "criteria",
          message: evidence.length > criteria.length ? `Got ${evidence.length} evidence entries for ${criteria.length} criteria. Give exactly one per criterion, in order.` : `Missing evidence for ${missing.length} of ${criteria.length} acceptance criteria: ${missing.map((c) => `"${c}"`).join("; ")}. Pass \`evidence\` with one entry per criterion, in order, saying how it is met.`
        }]
      };
    }
  }
  if (task.verify_command) {
    const r = await runVerifyCommand(task.verify_command, plan.working_dir, task.verify_timeout_s ?? DEFAULT_VERIFY_TIMEOUT_S);
    insertVerification(db, {
      plan_id: plan.id,
      task_id: task.id,
      gate: "command",
      passed: r.passed,
      actor,
      command: task.verify_command,
      exit_code: r.exit_code,
      output: r.output,
      duration_ms: r.duration_ms
    });
    if (!r.passed) {
      return {
        outcome: "blocked",
        blockers: [{
          gate: "command",
          message: r.timed_out ? `Verify command timed out: ${task.verify_command}` : `Verify command failed (exit ${r.exit_code ?? "none"}): ${task.verify_command}`,
          exit_code: r.exit_code,
          output: r.output
        }]
      };
    }
  }
  if (actor === "agent" && criteria.length > 0) {
    insertVerification(db, { plan_id: plan.id, task_id: task.id, gate: "criteria", passed: true, actor, evidence: input.evidence });
  }
  if (task.requires_approval && !task.approved_at) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    if (actor === "agent") {
      updateTask(db, plan.id, task.id, { review_requested_at: now, updated_at: now });
      return { outcome: "awaiting_review" };
    }
    insertVerification(db, { plan_id: plan.id, task_id: task.id, gate: "approval", passed: true, actor });
    updateTask(db, plan.id, task.id, { approved_by: "human", approved_at: now, review_requested_at: null, updated_at: now });
  }
  return { outcome: "pass" };
}
async function runChecks(db, plan, task, actor) {
  let result = null;
  if (task.verify_command) {
    result = await runVerifyCommand(task.verify_command, plan.working_dir, task.verify_timeout_s ?? DEFAULT_VERIFY_TIMEOUT_S);
    insertVerification(db, {
      plan_id: plan.id,
      task_id: task.id,
      gate: "command",
      passed: result.passed,
      actor,
      command: task.verify_command,
      exit_code: result.exit_code,
      output: result.output,
      duration_ms: result.duration_ms
    });
  }
  return { result, gates: getGateStatus(db, getTask(db, plan.id, task.id)) };
}
function requireAwaitingReview(task) {
  if (!task.review_requested_at) throw new GateError(`Task ${task.id} is not waiting for review.`);
}
function isProposal(task) {
  return typeof task.state?.action === "object" && task.state.action !== null;
}
function asksPerson(task) {
  return task.state?.asks_person === true;
}
function approveTask(db, planId, taskId) {
  const task = mustGet(db, planId, taskId);
  requireAwaitingReview(task);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const v = insertVerification(db, { plan_id: planId, task_id: taskId, gate: "approval", passed: true, actor: "human" });
  updateTask(db, planId, taskId, {
    ...isProposal(task) ? {} : { status: "completed" },
    approved_by: "human",
    approved_at: now,
    review_requested_at: null,
    updated_at: now
  });
  return v;
}
function rejectTask(db, planId, taskId, feedback) {
  if (!feedback.trim()) throw new GateError("Feedback is required when rejecting.");
  const task = mustGet(db, planId, taskId);
  requireAwaitingReview(task);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const v = insertVerification(db, { plan_id: planId, task_id: taskId, gate: "approval", passed: false, actor: "human", output: feedback });
  const note = `Review rejected (${now}): ${feedback}`;
  updateTask(db, planId, taskId, {
    review_requested_at: null,
    approved_by: null,
    approved_at: null,
    notes: task.notes ? `${task.notes}

${note}` : note,
    updated_at: now
  });
  if (getPlan(db, planId)?.kind === "goal") {
    insertMemory(db, { plan_id: planId, kind: "preference", text: `Feedback on "${task.goal}": ${feedback.trim()}`, source: "feedback", source_ref: taskId });
  }
  return v;
}
function overrideCompletion(db, planId, taskId, reason) {
  if (!reason.trim()) throw new GateError("A reason is required to override verification.");
  const task = mustGet(db, planId, taskId);
  if (task.status === "completed") throw new GateError(`Task ${taskId} is already completed.`);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const v = insertVerification(db, { plan_id: planId, task_id: taskId, gate: "override", passed: true, actor: "human", output: reason });
  updateTask(db, planId, taskId, { status: "completed", review_requested_at: null, updated_at: now });
  return v;
}
function mustGet(db, planId, taskId) {
  const task = getTask(db, planId, taskId);
  if (!task) throw new GateError(`Task ${taskId} not found.`);
  return task;
}
function describeBlockers(blockers) {
  return blockers.map((b) => b.output ? `${b.message}
--- output (last ${OUTPUT_TAIL_CHARS} chars) ---
${b.output.trim()}` : b.message).join("\n\n");
}
var DEFAULT_VERIFY_TIMEOUT_S, OUTPUT_TAIL_CHARS, GateError;
var init_gates = __esm({
  "../core/src/gates.ts"() {
    "use strict";
    init_queries();
    init_goals();
    DEFAULT_VERIFY_TIMEOUT_S = 300;
    OUTPUT_TAIL_CHARS = 4096;
    GateError = class extends Error {
    };
  }
});

// ../core/src/schedule.ts
import { createHash, randomBytes, timingSafeEqual } from "crypto";
function parseField(text, index) {
  const [lo, hi] = RANGES[index];
  const out = /* @__PURE__ */ new Set();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`Invalid cron ${FIELD_NAMES[index]}: "${part}"`);
    const step = m[4] ? Number(m[4]) : 1;
    let from = lo;
    let to = hi;
    if (m[1] !== "*") {
      from = Number(m[2]);
      to = m[3] !== void 0 ? Number(m[3]) : m[4] ? hi : from;
    }
    if (step < 1 || from < lo || to > hi || from > to) throw new Error(`Invalid cron ${FIELD_NAMES[index]}: "${part}" (allowed ${lo}-${hi})`);
    for (let v = from; v <= to; v += step) out.add(index === 4 && v === 7 ? 0 : v);
  }
  return out;
}
function parseCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('A cron expression has 5 fields: minute hour day-of-month month day-of-week, e.g. "0 9 * * 1-5"');
  const [minute, hour, dom, month, dow] = parts.map(parseField);
  return { minute, hour, dom, month, dow, domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}
function dayMatches(f, d) {
  const dom = f.dom.has(d.getDate());
  const dow = f.dow.has(d.getDay());
  if (!f.domAny && !f.dowAny) return dom || dow;
  return dom && dow;
}
function cronNext(expr, from) {
  const f = parseCron(expr);
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 4 * 366 * 864e5;
  while (d.getTime() <= limit) {
    if (!f.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(f, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!f.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!f.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  throw new Error(`Cron expression "${expr}" never matches`);
}
function getSchedule(db, planId) {
  const interval = getIntervalTrigger(db, planId);
  if (interval?.enabled) return { kind: "interval", ...interval.config };
  const cron = listTriggers(db, planId).find((t) => t.kind === "cron" && t.enabled);
  return cron ? { kind: "cron", ...cron.config } : null;
}
function setSchedule(db, planId, schedule) {
  db.prepare("DELETE FROM goal_triggers WHERE plan_id = ? AND kind = 'cron'").run(planId);
  if (schedule?.kind === "cron") {
    cronNext(schedule.expr, /* @__PURE__ */ new Date());
    setIntervalTrigger(db, planId, null);
    db.prepare("INSERT INTO goal_triggers (id, plan_id, kind, config, enabled) VALUES (?, ?, 'cron', ?, 1)").run(newId("trg"), planId, JSON.stringify({ expr: schedule.expr.trim() }));
    return;
  }
  setIntervalTrigger(db, planId, schedule ? { minutes: schedule.minutes, ...schedule.active_hours && { active_hours: schedule.active_hours } } : null);
}
function nextScheduledRun(db, planId, from = /* @__PURE__ */ new Date()) {
  const s = getSchedule(db, planId);
  if (!s) return null;
  return s.kind === "interval" ? new Date(from.getTime() + s.minutes * 6e4).toISOString() : cronNext(s.expr, from).toISOString();
}
function getEventTrigger(db, planId) {
  return listTriggers(db, planId).find((t) => t.kind === "event");
}
function enableEventTrigger(db, planId) {
  const secret = randomBytes(24).toString("base64url");
  db.prepare("DELETE FROM goal_triggers WHERE plan_id = ? AND kind = 'event'").run(planId);
  db.prepare("INSERT INTO goal_triggers (id, plan_id, kind, config, enabled) VALUES (?, ?, 'event', ?, 1)").run(newId("trg"), planId, JSON.stringify({ secret_hash: hash(secret) }));
  return secret;
}
function disableEventTrigger(db, planId) {
  db.prepare("DELETE FROM goal_triggers WHERE plan_id = ? AND kind = 'event'").run(planId);
}
function verifyEventSecret(db, planId, secret) {
  const t = getEventTrigger(db, planId);
  if (!t?.enabled || !secret) return false;
  const expected = Buffer.from(t.config.secret_hash, "hex");
  const actual = Buffer.from(hash(secret), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
var RANGES, FIELD_NAMES, hash;
var init_schedule = __esm({
  "../core/src/schedule.ts"() {
    "use strict";
    init_goals();
    RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
    FIELD_NAMES = ["minute", "hour", "day of month", "month", "day of week"];
    hash = (secret) => createHash("sha256").update(secret).digest("hex");
  }
});

// ../core/src/health.ts
function parseHealthValue(output) {
  const matches = output.match(/-?\d+(?:\.\d+)?/g);
  return matches ? Number(matches[matches.length - 1]) : null;
}
async function runHealthCheck(db, planId) {
  const goal = getGoal(db, planId);
  const plan = getPlan(db, planId);
  if (!goal || !plan) throw new Error(`Goal ${planId} not found`);
  if (!goal.health_command) throw new Error("This goal has no health check command.");
  const r = await runVerifyCommand(goal.health_command, plan.working_dir, HEALTH_TIMEOUT_S);
  const row = {
    id: newId("hc"),
    plan_id: planId,
    passed: r.passed,
    exit_code: r.exit_code,
    value: parseHealthValue(r.output),
    output: r.output.slice(-2e3),
    duration_ms: r.duration_ms,
    created_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  db.prepare(`
    INSERT INTO goal_health (id, plan_id, passed, exit_code, value, output, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.plan_id, row.passed ? 1 : 0, row.exit_code, row.value, row.output, row.duration_ms, row.created_at);
  updateGoal(db, planId, { last_health_at: row.created_at });
  return row;
}
function listHealth(db, planId, limit = 50) {
  return db.prepare("SELECT * FROM goal_health WHERE plan_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(planId, limit).map((r) => ({ ...r, passed: Boolean(r.passed) }));
}
function healthDue(goal, now = /* @__PURE__ */ new Date()) {
  if (!goal.health_command || goal.status !== "active") return false;
  if (!goal.last_health_at) return true;
  return now.getTime() - new Date(goal.last_health_at).getTime() >= goal.health_every_minutes * 6e4;
}
var HEALTH_TIMEOUT_S;
var init_health = __esm({
  "../core/src/health.ts"() {
    "use strict";
    init_gates();
    init_goals();
    init_queries();
    HEALTH_TIMEOUT_S = 120;
  }
});

// ../core/src/guard.ts
function canonicalToolName(name) {
  return name.startsWith(PLUGIN_QUARTERDECK_TOOL_PREFIX) ? QUARTERDECK_TOOL_PREFIX + name.slice(PLUGIN_QUARTERDECK_TOOL_PREFIX.length) : name;
}
function matchToolCategory(rawMap, rawName) {
  const toolName = canonicalToolName(rawName);
  const toolMap = Object.fromEntries(Object.entries(rawMap).map(([p, c]) => [canonicalToolName(p), c]));
  if (toolMap[toolName]) return toolMap[toolName];
  const globs = Object.entries(toolMap).filter(([p]) => p.includes("*")).sort(([a], [b]) => b.length - a.length);
  for (const [pattern, category] of globs) {
    const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    if (re.test(toolName)) return category;
  }
  return null;
}
function record(db, run, toolName, category, decision, reason) {
  db.prepare(`
    INSERT INTO goal_tool_calls (id, plan_id, run_id, tool_name, category, decision, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newId("tc"), run.plan_id, run.id, toolName, category, decision, reason, (/* @__PURE__ */ new Date()).toISOString());
}
function guardToolCallForRun(db, runId, toolName) {
  const run = db.prepare("SELECT * FROM goal_runs WHERE id = ? AND status IN ('queued', 'running')").get(runId);
  return run ? guardRun(db, run, toolName) : { decision: "allow" };
}
function guardRun(db, run, toolName) {
  const goal = getGoal(db, run.plan_id);
  if (!goal) return { decision: "allow" };
  const category = matchToolCategory(goal.tool_map, toolName);
  if (!category) return { decision: "allow", run_id: run.id };
  const mode = autonomyFor(goal, category);
  if (mode === "auto") {
    record(db, run, toolName, category, "allow", null);
    return { decision: "allow", category, run_id: run.id };
  }
  if (mode === "off") {
    const reason2 = `Quarterdeck goal guard: "${category}" is off for this goal, so ${toolName} is not allowed. Don't take or propose this action.`;
    record(db, run, toolName, category, "deny", reason2);
    return { decision: "deny", category, run_id: run.id, reason: reason2 };
  }
  const approved = db.prepare(`
    SELECT COUNT(*) AS n FROM tasks
    WHERE plan_id = ? AND status = 'active' AND archived_at IS NULL AND approved_at IS NOT NULL
      AND json_extract(state, '$.action.category') = ?
  `).get(run.plan_id, category).n;
  if (approved > 0) {
    record(db, run, toolName, category, "allow", null);
    return { decision: "allow", category, run_id: run.id };
  }
  const reason = `Quarterdeck goal guard: "${category}" needs approval first. Propose it with add_item (action.category "${category}") and wait until it shows approved_to_execute; once approved, carry it out and then complete the item.`;
  record(db, run, toolName, category, "deny", reason);
  return { decision: "deny", category, run_id: run.id, reason };
}
function listToolCalls(db, planId, limit = 50) {
  return db.prepare("SELECT * FROM goal_tool_calls WHERE plan_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(planId, limit);
}
var QUARTERDECK_TOOL_PREFIX, PLUGIN_QUARTERDECK_TOOL_PREFIX;
var init_guard = __esm({
  "../core/src/guard.ts"() {
    "use strict";
    init_goal_engine();
    init_goals();
    QUARTERDECK_TOOL_PREFIX = "mcp__quarterdeck__";
    PLUGIN_QUARTERDECK_TOOL_PREFIX = "mcp__plugin_quarterdeck-goals_quarterdeck__";
  }
});

// ../core/src/watches.ts
function deserializeWatch(r) {
  return { ...r, tool_input: JSON.parse(r.tool_input || "{}"), seen: JSON.parse(r.seen || "[]") };
}
function listWatches(db, planId) {
  return db.prepare("SELECT * FROM goal_watches WHERE plan_id = ? ORDER BY name").all(planId).map(deserializeWatch);
}
function getWatch(db, id) {
  const r = db.prepare("SELECT * FROM goal_watches WHERE id = ?").get(id);
  return r ? deserializeWatch(r) : void 0;
}
function setWatch(db, planId, name, spec) {
  const goal = getGoal(db, planId);
  if (!goal) throw new Error(`Goal ${planId} not found`);
  const label = name.trim();
  if (!label) throw new Error("A watch needs a name.");
  const every = spec.every_minutes ?? WATCH_DEFAULT_MINUTES;
  if (!Number.isInteger(every) || every < WATCH_MIN_MINUTES) throw new Error(`The watch "${label}" must check every ${WATCH_MIN_MINUTES} minute or more.`);
  const what = { kind: "command", command: null, tool: null, tool_input: "{}", match: null };
  const given = spec;
  if (given.tool !== void 0) {
    const tool = String(given.tool).trim();
    if (!tool) throw new Error(`The watch "${label}" needs a tool.`);
    if (given.command) throw new Error(`The watch "${label}" has a command and a tool: give one.`);
    if (!tool.startsWith("mcp__")) throw new Error(`The watch "${label}" can only call a connector or MCP tool (mcp__\u2026), not ${tool}.`);
    if (canonicalToolName(tool).startsWith(QUARTERDECK_TOOL_PREFIX) || /^mcp__quarterdeck-(goals|guard)__/.test(tool)) {
      throw new Error(`The watch "${label}" can't call Quarterdeck's own tools.`);
    }
    const category = matchToolCategory(goal.tool_map, tool);
    const mode = category ? goal.autonomy[category] ?? "propose" : "auto";
    if (mode !== "auto") {
      throw new Error(`The watch "${label}" can't call ${tool}: this goal's rules put it under "${category}", which is ${mode}. A watch may only read.`);
    }
    if (given.match !== void 0) {
      try {
        new RegExp(given.match);
      } catch {
        throw new Error(`The watch "${label}" has a match that isn't a regular expression: ${given.match}`);
      }
    }
    Object.assign(what, { kind: "tool", tool, tool_input: JSON.stringify(given.input ?? {}), match: given.match?.trim() || null });
  } else {
    const command2 = String(given.command ?? "").trim();
    if (!command2) throw new Error(`The watch "${label}" needs a command.`);
    what.command = command2;
  }
  const existing = listWatches(db, planId).find((w) => w.name === label);
  if (!existing) {
    const id = newId("wch");
    db.prepare("INSERT INTO goal_watches (id, plan_id, name, kind, command, tool, tool_input, match, every_minutes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, planId, label, what.kind, what.command, what.tool, what.tool_input, what.match, every, (/* @__PURE__ */ new Date()).toISOString());
    return getWatch(db, id);
  }
  const same = existing.kind === what.kind && existing.command === what.command && existing.tool === what.tool && JSON.stringify(existing.tool_input) === what.tool_input && existing.match === what.match;
  if (same) {
    db.prepare("UPDATE goal_watches SET every_minutes = ? WHERE id = ?").run(every, existing.id);
  } else {
    db.prepare(`
      UPDATE goal_watches SET kind = ?, command = ?, tool = ?, tool_input = ?, match = ?, every_minutes = ?, seen = '[]', baseline_at = NULL,
        last_checked_at = NULL, asked_at = NULL, last_error = NULL, fail_count = 0 WHERE id = ?
    `).run(what.kind, what.command, what.tool, what.tool_input, what.match, every, existing.id);
    db.prepare("DELETE FROM goal_watch_events WHERE watch_id = ? AND run_id IS NULL").run(existing.id);
  }
  return getWatch(db, existing.id);
}
function describeWatch(w) {
  if (w.kind === "command") return w.command ?? "";
  const input = Object.keys(w.tool_input).length ? ` ${JSON.stringify(w.tool_input)}` : "";
  return `${w.tool}${input}${w.match ? ` (lines: ${w.match})` : ""}`;
}
function removeWatch(db, planId, name) {
  const watch = listWatches(db, planId).find((w) => w.name === name.trim());
  if (!watch) return false;
  db.prepare("DELETE FROM goal_watch_events WHERE watch_id = ? AND run_id IS NULL").run(watch.id);
  db.prepare("DELETE FROM goal_watches WHERE id = ?").run(watch.id);
  return true;
}
function watchDue(watch, now = /* @__PURE__ */ new Date()) {
  if (!watch.last_checked_at) return true;
  return now.getTime() - new Date(watch.last_checked_at).getTime() >= watch.every_minutes * 6e4;
}
function watchFailing(watch) {
  return watch.fail_count >= WATCH_FAILING_AFTER;
}
function toLines(output) {
  const lines = /* @__PURE__ */ new Set();
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim().slice(0, WATCH_LINE_CHARS);
    if (line) lines.add(line);
    if (lines.size >= WATCH_MAX_LINES) break;
  }
  return [...lines];
}
function recordWatchLines(db, watchId, result, now = /* @__PURE__ */ new Date()) {
  const watch = getWatch(db, watchId);
  if (!watch) throw new Error(`Watch ${watchId} not found`);
  const at = now.toISOString();
  if ("error" in result) {
    const error = result.error.trim().slice(-500) || "The check failed.";
    db.prepare("UPDATE goal_watches SET last_checked_at = ?, last_error = ?, fail_count = fail_count + 1 WHERE id = ?").run(at, error, watchId);
    return { baseline: false, lines: 0, fresh: [], error };
  }
  const known = new Set(watch.seen);
  const baseline = watch.baseline_at === null;
  const fresh = baseline ? [] : result.lines.filter((l) => !known.has(l));
  const current = new Set(result.lines);
  const seen = [...result.lines, ...watch.seen.filter((l) => !current.has(l))].slice(0, WATCH_SEEN_MAX);
  db.transaction(() => {
    const insert = db.prepare("INSERT INTO goal_watch_events (id, watch_id, plan_id, line, created_at) VALUES (?, ?, ?, ?, ?)");
    for (const line of fresh) insert.run(newId("wev"), watchId, watch.plan_id, line, at);
    db.prepare("UPDATE goal_watches SET seen = ?, baseline_at = COALESCE(baseline_at, ?), last_checked_at = ?, fail_count = 0 WHERE id = ?").run(JSON.stringify(seen), at, at, watchId);
    if (watch.last_error !== null) db.prepare("UPDATE goal_watches SET last_error = NULL WHERE id = ?").run(watchId);
    if (fresh.length) db.prepare("UPDATE goal_watches SET last_fired_at = ? WHERE id = ?").run(at, watchId);
    db.prepare("DELETE FROM goal_watch_events WHERE watch_id = ? AND run_id IS NOT NULL AND created_at < ?").run(watchId, new Date(now.getTime() - EVENT_RETENTION_MS).toISOString());
  })();
  return { baseline, lines: result.lines.length, fresh };
}
async function checkCommandWatch(db, watchId, now = /* @__PURE__ */ new Date()) {
  const watch = getWatch(db, watchId);
  if (!watch) throw new Error(`Watch ${watchId} not found`);
  const plan = getPlan(db, watch.plan_id);
  if (!plan || watch.kind !== "command" || !watch.command) throw new Error(`Watch ${watchId} has no command to run`);
  const r = await runVerifyCommand(watch.command, plan.working_dir, WATCH_TIMEOUT_S, { stdoutOnly: true, tailChars: WATCH_OUTPUT_CHARS });
  if (r.passed) return recordWatchLines(db, watchId, { lines: toLines(r.output) }, now);
  const why = r.timed_out ? `Timed out after ${WATCH_TIMEOUT_S} s` : r.exit_code === null ? r.output : `Exit code ${r.exit_code}${r.stderr?.trim() ? `: ${r.stderr.trim()}` : ""}`;
  return recordWatchLines(db, watchId, { error: why }, now);
}
function matchLines(text, pattern) {
  const re = new RegExp(pattern ?? WATCH_DEFAULT_MATCH, "g");
  const found = [];
  for (const m of text.matchAll(re)) {
    if (m[0] === "") break;
    found.push((m[1] ?? m[0]).replace(/\s+/g, " "));
    if (found.length >= WATCH_MAX_LINES * 2) break;
  }
  return toLines(found.join("\n"));
}
function takeDueToolWatches(db, planIds, now = /* @__PURE__ */ new Date()) {
  const calls = [];
  for (const planId of planIds) {
    for (const w of listWatches(db, planId)) {
      if (w.kind !== "tool" || !w.tool || !watchDue(w, now)) continue;
      if (w.asked_at && now.getTime() - new Date(w.asked_at).getTime() < WATCH_REPORT_GRACE_MS) continue;
      db.prepare("UPDATE goal_watches SET asked_at = ? WHERE id = ?").run(now.toISOString(), w.id);
      calls.push({ watch_id: w.id, goal_id: planId, name: w.name, tool: w.tool, input: w.tool_input });
    }
  }
  return calls;
}
function reportToolWatch(db, watchId, result, now = /* @__PURE__ */ new Date()) {
  const watch = getWatch(db, watchId);
  if (!watch || watch.kind !== "tool") throw new Error(`Tool watch ${watchId} not found`);
  db.prepare("UPDATE goal_watches SET asked_at = NULL WHERE id = ?").run(watchId);
  if ("error" in result) return recordWatchLines(db, watchId, { error: result.error }, now);
  return recordWatchLines(db, watchId, { lines: matchLines(result.text, watch.match) }, now);
}
function countUnqueuedWatchEvents(db, planId) {
  return db.prepare("SELECT COUNT(*) n FROM goal_watch_events WHERE plan_id = ? AND run_id IS NULL AND queued_at IS NULL").get(planId).n;
}
function markWatchEventsQueued(db, planId, now = /* @__PURE__ */ new Date()) {
  db.prepare("UPDATE goal_watch_events SET queued_at = ? WHERE plan_id = ? AND run_id IS NULL AND queued_at IS NULL").run(now.toISOString(), planId);
}
function takeWatchEvents(db, planId, runId) {
  if (runId) db.prepare("UPDATE goal_watch_events SET run_id = ? WHERE plan_id = ? AND run_id IS NULL").run(runId, planId);
  const rows = db.prepare(`
    SELECT e.line, COALESCE(w.name, 'a removed watch') AS watch
    FROM goal_watch_events e LEFT JOIN goal_watches w ON w.id = e.watch_id
    WHERE e.plan_id = ? AND ${runId ? "e.run_id = ?" : "e.run_id IS NULL"}
    ORDER BY e.created_at, e.rowid
  `).all(...runId ? [planId, runId] : [planId]);
  const byWatch = /* @__PURE__ */ new Map();
  for (const r of rows) byWatch.set(r.watch, [...byWatch.get(r.watch) ?? [], r.line]);
  return [...byWatch.entries()].map(([watch, lines]) => ({
    watch,
    new: lines.slice(0, WATCH_BRIEF_LINES),
    omitted: Math.max(0, lines.length - WATCH_BRIEF_LINES)
  }));
}
function releaseWatchEvents(db, runId, opts = {}) {
  db.prepare(`UPDATE goal_watch_events SET run_id = NULL${opts.requeue ? ", queued_at = NULL" : ""} WHERE run_id = ?`).run(runId);
}
function listWatchEvents(db, planId) {
  return db.prepare("SELECT * FROM goal_watch_events WHERE plan_id = ? ORDER BY created_at, rowid").all(planId);
}
var WATCH_TIMEOUT_S, WATCH_MAX_LINES, WATCH_LINE_CHARS, WATCH_SEEN_MAX, WATCH_OUTPUT_CHARS, WATCH_FAILING_AFTER, WATCH_BRIEF_LINES, WATCH_MIN_MINUTES, WATCH_DEFAULT_MINUTES, WATCH_DEFAULT_MATCH, WATCH_REPORT_GRACE_MS, EVENT_RETENTION_MS;
var init_watches = __esm({
  "../core/src/watches.ts"() {
    "use strict";
    init_gates();
    init_goals();
    init_guard();
    init_queries();
    WATCH_TIMEOUT_S = 30;
    WATCH_MAX_LINES = 200;
    WATCH_LINE_CHARS = 300;
    WATCH_SEEN_MAX = 1e3;
    WATCH_OUTPUT_CHARS = 64 * 1024;
    WATCH_FAILING_AFTER = 3;
    WATCH_BRIEF_LINES = 50;
    WATCH_MIN_MINUTES = 1;
    WATCH_DEFAULT_MINUTES = 5;
    WATCH_DEFAULT_MATCH = String.raw`"id"\s*:\s*"([^"]+)"`;
    WATCH_REPORT_GRACE_MS = 2 * 6e4;
    EVENT_RETENTION_MS = 30 * 864e5;
  }
});

// ../core/src/goal-engine.ts
function autonomyFor(goal, category) {
  return goal.autonomy[category] ?? "propose";
}
function mustGetGoal(db, planId) {
  const goal = getGoal(db, planId);
  if (!goal) throw new GoalError(`Plan ${planId} is not a persistent goal.`);
  return goal;
}
function addItem(db, planId, runId, input) {
  const goal = mustGetGoal(db, planId);
  if (goal.status === "retired") throw new GoalError("This goal is retired.");
  if (input.external_ref) {
    const row = db.prepare("SELECT * FROM tasks WHERE plan_id = ? AND external_ref = ?").get(planId, input.external_ref);
    if (row) return { task: deserializeTask(row), existing: true };
  }
  if (runId) {
    const created = db.prepare("SELECT COUNT(*) n FROM tasks WHERE plan_id = ? AND run_id = ?").get(planId, runId).n;
    if (created >= goal.limits.max_items_per_run) {
      throw new GoalError(`This run already created ${created} items (limit ${goal.limits.max_items_per_run}). Finish with end_run; the rest can wait for the next run.`);
    }
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const id = nextChildId(db, planId, null);
  const base = {
    id,
    plan_id: planId,
    goal: input.goal,
    result: input.result ?? null,
    abandon_reason: null,
    depends_on: null,
    notes: input.notes ?? null,
    run_id: runId,
    external_ref: input.external_ref ?? null,
    created_by: "agent",
    created_at: now,
    updated_at: now
  };
  if (!input.action) {
    if (input.ask_person) {
      insertTask(db, { ...base, status: "active", state: { asks_person: true }, requires_approval: true, review_requested_at: now });
    } else {
      insertTask(db, { ...base, status: input.status ?? "pending", state: {} });
    }
    return { task: getTask(db, planId, id), existing: false };
  }
  const mode = autonomyFor(goal, input.action.category);
  if (mode === "off") {
    throw new GoalError(`Action category "${input.action.category}" is off for this goal: don't take or propose this action.`);
  }
  const state = { action: { ...input.action, params: input.action.params ?? {} } };
  if (mode === "propose") {
    insertTask(db, { ...base, status: "active", state, requires_approval: true, review_requested_at: now });
  } else {
    insertTask(db, { ...base, status: "completed", state, result: input.result ?? `Done automatically: ${input.action.summary}` });
  }
  return { task: getTask(db, planId, id), existing: false, mode };
}
function summarizeItem(t) {
  const action = isProposal(t) ? t.state.action : void 0;
  return {
    id: t.id,
    goal: t.goal,
    status: t.status,
    external_ref: t.external_ref,
    awaiting_review: t.review_requested_at !== null,
    approved_to_execute: action !== void 0 && t.approved_at !== null && t.status === "active",
    ...action && { action }
  };
}
function buildBrief(db, planId, runId) {
  const goal = mustGetGoal(db, planId);
  const plan = getPlan(db, planId);
  const run = runId ? getRun(db, runId) : void 0;
  if (runId && (!run || run.plan_id !== planId)) throw new GoalError(`Run ${runId} not found for this goal.`);
  const previous = listRuns(db, planId, 10, { includeSkipped: false }).find((r) => r.id !== runId && r.status !== "queued" && r.status !== "running");
  const since = previous?.started_at ?? "1970-01-01T00:00:00.000Z";
  const decisions = db.prepare(`
    SELECT v.task_id, v.gate, v.passed, v.output, v.created_at, t.goal, t.state
    FROM verifications v JOIN tasks t ON t.plan_id = v.plan_id AND t.id = v.task_id
    WHERE v.plan_id = ? AND v.gate IN ('approval', 'override') AND v.actor = 'human' AND v.created_at > ?
    ORDER BY v.created_at
  `).all(planId, since).map((d) => {
    const action = JSON.parse(d.state).action;
    return {
      item: d.task_id,
      goal: d.goal,
      decision: d.gate === "override" ? "completed_by_human" : d.passed ? "approved" : "rejected",
      ...d.output && { feedback: d.output },
      ...action && { action },
      at: d.created_at
    };
  });
  const active = listMemory(db, planId, { activeOnly: true });
  const ordered = [
    ...active.filter((m) => m.pinned),
    ...active.filter((m) => !m.pinned).sort((a, b) => (b.last_used_at ?? b.created_at).localeCompare(a.last_used_at ?? a.created_at))
  ];
  const memory = [];
  let chars = 0;
  for (const m of ordered) {
    if (!m.pinned && chars + m.text.length > MEMORY_BRIEF_CHARS) continue;
    memory.push(m);
    chars += m.text.length;
  }
  const nowIso = (/* @__PURE__ */ new Date()).toISOString();
  for (const m of memory) updateMemory(db, m.id, { last_used_at: nowIso });
  const items = db.prepare("SELECT * FROM tasks WHERE plan_id = ? AND archived_at IS NULL AND status IN ('pending', 'active')").all(planId).map(deserializeTask).map(summarizeItem).sort((a, b) => Number(b.approved_to_execute) - Number(a.approved_to_execute) || compareTaskIds(a.id, b.id));
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  const resolved24h = db.prepare("SELECT COUNT(*) n FROM tasks WHERE plan_id = ? AND status IN ('completed', 'abandoned') AND updated_at >= ?").get(planId, dayAgo).n;
  return {
    goal: { id: planId, name: plan.name, objective: goal.objective, instructions: goal.instructions, status: goal.status },
    run: run ? { id: run.id, trigger: run.trigger, started_at: run.started_at, limits: goal.limits } : null,
    autonomy: { default: "propose", categories: goal.autonomy },
    memory: memory.map((m) => ({ id: m.id, kind: m.kind, text: m.text, source: m.source, pinned: m.pinned })),
    memory_omitted: active.length - memory.length,
    decisions_since_last_run: decisions,
    open_items: items,
    recent_runs: listRuns(db, planId, 10, { includeSkipped: false }).filter((r) => r.id !== runId && r.summary).slice(0, 3).map((r) => ({ at: r.started_at, summary: r.summary })),
    counts: {
      open: items.length,
      awaiting_review: items.filter((i) => i.awaiting_review).length,
      approved_to_execute: items.filter((i) => i.approved_to_execute).length,
      resolved_last_24h: resolved24h
    },
    health: (() => {
      const [h] = listHealth(db, planId, 1);
      return h ? { passed: h.passed, value: h.value, at: h.created_at, ...!h.passed && h.output && { output: h.output.slice(-500) } } : null;
    })(),
    watch_events: takeWatchEvents(db, planId, runId)
  };
}
function queueRun(db, planId, trigger = "manual") {
  const goal = mustGetGoal(db, planId);
  if (goal.status !== "active") throw new GoalError(`Goal is ${goal.status}; resume it before running.`);
  return getOpenRun(db, planId) ?? insertRun(db, planId, trigger, "queued");
}
function startRun(db, runId, sessionId) {
  const run = getRun(db, runId);
  if (!run) throw new GoalError(`Run ${runId} not found.`);
  updateRun(db, runId, { status: "running", session_id: sessionId, started_at: (/* @__PURE__ */ new Date()).toISOString() });
  updateGoal(db, run.plan_id, { last_run_at: (/* @__PURE__ */ new Date()).toISOString() });
  return getRun(db, runId);
}
function endRun(db, runId, summary) {
  const run = getRun(db, runId);
  if (!run) throw new GoalError(`Run ${runId} not found.`);
  if (run.status !== "running" && run.status !== "queued") throw new GoalError(`Run ${runId} already ended (${run.status}).`);
  if (!summary.trim()) throw new GoalError("A summary is required: what you did, what is waiting, what you learned.");
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const created = db.prepare("SELECT COUNT(*) n FROM tasks WHERE plan_id = ? AND run_id = ?").get(run.plan_id, runId).n;
  const resolved = db.prepare("SELECT COUNT(*) n FROM tasks WHERE plan_id = ? AND status IN ('completed', 'abandoned') AND updated_at >= ?").get(run.plan_id, run.started_at).n;
  updateRun(db, runId, { status: "completed", summary: summary.trim(), ended_at: now, items_created: created, items_resolved: resolved });
  archiveResolved(db, run.plan_id);
  finishIfDone(db, run.plan_id);
  return getRun(db, runId);
}
function countOpenItems(db, planId) {
  return db.prepare("SELECT COUNT(*) n FROM tasks WHERE plan_id = ? AND archived_at IS NULL AND status IN ('pending', 'active')").get(planId).n;
}
function finishIfDone(db, planId) {
  const goal = getGoal(db, planId);
  if (!goal?.one_off || goal.status !== "active" || countOpenItems(db, planId) > 0) return false;
  updateGoal(db, planId, { status: "retired", next_run_at: null });
  return true;
}
function failRun(db, runId, status2, reason) {
  const run = getRun(db, runId);
  if (!run || run.status !== "running" && run.status !== "queued") return;
  updateRun(db, runId, { status: status2, ended_at: (/* @__PURE__ */ new Date()).toISOString(), summary: run.summary ?? reason });
  releaseWatchEvents(db, runId);
}
function archiveResolved(db, planId, now = /* @__PURE__ */ new Date()) {
  const goal = getGoal(db, planId);
  if (!goal) return 0;
  const cutoff = new Date(now.getTime() - goal.item_retention_days * 864e5).toISOString();
  return db.prepare(`
    UPDATE tasks SET archived_at = ?
    WHERE plan_id = ? AND archived_at IS NULL AND status IN ('completed', 'abandoned') AND updated_at < ?
  `).run(now.toISOString(), planId, cutoff).changes;
}
function withinActiveHours(activeHours, date) {
  if (!activeHours) return true;
  const [start2, end] = activeHours.split("-").map((s) => {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  });
  const minutes = date.getHours() * 60 + date.getMinutes();
  return start2 <= end ? minutes >= start2 && minutes < end : minutes >= start2 || minutes < end;
}
function decideTick(db, planId, now = /* @__PURE__ */ new Date()) {
  const goal = getGoal(db, planId);
  if (!goal || goal.status !== "active") return { action: "none" };
  const open = getOpenRun(db, planId);
  if (open?.status === "running") return { action: "none" };
  const schedule = getSchedule(db, planId);
  const queued = open?.status === "queued" ? open : void 0;
  const scheduleDue = Boolean(schedule && goal.next_run_at && goal.next_run_at <= now.toISOString());
  if (!queued && !scheduleDue) return { action: "none" };
  if (!queued && schedule?.kind === "interval" && !withinActiveHours(schedule.active_hours, now)) {
    return { action: "defer", next_run_at: new Date(now.getTime() + schedule.minutes * 6e4).toISOString() };
  }
  const kind = queued ? queued.trigger : schedule.kind;
  const runsToday = countRunsSince(db, planId, new Date(now.getTime() - 864e5).toISOString()) - (queued ? 1 : 0);
  if (runsToday >= goal.limits.max_runs_per_day) {
    return { action: "skip", trigger: kind, reason: `daily run limit reached (${goal.limits.max_runs_per_day})`, queuedRunId: queued?.id };
  }
  return { action: "start", trigger: kind, queuedRunId: queued?.id };
}
function nextIntervalRun(db, planId, from = /* @__PURE__ */ new Date()) {
  return nextScheduledRun(db, planId, from);
}
function recordSkip(db, planId, trigger, reason, now = /* @__PURE__ */ new Date()) {
  const hourAgo = new Date(now.getTime() - 36e5).toISOString();
  const recent = db.prepare("SELECT 1 FROM goal_runs WHERE plan_id = ? AND status = 'skipped' AND skip_reason = ? AND started_at >= ?").get(planId, reason, hourAgo);
  return recent ? null : insertRun(db, planId, trigger, "skipped", reason);
}
var GoalError, MEMORY_BRIEF_CHARS;
var init_goal_engine = __esm({
  "../core/src/goal-engine.ts"() {
    "use strict";
    init_queries();
    init_gates();
    init_goals();
    init_schedule();
    init_health();
    init_watches();
    GoalError = class extends Error {
    };
    MEMORY_BRIEF_CHARS = 4e3;
  }
});

// ../core/src/goal-changes.ts
function applyGoalChanges(db, planId, changes) {
  const goal = getGoal(db, planId);
  const plan = getPlan(db, planId);
  if (!goal || !plan) throw new GoalError(`Goal ${planId} not found.`);
  for (const [category, mode] of Object.entries(changes.autonomy ?? {})) {
    if (mode !== null && !MODES.has(mode)) throw new GoalError(`"${mode}" isn't a mode for ${category}: use off, propose or auto.`);
  }
  for (const id of changes.forget_memory ?? []) {
    if (getMemory(db, id)?.plan_id !== planId) throw new GoalError(`Memory ${id} isn't this goal's.`);
  }
  const done = [];
  db.transaction(() => {
    if (changes.name?.trim() && changes.name.trim() !== plan.name) {
      updatePlan(db, planId, { name: changes.name.trim(), updated_at: (/* @__PURE__ */ new Date()).toISOString() });
      done.push(`renamed to "${changes.name.trim()}"`);
    }
    if (changes.objective?.trim() && changes.objective.trim() !== goal.objective) {
      updateGoal(db, planId, { objective: changes.objective.trim() });
      updatePlan(db, planId, { description: changes.objective.trim() });
      done.push("objective changed");
    }
    if (changes.instructions !== void 0 && changes.instructions !== goal.instructions) {
      updateGoal(db, planId, { instructions: changes.instructions });
      done.push(changes.instructions.trim() ? "instructions changed" : "instructions cleared");
    }
    if (changes.autonomy && Object.keys(changes.autonomy).length) {
      const autonomy = { ...goal.autonomy };
      for (const [category, mode] of Object.entries(changes.autonomy)) {
        if (mode === null) delete autonomy[category];
        else autonomy[category] = mode;
        done.push(mode === null ? `${category}: back to propose` : `${category}: ${mode}`);
      }
      updateGoal(db, planId, { autonomy });
    }
    if (changes.tool_map && Object.keys(changes.tool_map).length) {
      const toolMap = { ...goal.tool_map };
      for (const [pattern, category] of Object.entries(changes.tool_map)) {
        if (category === null) delete toolMap[pattern];
        else toolMap[pattern] = category;
        done.push(category === null ? `tool rule ${pattern} removed` : `tool rule ${pattern} \u2192 ${category}`);
      }
      updateGoal(db, planId, { tool_map: toolMap });
    }
    for (const m of changes.add_memory ?? []) {
      insertMemory(db, { plan_id: planId, kind: m.kind, text: m.text, source: "human", pinned: m.pinned ?? false });
      done.push(`remembered (${m.kind}): ${m.text}`);
    }
    for (const id of changes.forget_memory ?? []) {
      updateMemory(db, id, { active: false });
      done.push(`forgot memory ${id}`);
    }
    const watches = listWatches(db, planId);
    for (const [name, spec] of Object.entries(changes.watches ?? {})) {
      if (spec === null) {
        if (removeWatch(db, planId, name)) done.push(`watch "${name.trim()}" removed`);
        continue;
      }
      const before = watches.find((w) => w.name === name.trim());
      const after = setWatch(db, planId, name, spec);
      if (before && describeWatch(before) === describeWatch(after) && before.every_minutes === after.every_minutes) continue;
      done.push(`watch "${after.name}" ${before ? "changed" : "added"}: every ${after.every_minutes} min, ${after.kind === "tool" ? "calls" : "runs"} ${describeWatch(after)}`);
    }
    if (changes.status && changes.status !== goal.status) {
      if (goal.status === "retired") throw new GoalError("This goal is done; run it again first.");
      updateGoal(db, planId, { status: changes.status });
      done.push(changes.status === "paused" ? "paused" : "resumed");
    }
  })();
  return done;
}
function getRunHold(db, now = /* @__PURE__ */ new Date()) {
  const row = db.prepare("SELECT until, reason FROM goal_run_hold WHERE id = 1").get();
  if (!row) return null;
  if (row.until <= now.toISOString()) {
    db.prepare("DELETE FROM goal_run_hold WHERE id = 1").run();
    return null;
  }
  return row;
}
function setRunHold(db, hold) {
  db.prepare("INSERT INTO goal_run_hold (id, until, reason) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET until = excluded.until, reason = excluded.reason").run(hold.until, hold.reason);
}
function clearRunHold(db) {
  db.prepare("DELETE FROM goal_run_hold WHERE id = 1").run();
}
function isUsageLimit(text) {
  return LIMIT.test(text);
}
function parseLimitReset(text, now = /* @__PURE__ */ new Date()) {
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const meridiem = m[3]?.toLowerCase();
  if (hour > 23 || minute > 59 || meridiem && hour > 12) return null;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}
function addRunUsage(db, runId, usage) {
  db.prepare(`
    UPDATE goal_runs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
      cache_read_tokens = cache_read_tokens + ?, cache_write_tokens = cache_write_tokens + ?, model = COALESCE(?, model)
    WHERE id = ?
  `).run(usage.input_tokens || 0, usage.output_tokens || 0, usage.cache_read_input_tokens || 0, usage.cache_creation_input_tokens || 0, usage.model ?? null, runId);
}
function reportRunEnd(db, runId, input, now = /* @__PURE__ */ new Date()) {
  const run = getRun(db, runId);
  if (!run) return { outcome: "unchanged" };
  if (input.usage) addRunUsage(db, runId, input.usage);
  if (run.status !== "running") return { outcome: "unchanged" };
  const answer = input.answer.trim();
  if (isUsageLimit(answer)) {
    const until = (parseLimitReset(answer, now) ?? new Date(now.getTime() + DEFAULT_HOLD_MS)).toISOString();
    const hold = { until, reason: answer.split("\n")[0].slice(0, 200) };
    updateRun(db, runId, { status: "skipped", skip_reason: `usage limit reached: ${hold.reason}`, ended_at: now.toISOString() });
    releaseWatchEvents(db, runId, { requeue: true });
    setRunHold(db, hold);
    return { outcome: "held", hold };
  }
  if (input.reason === "error") {
    failRun(db, runId, "failed", `The agent stopped on an error: ${answer.slice(0, 300) || "no message"}`);
    return { outcome: "failed" };
  }
  return { outcome: "unchanged" };
}
var MODES, LIMIT, DEFAULT_HOLD_MS;
var init_goal_changes = __esm({
  "../core/src/goal-changes.ts"() {
    "use strict";
    init_queries();
    init_goals();
    init_goal_engine();
    init_watches();
    MODES = /* @__PURE__ */ new Set(["off", "propose", "auto"]);
    LIMIT = /(hit|reached) (your|the) .{0,30}limit|usage limit|rate limit|out of (credits|usage)/i;
    DEFAULT_HOLD_MS = 30 * 6e4;
  }
});

// ../core/src/goal-tick.ts
function takeLease(db, holder, now = /* @__PURE__ */ new Date()) {
  db.prepare(`
    INSERT INTO scheduler_lease (name, holder, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
    WHERE scheduler_lease.holder = excluded.holder OR scheduler_lease.expires_at <= ?
  `).run(LEASE_NAME, holder, new Date(now.getTime() + LEASE_MS).toISOString(), now.toISOString());
  const row = db.prepare("SELECT holder FROM scheduler_lease WHERE name = ?").get(LEASE_NAME);
  return row.holder === holder;
}
function releaseLease(db, holder) {
  db.prepare("DELETE FROM scheduler_lease WHERE name = ? AND holder = ?").run(LEASE_NAME, holder);
}
function leaseHolder(db, now = /* @__PURE__ */ new Date()) {
  const row = db.prepare("SELECT holder FROM scheduler_lease WHERE name = ? AND expires_at > ?").get(LEASE_NAME, now.toISOString());
  return row?.holder ?? null;
}
function goalRunPrompt(p) {
  return [
    `Run persistent goal "${p.name}" (goal ID: ${p.goalId}, run ID: ${p.runId}). Working directory: ${p.workingDir}.`,
    `You start with no memory of earlier runs: call get_goal_brief with goal_id "${p.goalId}" and run_id "${p.runId}" first. It has the objective, standing instructions, memory, human decisions since the last run, open items and recent run summaries. Its watch_events, when there are any, are what is new since the last run (one line per new thing, such as an issue number): deal with those first.`,
    "Then: carry out approved actions first and complete those items; revise rejected ones using the feedback (update the proposal's state.action with update_task, then set_status completed to send it for review again) or abandon them; look for new work and add each piece with add_item (always with external_ref for outside things); stay within each action category's autonomy (auto: do it, then record it; propose: add_item and wait for approval; off: never). A tool call refused by the Quarterdeck goal guard means: propose it with add_item instead.",
    "When you need something only the person can give or do (a choice, details you can't find, connecting a service, allowing a site), add_item with ask_person: true and one clear question, and carry on with what you can; don't guess. Their answer arrives as memory and the item is completed.",
    "Save anything future runs should know with remember.",
    'Your summary, items and memory are read by the person who owns this goal: write to them as "you", and never guess their gender or pronouns.',
    `You have about ${p.maxRunMinutes} minutes; leave the rest for the next run. Don't wait on long background commands. Finish with end_run and a short summary: that summary is your report, so your final message can be one line.`
  ].join("\n\n");
}
function claimRun(db, planId, opts) {
  const now = (opts.now ?? /* @__PURE__ */ new Date()).toISOString();
  const claim = db.transaction(() => {
    const run2 = opts.queuedRunId ? getRun(db, opts.queuedRunId) : insertRun(db, planId, opts.trigger ?? "manual", "queued");
    if (!run2) return null;
    const changed = db.prepare("UPDATE goal_runs SET status = 'running', holder = ?, started_at = ? WHERE id = ? AND status = 'queued'").run(opts.holder, now, run2.id).changes;
    if (!changed) return null;
    updateGoal(db, planId, { last_run_at: now });
    return getRun(db, run2.id);
  });
  const run = claim();
  if (!run) return null;
  const goal = getGoal(db, planId);
  const plan = listGoals(db).find((g) => g.plan.id === planId).plan;
  return {
    run_id: run.id,
    goal_id: planId,
    name: plan.name,
    working_dir: plan.working_dir,
    trigger: run.trigger,
    max_run_minutes: goal.limits.max_run_minutes,
    prompt: goalRunPrompt({ goalId: planId, runId: run.id, name: plan.name, workingDir: plan.working_dir, maxRunMinutes: goal.limits.max_run_minutes })
  };
}
function attachAgent(db, runId, agentId) {
  updateRun(db, runId, { agent_id: agentId });
}
function expireStaleRuns(db, now = /* @__PURE__ */ new Date(), opts = {}) {
  const rows = db.prepare(`
    SELECT r.id, r.started_at, g.limits FROM goal_runs r JOIN goals g ON g.plan_id = r.plan_id WHERE r.status = 'running'
  `).all();
  const expired = [];
  for (const r of rows) {
    if (opts.skipRunIds?.has(r.id)) continue;
    const maxMinutes = JSON.parse(r.limits || "{}").max_run_minutes ?? 15;
    if (now.getTime() - new Date(r.started_at).getTime() > maxMinutes * 6e4 + STALE_GRACE_MS) {
      failRun(db, r.id, "timed_out", "Run did not finish (Claude Code closed or the agent stopped responding)");
      expired.push(r.id);
    }
  }
  return expired;
}
async function checkHealth(db, planId) {
  const result = await runHealthCheck(db, planId);
  const goal = getGoal(db, planId);
  let queuedRun = false;
  if (!result.passed && goal?.health_triggers_run && goal.status === "active" && !getOpenRun(db, planId)) {
    queueRun(db, planId, "health");
    queuedRun = true;
  }
  return { passed: result.passed, queuedRun };
}
async function checkWatches(db, planIds, now = /* @__PURE__ */ new Date(), budgetMs = WATCH_BUDGET_MS) {
  const started = Date.now();
  let checked = 0;
  for (const planId of planIds) {
    for (const watch of listWatches(db, planId)) {
      if (watch.kind !== "command" || !watchDue(watch, now)) continue;
      if (Date.now() - started >= budgetMs) return checked;
      await checkCommandWatch(db, watch.id, now).catch(() => {
      });
      checked++;
    }
  }
  return checked;
}
function queueForWatchEvents(db, planId, now = /* @__PURE__ */ new Date()) {
  if (countUnqueuedWatchEvents(db, planId) === 0) return null;
  const open = getOpenRun(db, planId);
  if (open?.status === "running") return null;
  const run = open ?? queueRun(db, planId, "watch");
  markWatchEventsQueued(db, planId, now);
  return run;
}
async function schedulerPass(db, opts) {
  const now = opts.now ?? /* @__PURE__ */ new Date();
  if (schemaOutdated(db)) return { leader: false, claimed: [], expired: [], outdated: true };
  if (!opts.ignoreLease && !takeLease(db, opts.holder, now)) return { leader: false, claimed: [], expired: [] };
  const expired = expireStaleRuns(db, now, { skipRunIds: opts.trackedRunIds });
  const goals = listGoals(db, "active");
  for (const { goal } of goals) {
    if (!healthDue(goal, now)) continue;
    await checkHealth(db, goal.plan_id).catch(() => {
    });
  }
  await checkWatches(db, goals.map(({ plan }) => plan.id), now);
  for (const { plan } of goals) queueForWatchEvents(db, plan.id, now);
  const toolWatches = opts.toolWatches ? takeDueToolWatches(db, goals.map(({ plan }) => plan.id), now) : [];
  const withWatches = (r) => toolWatches.length ? { ...r, tool_watches: toolWatches } : r;
  const hold = getRunHold(db, now);
  if (hold) return withWatches({ leader: true, claimed: [], expired, hold });
  let running = db.prepare("SELECT COUNT(*) n FROM goal_runs WHERE status = 'running'").get().n;
  const max = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const claimed = [];
  for (const { plan } of goals) {
    archiveResolved(db, plan.id, now);
    const decision = decideTick(db, plan.id, now);
    if (decision.action === "none") continue;
    if (decision.action === "defer") {
      updateGoal(db, plan.id, { next_run_at: decision.next_run_at });
      continue;
    }
    if (decision.action === "skip") {
      if (decision.queuedRunId) {
        updateRun(db, decision.queuedRunId, { status: "skipped", skip_reason: decision.reason, ended_at: now.toISOString() });
      } else {
        recordSkip(db, plan.id, decision.trigger, decision.reason, now);
      }
      updateGoal(db, plan.id, { next_run_at: nextIntervalRun(db, plan.id, now) });
      continue;
    }
    if (running >= max) continue;
    const run = claimRun(db, plan.id, { holder: opts.holder, queuedRunId: decision.queuedRunId, trigger: decision.trigger, now });
    if (run) {
      claimed.push(run);
      running++;
    }
    if (decision.trigger === "interval" || decision.trigger === "cron") updateGoal(db, plan.id, { next_run_at: nextIntervalRun(db, plan.id, now) });
  }
  return withWatches({ leader: true, claimed, expired });
}
function decideItem(db, planId, taskId, input) {
  const task = getTask(db, planId, taskId);
  if (!task) throw new GoalError(`Item ${taskId} not found.`);
  let queuedRun = null;
  const active = () => getGoal(db, planId)?.status === "active";
  if (input.decision === "answer") {
    const answer = (input.feedback ?? "").trim();
    if (!answer) throw new GoalError("An answer is needed.");
    if (!asksPerson(task)) throw new GoalError(`Item ${taskId} isn't a question for you; approve or reject it instead.`);
    approveTask(db, planId, taskId);
    updateTask(db, planId, taskId, { result: `Your answer: ${answer}`, updated_at: (/* @__PURE__ */ new Date()).toISOString() });
    insertMemory(db, { plan_id: planId, kind: "fact", text: `You answered "${task.goal}": ${answer}`, source: "human", source_ref: taskId });
    if (active()) queuedRun = queueRun(db, planId);
  } else if (input.decision === "approve") {
    approveTask(db, planId, taskId);
    if ((isProposal(task) || asksPerson(task)) && active()) queuedRun = queueRun(db, planId);
  } else {
    rejectTask(db, planId, taskId, input.feedback ?? "");
    const goal = getGoal(db, planId);
    if (isProposal(task) && goal?.one_off && goal.status === "active") queuedRun = queueRun(db, planId);
  }
  return { task: getTask(db, planId, taskId), queuedRun };
}
function reviveIfDone(db, planId) {
  const goal = getGoal(db, planId);
  if (!goal?.one_off || goal.status !== "retired") return false;
  updateGoal(db, planId, { status: "active" });
  return true;
}
var LEASE_NAME, LEASE_MS, STALE_GRACE_MS, DEFAULT_MAX_CONCURRENT, WATCH_BUDGET_MS;
var init_goal_tick = __esm({
  "../core/src/goal-tick.ts"() {
    "use strict";
    init_queries();
    init_gates();
    init_goals();
    init_goal_engine();
    init_health();
    init_watches();
    init_goal_changes();
    init_migrate();
    LEASE_NAME = "goals";
    LEASE_MS = 9e4;
    STALE_GRACE_MS = 5 * 6e4;
    DEFAULT_MAX_CONCURRENT = 3;
    WATCH_BUDGET_MS = 45e3;
  }
});

// ../core/src/goal-overview.ts
import { createHash as createHash2 } from "crypto";
function clip(text, max) {
  if (text === null || text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}\u2026`;
}
function getGoalItems(db, planId) {
  const rows = db.prepare("SELECT * FROM tasks WHERE plan_id = ? AND archived_at IS NULL").all(planId);
  return rows.map(deserializeTask).sort((a, b) => compareTaskIds(a.id, b.id));
}
function itemView(t) {
  return {
    id: t.id,
    goal: t.goal,
    status: t.status,
    result: t.result,
    notes: t.notes,
    external_ref: t.external_ref,
    run_id: t.run_id,
    action: isProposal(t) ? t.state.action : null,
    asks_person: asksPerson(t),
    awaiting_review: t.review_requested_at !== null,
    approved_to_execute: isProposal(t) && t.approved_at !== null && t.status === "active",
    updated_at: t.updated_at
  };
}
function overviewItem(t) {
  const v = itemView(t);
  const action = v.action;
  const short = { ...v, goal: clip(v.goal, CLIP.title), notes: clip(v.notes, CLIP.notes), result: clip(v.result, CLIP.result) };
  return action ? { ...short, action: { category: action.category, summary: clip(action.summary, CLIP.title) } } : short;
}
function getAutonomySuggestions(db, planId) {
  const goal = getGoal(db, planId);
  if (!goal) return [];
  const rows = db.prepare(`
    SELECT json_extract(t.state, '$.action.category') AS category, v.passed
    FROM verifications v JOIN tasks t ON t.plan_id = v.plan_id AND t.id = v.task_id
    WHERE v.plan_id = ? AND v.gate = 'approval' AND json_extract(t.state, '$.action.category') IS NOT NULL
    ORDER BY v.created_at DESC, v.rowid DESC
  `).all(planId);
  const streak = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const s = streak.get(r.category) ?? { n: 0, broken: false };
    if (!s.broken) {
      if (r.passed) s.n++;
      else s.broken = true;
    }
    streak.set(r.category, s);
  }
  return [...streak.entries()].filter(([c, s]) => s.n >= PROMOTE_AFTER && autonomyFor(goal, c) === "propose").map(([category, s]) => ({ category, approved_in_a_row: s.n }));
}
function describeEvent(e, itemGoal) {
  const p = e.payload;
  switch (e.event_type) {
    case "agent_message":
      return str(p.message);
    case "tool_call":
      return str(p.tool) ? `Using ${str(p.tool)}` : null;
    case "task_created": {
      const goal = str(p.goal);
      return goal ? `Added "${goal}"${p.mode === "propose" ? " for approval" : ""}` : null;
    }
    case "status_changed": {
      const goal = itemGoal(e.task_id);
      if (!goal) return null;
      if (p.to === "completed") return `Completed "${goal}"`;
      if (p.to === "abandoned") return `Dropped "${goal}"`;
      return null;
    }
    case "memory_added":
      return str(p.text) ? `Noted: ${str(p.text)}` : null;
    default:
      return null;
  }
}
function describeActivity({ goal, openRun, lastRun, events, items }) {
  if (openRun?.status === "running") {
    const goals = new Map(items.map((t) => [t.id, t.goal]));
    for (const e of events) {
      if (e.created_at < openRun.started_at) break;
      if (e.actor !== "agent") continue;
      const text = describeEvent(e, (id) => goals.get(id) ?? null);
      if (text) return { state: "running", text, at: e.created_at };
    }
    return { state: "running", text: "Starting: reading the brief", at: openRun.started_at };
  }
  if (openRun) return { state: "queued", text: `Queued (${openRun.trigger}) \u2014 starts within a minute while Claude Code is open`, at: openRun.started_at };
  if (goal.status === "paused") return { state: "paused", text: "Paused", at: null };
  const approved = items.filter((t) => isProposal(t) && t.approved_at !== null && t.status === "active");
  if (approved.length > 0) {
    const more = approved.length > 1 ? ` and ${approved.length - 1} more` : "";
    return { state: "idle", text: `Next run carries out "${oneLine(approved[0].goal)}"${more}`, at: null };
  }
  const summary = str(lastRun?.summary);
  if (summary) return { state: "idle", text: `Last run: ${summary}`, at: null };
  return { state: "idle", text: "Waiting for its first run", at: null };
}
function buildOverview(db, detail = "all", standingSession = null) {
  const all = listGoals(db);
  const done = all.filter(({ goal }) => goal.status === "retired" && goal.one_off).sort((a, b) => (b.goal.last_run_at ?? "").localeCompare(a.goal.last_run_at ?? "")).slice(0, DONE);
  const goals = [...all.filter(({ goal }) => goal.status !== "retired"), ...done].sort((a, b) => a.plan.name.localeCompare(b.plan.name)).map(({ plan, goal }) => {
    const items = getGoalItems(db, plan.id);
    const open = items.filter((t) => t.status === "pending" || t.status === "active");
    const openRun = getOpenRun(db, plan.id) ?? null;
    const runs = listRuns(db, plan.id, RUNS, { includeSkipped: false });
    const watches = listWatches(db, plan.id);
    return {
      id: plan.id,
      name: plan.name,
      objective: clip(goal.objective, CLIP.objective),
      status: goal.status,
      one_off: goal.one_off,
      instructions: clip(goal.instructions, CLIP.instructions),
      autonomy: goal.autonomy,
      tool_map: goal.tool_map,
      next_run_at: goal.next_run_at,
      schedule: getSchedule(db, plan.id),
      open_run: openRun,
      activity: (() => {
        const a = describeActivity({
          goal,
          openRun,
          lastRun: runs.find((r) => r.status !== "queued" && r.status !== "running") ?? null,
          events: openRun?.status === "running" ? getEvents(db, plan.id, { limit: ACTIVITY_EVENTS }) : [],
          items
        });
        return { ...a, text: clip(a.text, CLIP.activity) };
      })(),
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status,
        trigger: r.trigger,
        summary: clip(r.summary, CLIP.summary),
        started_at: r.started_at,
        ended_at: r.ended_at,
        agent_id: r.agent_id,
        // New tokens only: every model call re-reads the cached prompt, so cache reads would swamp the total
        tokens: r.input_tokens + r.output_tokens + r.cache_write_tokens,
        model: r.model
      })),
      needs_you: open.filter((t) => t.review_requested_at).map(overviewItem),
      open_items: open.filter((t) => !t.review_requested_at).slice(0, OPEN_ITEMS).map(overviewItem),
      open_item_count: open.filter((t) => !t.review_requested_at).length,
      health: listHealth(db, plan.id, HEALTH).map((h) => ({ passed: h.passed, value: h.value, created_at: h.created_at })),
      memory: listMemory(db, plan.id, { activeOnly: true }).slice(-MEMORY).reverse().map((m) => ({ id: m.id, kind: m.kind, text: clip(m.text, CLIP.memory), source: m.source, pinned: m.pinned, created_at: m.created_at })),
      suggestions: getAutonomySuggestions(db, plan.id),
      // Without when each last checked: that changes every few minutes and would redraw the pane for nothing
      watches: watches.map((w) => ({
        name: w.name,
        kind: w.kind,
        every_minutes: w.every_minutes,
        runs: clip(describeWatch(w), CLIP.watch),
        last_fired_at: w.last_fired_at,
        failing: watchFailing(w),
        error: watchFailing(w) ? clip(w.last_error, CLIP.notes) : null
      })),
      watch_count: watches.length,
      watch_failing: watches.some(watchFailing)
    };
  }).map((g) => {
    const waiting = g.needs_you.length;
    if (detail === "all" || detail.includes(g.id)) return { ...g, detail: true, needs_you_count: waiting };
    return {
      ...g,
      detail: false,
      needs_you_count: waiting,
      objective: clip(g.objective, CARD_TEXT),
      // On a card, each waiting item carries only what its row shows
      needs_you: g.needs_you.slice(0, NEEDS_YOU).map((i) => ({
        id: i.id,
        goal: clip(i.goal, CARD_TEXT),
        asks_person: i.asks_person,
        action: i.action ? { category: i.action.category, summary: clip(i.action.summary, CARD_TEXT) } : null
      })),
      runs: g.runs.slice(0, 1),
      open_items: [],
      memory: [],
      instructions: "",
      tool_map: {},
      watches: []
    };
  });
  const standing = standingSession !== null && leaseHolder(db) === standingSession;
  return { goals, hold: getRunHold(db), ...schemaOutdated(db) ? { outdated: true } : {}, ...standing ? { standing: true } : {} };
}
function overviewWithEtag(db, detail = "all", standingSession = null) {
  const body = JSON.stringify(buildOverview(db, detail, standingSession));
  return { body, etag: `"${createHash2("sha256").update(body).digest("base64url").slice(0, 27)}"` };
}
var RUNS, OPEN_ITEMS, HEALTH, MEMORY, CLIP, DONE, ACTIVITY_EVENTS, PROMOTE_AFTER, oneLine, str, NEEDS_YOU, CARD_TEXT;
var init_goal_overview = __esm({
  "../core/src/goal-overview.ts"() {
    "use strict";
    init_queries();
    init_gates();
    init_goals();
    init_goal_engine();
    init_schedule();
    init_health();
    init_watches();
    init_goal_changes();
    init_migrate();
    init_goal_tick();
    RUNS = 5;
    OPEN_ITEMS = 10;
    HEALTH = 20;
    MEMORY = 10;
    CLIP = { summary: 300, memory: 240, title: 200, notes: 200, result: 200, activity: 240, instructions: 1500, objective: 400, watch: 300 };
    DONE = 10;
    ACTIVITY_EVENTS = 20;
    PROMOTE_AFTER = 10;
    oneLine = (s) => s.replace(/\s+/g, " ").trim();
    str = (v) => typeof v === "string" && v.trim() ? oneLine(v) : null;
    NEEDS_YOU = 5;
    CARD_TEXT = 160;
  }
});

// ../core/src/todos.ts
import { randomUUID as randomUUID3 } from "crypto";
function listPlans2(db, workingDir) {
  const plans = db.prepare("SELECT * FROM plans WHERE status = 'active' AND kind != 'goal' ORDER BY updated_at DESC").all();
  return plans.filter((p) => samePath(p.working_dir, workingDir));
}
function headingOf(tasks) {
  const roots = tasks.filter((t) => !t.id.includes("."));
  if (roots.length !== 1) return null;
  return tasks.some((t) => t.id.startsWith(`${roots[0].id}.`)) ? roots[0].id : null;
}
function toList(db, plan) {
  const tasks = getAllTasks(db, plan.id).filter((t) => !t.archived_at);
  const heading = headingOf(tasks);
  const shown = heading ? tasks.filter((t) => t.id !== heading) : tasks;
  const base = heading ? 2 : 1;
  const items = shown.map((t) => ({ id: t.id, text: t.goal, status: t.status, depth: t.id.split(".").length - base, notes: t.notes }));
  const done = items.filter((i) => i.status === "completed" || i.status === "abandoned").length;
  return { id: plan.id, name: plan.name, items, open: items.length - done, done };
}
function todoLists(db, workingDir) {
  const plans = listPlans2(db, workingDir);
  plans.sort((a, b) => Number(b.name === DEFAULT_LIST) - Number(a.name === DEFAULT_LIST));
  return plans.map((p) => toList(db, p));
}
function addTodo(db, input) {
  const text = input.text.trim();
  if (!text) throw new Error("A to-do needs some text.");
  const now = (/* @__PURE__ */ new Date()).toISOString();
  let plan = input.listId ? getPlan(db, input.listId) : listPlans2(db, input.workingDir).find((p) => p.name === DEFAULT_LIST);
  if (input.listId && (!plan || plan.kind === "goal")) throw new Error(`List ${input.listId} not found.`);
  let created = false;
  if (!plan) {
    const id = `plan_${randomUUID3().replace(/-/g, "").slice(0, 10)}`;
    insertPlan(db, { id, name: DEFAULT_LIST, description: "Your to-do list for this project", status: "active", working_dir: input.workingDir, created_at: now, updated_at: now });
    plan = getPlan(db, id);
    created = true;
  }
  const parent = headingOf(getAllTasks(db, plan.id).filter((t) => !t.archived_at));
  const itemId = nextChildId(db, plan.id, parent);
  insertTask(db, {
    id: itemId,
    plan_id: plan.id,
    goal: text,
    status: "pending",
    result: null,
    abandon_reason: null,
    state: {},
    depends_on: null,
    notes: null,
    created_by: input.by ?? "human",
    created_at: now,
    updated_at: now
  });
  touchPlan(db, plan.id);
  return { listId: plan.id, itemId, created };
}
function setTodo(db, listId, itemId, change) {
  const task = getTask(db, listId, itemId);
  if (!task) throw new Error(`To-do ${itemId} not found in list ${listId}.`);
  const text = change.text?.trim();
  if (change.text !== void 0 && !text) throw new Error("A to-do needs some text.");
  updateTask(db, listId, itemId, {
    updated_at: (/* @__PURE__ */ new Date()).toISOString(),
    ...change.status !== void 0 && { status: change.status },
    ...change.notes !== void 0 && { notes: change.notes },
    ...text !== void 0 && { goal: text }
  });
  touchPlan(db, listId);
  const t = getTask(db, listId, itemId);
  return { id: t.id, text: t.goal, status: t.status, depth: 0, notes: t.notes };
}
var DEFAULT_LIST, samePath, norm;
var init_todos = __esm({
  "../core/src/todos.ts"() {
    "use strict";
    init_queries();
    DEFAULT_LIST = "To do";
    samePath = (a, b) => norm(a) === norm(b);
    norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }
});

// ../core/src/index.ts
var src_exports = {};
__export(src_exports, {
  DEFAULT_GOAL_LIMITS: () => DEFAULT_GOAL_LIMITS,
  DEFAULT_HOLD_MS: () => DEFAULT_HOLD_MS,
  DEFAULT_LIST: () => DEFAULT_LIST,
  DEFAULT_MAX_CONCURRENT: () => DEFAULT_MAX_CONCURRENT,
  DEFAULT_VERIFY_TIMEOUT_S: () => DEFAULT_VERIFY_TIMEOUT_S,
  Database: () => Database,
  GATE_FIELDS: () => GATE_FIELDS,
  GateError: () => GateError,
  GoalError: () => GoalError,
  HEALTH_TIMEOUT_S: () => HEALTH_TIMEOUT_S,
  LEASE_MS: () => LEASE_MS,
  MEMORY_BRIEF_CHARS: () => MEMORY_BRIEF_CHARS,
  OUTPUT_TAIL_CHARS: () => OUTPUT_TAIL_CHARS,
  PLUGIN_QUARTERDECK_TOOL_PREFIX: () => PLUGIN_QUARTERDECK_TOOL_PREFIX,
  PROMOTE_AFTER: () => PROMOTE_AFTER,
  QUARTERDECK_TOOL_PREFIX: () => QUARTERDECK_TOOL_PREFIX,
  REVISION_TRIGGERS: () => REVISION_TRIGGERS,
  SCHEMA_VERSION: () => SCHEMA_VERSION,
  STALE_GRACE_MS: () => STALE_GRACE_MS,
  Statement: () => Statement,
  WATCH_BRIEF_LINES: () => WATCH_BRIEF_LINES,
  WATCH_BUDGET_MS: () => WATCH_BUDGET_MS,
  WATCH_DEFAULT_MATCH: () => WATCH_DEFAULT_MATCH,
  WATCH_DEFAULT_MINUTES: () => WATCH_DEFAULT_MINUTES,
  WATCH_FAILING_AFTER: () => WATCH_FAILING_AFTER,
  WATCH_LINE_CHARS: () => WATCH_LINE_CHARS,
  WATCH_MAX_LINES: () => WATCH_MAX_LINES,
  WATCH_MIN_MINUTES: () => WATCH_MIN_MINUTES,
  WATCH_OUTPUT_CHARS: () => WATCH_OUTPUT_CHARS,
  WATCH_REPORT_GRACE_MS: () => WATCH_REPORT_GRACE_MS,
  WATCH_SEEN_MAX: () => WATCH_SEEN_MAX,
  WATCH_TIMEOUT_S: () => WATCH_TIMEOUT_S,
  addItem: () => addItem,
  addRunUsage: () => addRunUsage,
  addTodo: () => addTodo,
  applyGoalChanges: () => applyGoalChanges,
  approveTask: () => approveTask,
  archiveResolved: () => archiveResolved,
  asksPerson: () => asksPerson,
  attachAgent: () => attachAgent,
  autonomyFor: () => autonomyFor,
  buildBrief: () => buildBrief,
  buildOverview: () => buildOverview,
  canonicalToolName: () => canonicalToolName,
  checkCommandWatch: () => checkCommandWatch,
  checkCompletion: () => checkCompletion,
  checkHealth: () => checkHealth,
  checkWatches: () => checkWatches,
  claimRun: () => claimRun,
  clearAllData: () => clearAllData,
  clearRunHold: () => clearRunHold,
  compareTaskIds: () => compareTaskIds,
  countAllTasks: () => countAllTasks,
  countOpenItems: () => countOpenItems,
  countRunsSince: () => countRunsSince,
  countUnqueuedWatchEvents: () => countUnqueuedWatchEvents,
  createGoal: () => createGoal,
  cronNext: () => cronNext,
  dbSchemaVersion: () => dbSchemaVersion,
  decideItem: () => decideItem,
  decideTick: () => decideTick,
  defaultDbPath: () => defaultDbPath,
  deleteGoal: () => deleteGoal,
  deleteMemory: () => deleteMemory,
  deleteTaskTree: () => deleteTaskTree,
  describeActivity: () => describeActivity,
  describeBlockers: () => describeBlockers,
  describeWatch: () => describeWatch,
  deserializeTask: () => deserializeTask,
  disableEventTrigger: () => disableEventTrigger,
  enableEventTrigger: () => enableEventTrigger,
  endRun: () => endRun,
  envVar: () => envVar,
  expireStaleRuns: () => expireStaleRuns,
  failRun: () => failRun,
  finishIfDone: () => finishIfDone,
  getAllTasks: () => getAllTasks,
  getAutonomySuggestions: () => getAutonomySuggestions,
  getChildren: () => getChildren,
  getEventTrigger: () => getEventTrigger,
  getEvents: () => getEvents,
  getGateStatus: () => getGateStatus,
  getGoal: () => getGoal,
  getGoalItems: () => getGoalItems,
  getIntervalTrigger: () => getIntervalTrigger,
  getLatestVerification: () => getLatestVerification,
  getMemory: () => getMemory,
  getOpenRun: () => getOpenRun,
  getPlan: () => getPlan,
  getPlanRevision: () => getPlanRevision,
  getRootTasks: () => getRootTasks,
  getRun: () => getRun,
  getRunHold: () => getRunHold,
  getSchedule: () => getSchedule,
  getSiblings: () => getSiblings,
  getTask: () => getTask,
  getTreeStats: () => getTreeStats,
  getVerifications: () => getVerifications,
  getWatch: () => getWatch,
  goalRunPrompt: () => goalRunPrompt,
  guardToolCallForRun: () => guardToolCallForRun,
  hasGates: () => hasGates,
  healthDue: () => healthDue,
  insertEvent: () => insertEvent,
  insertMemory: () => insertMemory,
  insertPlan: () => insertPlan,
  insertRun: () => insertRun,
  insertTask: () => insertTask,
  insertVerification: () => insertVerification,
  isProposal: () => isProposal,
  isUsageLimit: () => isUsageLimit,
  itemView: () => itemView,
  leaseHolder: () => leaseHolder,
  listGoals: () => listGoals,
  listHealth: () => listHealth,
  listMemory: () => listMemory,
  listPlans: () => listPlans,
  listRuns: () => listRuns,
  listToolCalls: () => listToolCalls,
  listTriggers: () => listTriggers,
  listWatchEvents: () => listWatchEvents,
  listWatches: () => listWatches,
  markWatchEventsQueued: () => markWatchEventsQueued,
  matchLines: () => matchLines,
  matchToolCategory: () => matchToolCategory,
  newId: () => newId,
  nextChildId: () => nextChildId,
  nextIntervalRun: () => nextIntervalRun,
  nextScheduledRun: () => nextScheduledRun,
  openDatabase: () => openDatabase,
  overrideCompletion: () => overrideCompletion,
  overviewWithEtag: () => overviewWithEtag,
  parseCron: () => parseCron,
  parseHealthValue: () => parseHealthValue,
  parseLimitReset: () => parseLimitReset,
  queueForWatchEvents: () => queueForWatchEvents,
  queueRun: () => queueRun,
  recordSkip: () => recordSkip,
  recordWatchLines: () => recordWatchLines,
  rejectTask: () => rejectTask,
  releaseLease: () => releaseLease,
  releaseWatchEvents: () => releaseWatchEvents,
  removeWatch: () => removeWatch,
  reportRunEnd: () => reportRunEnd,
  reportToolWatch: () => reportToolWatch,
  reviveIfDone: () => reviveIfDone,
  runChecks: () => runChecks,
  runHealthCheck: () => runHealthCheck,
  runMigrations: () => runMigrations,
  runVerifyCommand: () => runVerifyCommand,
  schedulerPass: () => schedulerPass,
  schemaOutdated: () => schemaOutdated,
  setIntervalTrigger: () => setIntervalTrigger,
  setRunHold: () => setRunHold,
  setSchedule: () => setSchedule,
  setTodo: () => setTodo,
  setWatch: () => setWatch,
  startRun: () => startRun,
  takeDueToolWatches: () => takeDueToolWatches,
  takeLease: () => takeLease,
  takeWatchEvents: () => takeWatchEvents,
  toLines: () => toLines,
  todoLists: () => todoLists,
  touchPlan: () => touchPlan,
  updateGoal: () => updateGoal,
  updateMemory: () => updateMemory,
  updatePlan: () => updatePlan,
  updateRun: () => updateRun,
  updateTask: () => updateTask,
  verifyEventSecret: () => verifyEventSecret,
  watchDue: () => watchDue,
  watchFailing: () => watchFailing,
  withinActiveHours: () => withinActiveHours
});
import { existsSync as existsSync2, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
function envVar(name, env = process.env) {
  return env[`QUARTERDECK_${name}`] ?? env[`CONDUCTOR_${name}`];
}
function defaultDbPath(env = process.env, home = homedir()) {
  const set = envVar("DB", env);
  if (set) return set;
  const path = join(home, ".quarterdeck", "tasks.db");
  const old = join(home, ".conductor", "tasks.db");
  return !existsSync2(path) && existsSync2(old) ? old : path;
}
function openDatabase(path = defaultDbPath()) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}
var init_src = __esm({
  "../core/src/index.ts"() {
    "use strict";
    init_sqlite();
    init_migrate();
    init_sqlite();
    init_types();
    init_queries();
    init_gates();
    init_goals();
    init_goal_engine();
    init_schedule();
    init_health();
    init_watches();
    init_guard();
    init_goal_tick();
    init_goal_overview();
    init_todos();
    init_goal_changes();
    init_migrate();
  }
});

// src/doctor.ts
import { existsSync as existsSync4, readFileSync as readFileSync2, readdirSync, statSync as statSync2 } from "fs";
import { homedir as homedir3 } from "os";
import { dirname as dirname3, join as join3, resolve } from "path";
import { fileURLToPath as fileURLToPath2 } from "url";

// src/runner-session.ts
import { execFileSync } from "child_process";
import { randomUUID as randomUUID4 } from "crypto";
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir as homedir2, userInfo } from "os";
import { dirname as dirname2, join as join2 } from "path";
import { fileURLToPath } from "url";
var SESSION_NAME = "Quarterdeck goals";
var TASK_NAME = "Quarterdeck goals runner";
var UNIT_NAME = "quarterdeck-runner";
var TMUX_SOCKET = "quarterdeck";
var TMUX_SESSION = "quarterdeck-goals";
var ENSURE_MINUTES = 5;
var PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"];
function liveState(deps) {
  const state = deps.readState();
  return state && state.pid > 0 && deps.pidAlive(state.pid) ? state : null;
}
function waitingOn(screen) {
  return screen && /trust this folder/i.test(screen) ? "trust" : null;
}
function status(deps) {
  const live = liveState(deps);
  const holder = deps.leaseHolder();
  return {
    running: live !== null,
    sessionId: live?.sessionId ?? null,
    holdsLease: live !== null && holder === live.sessionId,
    leaseElsewhere: holder !== null && holder !== live?.sessionId,
    stale: live !== null && live.build !== deps.build,
    waiting: live ? waitingOn(deps.screenText?.(live.pid)) : null
  };
}
var ATTACH_HINT = 'Run `quarterdeck runner attach`, choose "Yes, I trust this folder", then leave with Ctrl-b d (it keeps running).';
function statusText(s) {
  if (!s.running) return "The standing session is not running. Start it with: quarterdeck runner start";
  const who = s.holdsLease ? "it is the session starting goal runs" : s.leaseElsewhere ? "another session holds the goal runs (an open Claude Code window, or a session that just stopped); it takes over within 90 seconds of that one going quiet" : "no session has started goal runs in the last minutes (it takes over within 90 seconds)";
  if (s.waiting) return `The standing session is running (${s.sessionId}) but waiting to be told its folder is safe, so no goal runs in it yet. ${ATTACH_HINT}`;
  return `The standing session is running (${s.sessionId}); ${who}.${s.stale ? " It started with an older Quarterdeck and restarts at the next check with no run going." : ""}`;
}
function startArgs(sessionId, permissionMode) {
  return ["--remote-control", SESSION_NAME, "--name", SESSION_NAME, "--session-id", sessionId, ...permissionMode ? ["--permission-mode", permissionMode] : []];
}
function checkMode(permissionMode) {
  if (permissionMode && !PERMISSION_MODES.includes(permissionMode)) throw new Error(`Unknown permission mode "${permissionMode}" (one of: ${PERMISSION_MODES.join(", ")}).`);
}
function start(deps, opts = {}) {
  const permissionMode = opts.permissionMode ?? deps.readState()?.permissionMode;
  checkMode(permissionMode);
  const live = liveState(deps);
  if (live) return { started: false, sessionId: live.sessionId, text: `The standing session is already running (${live.sessionId}).` };
  const sessionId = deps.newId();
  const pid = deps.spawnSession(startArgs(sessionId, permissionMode));
  deps.writeState({ sessionId, pid, build: deps.build, ...permissionMode ? { permissionMode } : {} });
  return { started: true, sessionId, text: `Started the standing session (${sessionId}). It appears as "${SESSION_NAME}" in the Claude app and at claude.ai/code.` };
}
function stop(deps) {
  const live = liveState(deps);
  if (!live) return { stopped: false, text: "The standing session was not running." };
  deps.killTree(live.pid);
  deps.writeState({ ...live, pid: 0 });
  return { stopped: true, text: "Stopped the standing session." };
}
function ensure(deps) {
  const live = liveState(deps);
  if (!live) return { action: "started", text: start(deps).text };
  if (live.build === deps.build) return { action: "running", text: `The standing session is running (${live.sessionId}).` };
  if (deps.runsRunning() > 0) return { action: "restart-waits", text: "Quarterdeck was updated; the standing session restarts once no goal run is going." };
  stop(deps);
  const r = start(deps);
  return { action: "restarted", text: `Quarterdeck was updated: restarted the standing session (${r.sessionId}).` };
}
var LAUNCHER = `// Written by \`quarterdeck runner install\`. Runs \`quarterdeck runner ensure\` with the current Quarterdeck.
import { execFileSync } from 'child_process'
import { appendFileSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const dir = dirname(fileURLToPath(import.meta.url))
let out
try {
  const cli = readFileSync(join(dir, 'cli-path'), 'utf8').trim()
  out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'runner', 'ensure'], { encoding: 'utf8', windowsHide: true })
} catch (err) {
  out = 'failed: ' + (err && err.stderr ? String(err.stderr) : '') + (err && err.message ? err.message : String(err))
}
// One line a check, except the usual "is running"
if (!/^The standing session is running/.test(out.trim())) appendFileSync(join(dir, 'ensure.log'), new Date().toISOString() + ' ' + out.trim().replace(/\\s+/g, ' ') + '\\n')
`;
var xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function taskXml(p) {
  const start2 = new Date((p.now ?? /* @__PURE__ */ new Date()).getTime() - 864e5).toISOString().slice(0, 19);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Keeps the Quarterdeck standing session running, so goals run with no Claude Code window open. Remove with: quarterdeck runner uninstall</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(p.user)}</UserId>
      <Delay>PT1M</Delay>
    </LogonTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>PT${ENSURE_MINUTES}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>${start2}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(p.user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>conhost.exe</Command>
      <Arguments>--headless "${xml(p.node)}" "${xml(p.launcher)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}
function sdQuote(s, exec) {
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  return `"${exec ? escaped.replace(/\$/g, "$$$$") : escaped}"`;
}
function systemdUnits(p) {
  const description = "Keeps the Quarterdeck standing session running, so goals run with no Claude Code window open. Remove with: quarterdeck runner uninstall";
  const path = [dirname2(p.node), ...p.path.split(":").filter((d) => d && d !== dirname2(p.node))].join(":");
  return {
    service: `[Unit]
Description=${description}

[Service]
Type=oneshot
ExecStart=${sdQuote(p.node, true)} ${sdQuote(p.launcher, true)}
WorkingDirectory=${p.dir.replace(/%/g, "%%")}
Environment=${sdQuote(`PATH=${path}`, false)}
KillMode=process
TimeoutStartSec=5min
`,
    timer: `[Unit]
Description=${description}

[Timer]
OnActiveSec=1min
OnUnitActiveSec=${ENSURE_MINUTES}min

[Install]
WantedBy=timers.target
`
  };
}
function keepAliveName(platform) {
  return platform === "win32" ? `the scheduled task "${TASK_NAME}"` : `the systemd timer ${UNIT_NAME}.timer`;
}
var SUPPORTED = ["win32", "linux"];
var WSL_WARNING = "This is WSL, which stops a minute or so after its last window closes, and the standing session with it: goals run here only while a WSL window is open. To run them with every window closed, use the standing session on Windows instead (`runner install` from a Windows terminal).";
function install(deps, opts = {}) {
  if (!SUPPORTED.includes(deps.platform)) throw new Error("The standing session is set up for Windows and Linux only so far.");
  if (!deps.cliPath) throw new Error("Run this from the built CLI: node plugins/quarterdeck-goals/server/quarterdeck-cli.mjs runner install (after `npm run build --prefix mcp`).");
  checkMode(opts.permissionMode);
  const launcher = join2(deps.dir, "launch.mjs");
  deps.writeFile(launcher, LAUNCHER);
  deps.writeFile(join2(deps.dir, "cli-path"), deps.cliPath);
  const lines = [];
  if (deps.platform === "win32") {
    const file = join2(deps.dir, "task.xml");
    deps.writeFile(file, "\uFEFF" + taskXml({ user: deps.user, node: deps.node, launcher }), "utf16le");
    deps.schtasks(["/create", "/tn", TASK_NAME, "/xml", file, "/f"]);
    lines.push(`Created the scheduled task "${TASK_NAME}": it checks at logon and every ${ENSURE_MINUTES} minutes that the standing session is running.`);
  } else {
    const units = systemdUnits({ node: deps.node, launcher, dir: deps.dir, path: deps.path });
    deps.writeFile(join2(deps.systemdDir, `${UNIT_NAME}.service`), units.service);
    deps.writeFile(join2(deps.systemdDir, `${UNIT_NAME}.timer`), units.timer);
    deps.systemctl(["daemon-reload"]);
    deps.systemctl(["enable", "--now", `${UNIT_NAME}.timer`]);
    lines.push(`Created the systemd user timer ${UNIT_NAME}.timer: it checks at login and every ${ENSURE_MINUTES} minutes that the standing session is running.`);
  }
  lines.push(startByTask(deps, opts).text);
  lines.push("Goals now run while this computer is on and you are logged in, with no Claude Code window open. Remove with: quarterdeck runner uninstall");
  if (deps.platform === "linux" && deps.wsl) lines.push(WSL_WARNING);
  else if (deps.platform === "linux") lines.push("To keep it running after you log out too: loginctl enable-linger");
  return lines.join("\n");
}
function startByTask(deps, opts = {}) {
  checkMode(opts.permissionMode);
  const live = liveState(deps);
  if (live) return { started: false, sessionId: live.sessionId, text: `The standing session is already running (${live.sessionId}).` };
  if (opts.permissionMode) deps.writeState({ sessionId: deps.readState()?.sessionId ?? "", pid: 0, build: deps.build, permissionMode: opts.permissionMode });
  if (deps.platform === "win32") deps.schtasks(["/run", "/tn", TASK_NAME]);
  else deps.systemctl(["start", `${UNIT_NAME}.service`]);
  let made = null;
  for (let i = 0; i < 40 && !made; i++) {
    deps.sleep(500);
    made = liveState(deps);
  }
  if (!made) throw new Error(`${keepAliveName(deps.platform).replace(/^t/, "T")} ran but no session appeared. See ${join2(deps.dir, "ensure.log")}.`);
  return { started: true, sessionId: made.sessionId, text: `Started the standing session (${made.sessionId}). It appears as "${SESSION_NAME}" in the Claude app and at claude.ai/code.${questionNote(deps, made.pid)}` };
}
function questionNote(deps, pid) {
  if (!deps.screenText) return "";
  for (let i = 0; i < 16; i++) {
    deps.sleep(500);
    if (waitingOn(deps.screenText(pid))) return `
It is waiting to be told its folder (${deps.dir}) is safe; no goal runs in it until then. ${ATTACH_HINT}`;
  }
  return "";
}
function uninstall(deps) {
  const lines = [];
  if (deps.platform === "win32") {
    try {
      deps.schtasks(["/delete", "/tn", TASK_NAME, "/f"]);
      lines.push(`Deleted the scheduled task "${TASK_NAME}".`);
    } catch {
      lines.push(`There was no scheduled task "${TASK_NAME}".`);
    }
  } else if (deps.platform === "linux") {
    const had = taskInstalled(deps);
    try {
      deps.systemctl(["disable", "--now", `${UNIT_NAME}.timer`]);
    } catch {
    }
    deps.removeFile(join2(deps.systemdDir, `${UNIT_NAME}.timer`));
    deps.removeFile(join2(deps.systemdDir, `${UNIT_NAME}.service`));
    try {
      deps.systemctl(["daemon-reload"]);
    } catch {
    }
    lines.push(had ? `Deleted the systemd timer ${UNIT_NAME}.timer.` : `There was no systemd timer ${UNIT_NAME}.timer.`);
  }
  deps.removeFile(join2(deps.dir, "launch.mjs"));
  deps.removeFile(join2(deps.dir, "task.xml"));
  lines.push(stop(deps).text);
  return lines.join("\n");
}
function taskInstalled(deps) {
  try {
    if (deps.platform === "win32") deps.schtasks(["/query", "/tn", TASK_NAME]);
    else if (deps.platform === "linux") deps.systemctl(["is-enabled", "--quiet", `${UNIT_NAME}.timer`]);
    else return false;
    return true;
  } catch {
    return false;
  }
}
function runnerDir(home = homedir2()) {
  return join2(home, ".quarterdeck", "runner");
}
function currentBuild(scriptDir = dirname2(fileURLToPath(import.meta.url))) {
  const plugin = [join2(scriptDir, ".."), join2(scriptDir, "..", "..", "plugins", "quarterdeck-goals")].find((d) => existsSync3(join2(d, ".claude-plugin", "plugin.json")));
  if (!plugin) return "unknown";
  let version = "unknown";
  try {
    version = String(JSON.parse(readFileSync(join2(plugin, ".claude-plugin", "plugin.json"), "utf8")).version);
  } catch {
  }
  const bundle = join2(plugin, "server", "quarterdeck-mcp.mjs");
  return existsSync3(bundle) ? `${version}+${Math.round(statSync(bundle).mtimeMs)}` : version;
}
function sessionEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^CLAUDE(CODE$|_CODE_|_PID$|_EFFORT$)/.test(key)) delete env[key];
  return env;
}
function tmux(args, env) {
  try {
    return execFileSync("tmux", ["-L", TMUX_SOCKET, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...env ? { env } : {} });
  } catch (err) {
    if (err.code === "ENOENT") throw new Error("The standing session needs tmux on Linux: install it (for example `sudo apt install tmux`).");
    throw err;
  }
}
function onPath(name, path) {
  for (const d of path.split(":")) if (d && existsSync3(join2(d, name))) return join2(d, name);
  return null;
}
function spawnInTmux(dir, args) {
  const env = sessionEnv();
  delete env.TMUX;
  delete env.TMUX_PANE;
  env.PATH = [dirname2(process.execPath), env.PATH ?? ""].join(":");
  const claude = onPath("claude", env.PATH);
  if (!claude) throw new Error("`claude` is not on the PATH.");
  try {
    tmux(["kill-session", "-t", TMUX_SESSION]);
  } catch {
  }
  const newSession = ["new-session", "-d", "-s", TMUX_SESSION, "-x", "200", "-y", "50", "-c", dir, "-P", "-F", "#{pane_pid}", "--", claude, ...args];
  let out;
  try {
    out = execFileSync(
      "systemd-run",
      ["--user", "--scope", "--collect", "--quiet", "--description=Quarterdeck standing session", "tmux", "-L", TMUX_SOCKET, ...newSession],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env }
    );
  } catch {
    out = tmux(newSession, env);
  }
  const pid = Number(out.trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Could not start the tmux session: ${out.trim().slice(0, 200)}`);
  return pid;
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function tmuxPaneAlive(pid) {
  try {
    return tmux(["list-panes", "-t", TMUX_SESSION, "-F", "#{pane_pid}"]).split("\n").includes(String(pid));
  } catch {
    return false;
  }
}
async function realDeps() {
  const core = await Promise.resolve().then(() => (init_src(), src_exports));
  const dir = runnerDir();
  mkdirSync2(dir, { recursive: true });
  const stateFile = join2(dir, "state.json");
  const withDb = (fn) => {
    const db = core.openDatabase(core.defaultDbPath());
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  const script = process.argv[1] ?? "";
  return {
    dir,
    build: currentBuild(),
    // conhost --headless gives `claude` a console with no window. Started through PowerShell's
    // Start-Process: started by Node's spawn (detached or not, any stdio) it exits within seconds (seen Nov 2026)
    // On Linux, a detached tmux session instead
    spawnSession: (args) => {
      if (process.platform === "linux") return spawnInTmux(dir, args);
      if (process.platform !== "win32") throw new Error("The standing session is set up for Windows and Linux only so far.");
      const claude = execFileSync("where.exe", ["claude"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/)[0].trim();
      const quote = (a) => /[\s"]/.test(a) ? `"${a}"` : a;
      const ps = (s) => `'${s.replace(/'/g, "''")}'`;
      const line = ["--headless", quote(claude), ...args.map(quote)].join(" ");
      const out = execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Start-Process -FilePath conhost.exe -ArgumentList ${ps(line)} -WorkingDirectory ${ps(dir)} -WindowStyle Hidden -PassThru).Id`
      ], { encoding: "utf8", windowsHide: true, env: sessionEnv(), stdio: ["ignore", "pipe", "pipe"] });
      const pid = Number(out.trim());
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Could not start the hidden console (conhost.exe): ${out.trim().slice(0, 200)}`);
      return pid;
    },
    pidAlive: (pid) => {
      if (process.platform === "linux") return tmuxPaneAlive(pid);
      try {
        if (process.platform !== "win32") {
          process.kill(pid, 0);
          return true;
        }
        return /conhost\.exe/i.test(execFileSync("tasklist.exe", ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }));
      } catch {
        return false;
      }
    },
    killTree: (pid) => {
      try {
        if (process.platform === "win32") execFileSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
        else if (process.platform === "linux") {
          tmux(["kill-session", "-t", TMUX_SESSION]);
          for (let i = 0; i < 20 && processAlive(pid); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
          if (processAlive(pid)) process.kill(pid, "SIGKILL");
        } else process.kill(pid);
      } catch {
      }
    },
    screenText: (pid) => {
      if (process.platform !== "linux" || !tmuxPaneAlive(pid)) return null;
      try {
        return tmux(["capture-pane", "-p", "-t", TMUX_SESSION]);
      } catch {
        return null;
      }
    },
    newId: () => randomUUID4(),
    runsRunning: () => withDb((db) => db.prepare("SELECT COUNT(*) n FROM goal_runs WHERE status = 'running'").get().n),
    leaseHolder: () => withDb((db) => core.leaseHolder(db)),
    readState: () => {
      try {
        return JSON.parse(readFileSync(stateFile, "utf8"));
      } catch {
        return null;
      }
    },
    writeState: (state) => {
      if (state) writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
      else rmSync(stateFile, { force: true });
    },
    platform: process.platform,
    insideClaudeCode: process.env.CLAUDECODE === "1",
    cliPath: /quarterdeck-cli\.mjs$/.test(script) ? script : null,
    user: process.platform === "win32" && process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${userInfo().username}` : userInfo().username,
    node: process.execPath,
    writeFile: (path, content, encoding) => {
      mkdirSync2(dirname2(path), { recursive: true });
      writeFileSync(path, content, encoding ?? "utf8");
    },
    removeFile: (path) => rmSync(path, { force: true }),
    schtasks: (args) => execFileSync("schtasks.exe", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }),
    systemctl: (args) => execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    systemdDir: join2(process.env.XDG_CONFIG_HOME || join2(homedir2(), ".config"), "systemd", "user"),
    path: process.env.PATH ?? "",
    wsl: process.platform === "linux" && (() => {
      try {
        return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
      } catch {
        return false;
      }
    })(),
    attach: () => {
      if (process.platform !== "linux") throw new Error("attach is for Linux, where the session is in tmux.");
      if (!process.stdin.isTTY) throw new Error(`attach needs a terminal: run it in one of its own (or: tmux -L ${TMUX_SOCKET} attach -t ${TMUX_SESSION}).`);
      const env = { ...process.env };
      delete env.TMUX;
      execFileSync("tmux", ["-L", TMUX_SOCKET, "attach", "-t", TMUX_SESSION], { stdio: "inherit", env });
    },
    sleep: (ms) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }
  };
}
var RUNNER_USAGE = [
  "Usage: quarterdeck runner <command>",
  "",
  "The standing session: a Claude Code session with Remote Control on, in a hidden console (Windows) or a",
  "tmux session (Linux), which runs goals while no Claude Code window is open (the computer must be on",
  "and you logged in).",
  "",
  "  install [--permission-mode <mode>]   Start it, and keep it running (a scheduled task; on Linux a systemd timer)",
  "  uninstall                            Stop it and delete the scheduled task or timer",
  "  start [--permission-mode <mode>]     Start it now",
  "  stop                                 Stop it",
  "  status                               Whether it is running and starting goal runs",
  "  ensure                               Start it if it is missing; restart it after an update",
  "  attach                               Linux: open its terminal (to answer a question); Ctrl-b d leaves it running"
].join("\n");
async function runnerCommand(args, deps) {
  const [command2, ...rest] = args;
  if (!command2 || command2 === "help" || command2 === "--help") return { text: RUNNER_USAGE, code: 0 };
  const at = rest.indexOf("--permission-mode");
  const permissionMode = at >= 0 ? rest[at + 1] : void 0;
  try {
    const d = deps ?? await realDeps();
    switch (command2) {
      case "install":
        return { text: install(d, { permissionMode }), code: 0 };
      case "uninstall":
        return { text: uninstall(d), code: 0 };
      case "start": {
        if (taskInstalled(d)) return { text: startByTask(d, { permissionMode }).text, code: 0 };
        const r = start(d, { permissionMode });
        const live = r.started ? liveState(d) : null;
        if (live) r.text += questionNote(d, live.pid);
        const warning = r.started && d.insideClaudeCode ? "\nStarted from inside Claude Code, so it may stop when this window closes. Run `quarterdeck runner install` (or start it from a terminal of its own) to keep it." : "";
        return { text: r.text + warning, code: 0 };
      }
      case "stop":
        return { text: stop(d).text, code: 0 };
      case "status": {
        const s = status(d);
        return { text: statusText(s), code: s.running ? 0 : 1 };
      }
      case "ensure":
        return { text: ensure(d).text, code: 0 };
      case "attach": {
        if (!liveState(d)) return { text: "The standing session is not running. Start it with: quarterdeck runner start", code: 1 };
        d.attach();
        return { text: "", code: 0 };
      }
      default:
        return { text: RUNNER_USAGE, code: 1 };
    }
  } catch (err) {
    return { text: `quarterdeck runner: ${firstLine(err)}`, code: 1 };
  }
}
function firstLine(err) {
  return (err instanceof Error ? err.message : String(err)).trim().split("\n")[0];
}

// src/doctor.ts
function defaultOptions() {
  return {
    repoRoot: findRepoRoot(dirname3(fileURLToPath2(import.meta.url))),
    cwd: process.cwd(),
    home: homedir3(),
    env: process.env,
    nodeVersion: process.versions.node,
    fetchTimeoutMs: 2e3
  };
}
function findRepoRoot(from) {
  for (let dir = from; ; dir = dirname3(dir)) {
    if (existsSync4(join3(dir, "core", "src")) && existsSync4(join3(dir, "mcp", "src"))) return dir;
    if (dirname3(dir) === dir) return resolve(from, "..", "..");
  }
}
var PLUGIN = "quarterdeck-goals@quarterdeck";
var GUARD_PLUGIN = "quarterdeck-guard@quarterdeck";
var ok = (name, detail) => ({ name, level: "ok", detail });
var warn = (name, detail, fix) => ({ name, level: "warn", detail, fix });
var fail = (name, detail, fix) => ({ name, level: "fail", detail, fix });
function checkNode(o) {
  const [major, minor] = o.nodeVersion.split(".").map(Number);
  return major > 22 || major === 22 && minor >= 13 ? ok("Node.js", `v${o.nodeVersion}`) : fail("Node.js", `v${o.nodeVersion} is too old (Quarterdeck's built-in database, node:sqlite, needs Node 22.13+)`, "Install Node.js 22.13 or newer.");
}
async function checkDatabase(o) {
  let core;
  try {
    core = await Promise.resolve().then(() => (init_src(), src_exports));
  } catch (e) {
    return [fail("Database", `could not load @quarterdeck/core: ${firstLine2(e.message)}`, "Run `npm install` and `npm run build --prefix core` from the repo root.")];
  }
  const path = core.defaultDbPath(o.env, o.home);
  try {
    const db = core.openDatabase(path);
    try {
      const plans = db.prepare("SELECT COUNT(*) n FROM plans").get().n;
      const tasks = db.prepare("SELECT COUNT(*) n FROM tasks").get().n;
      const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => r.name));
      const missing = core.REVISION_TRIGGERS.filter((t) => !present.has(t));
      const mode = String(db.pragma("journal_mode", { simple: true }));
      const version = core.dbSchemaVersion(db);
      const results = [ok("Database", `${path} \u2014 ${plans} plans, ${tasks} tasks`)];
      if (missing.length) {
        results.push(fail("Schema", `missing triggers: ${missing.join(", ")}`, "Rebuild core (`npm run build --prefix core`) and rerun."));
      } else if (core.schemaOutdated(db)) {
        results.push(warn(
          "Schema",
          `version ${version}, newer than this Quarterdeck (${core.SCHEMA_VERSION}): a newer version has used the database`,
          "Update the plugin (`claude plugin update quarterdeck-goals@quarterdeck`), then /reload-plugins in every open session."
        ));
      } else {
        results.push(ok("Schema", `up to date (version ${version})`));
      }
      if (path !== ":memory:" && mode !== "wal") {
        results.push(warn("Journal mode", `${mode} (expected wal)`, "Close other programs using the database and rerun."));
      }
      return results;
    } finally {
      db.close();
    }
  } catch (e) {
    return [
      fail("Database", `cannot open ${path}: ${firstLine2(e.message)}`, "Check the path is writable, or set QUARTERDECK_DB to a writable file.")
    ];
  }
}
function checkBuild(o, pkg) {
  const name = `${pkg}/ build`;
  const srcDir = join3(o.repoRoot, pkg, "src");
  const entry = join3(o.repoRoot, pkg, "dist", "index.js");
  if (!existsSync4(srcDir)) return ok(name, "not a Quarterdeck checkout (installed plugin) \u2014 skipped");
  if (!existsSync4(entry)) return fail(name, `${pkg}/dist/index.js is missing`, `Run \`npm run build --prefix ${pkg}\`.`);
  const newestSrc = newestMtime(srcDir);
  const built = statSync2(entry).mtimeMs;
  return newestSrc > built + 1e3 ? warn(name, "source files changed since the last build", `Run \`npm run build --prefix ${pkg}\`${pkg === "mcp" ? ", then reconnect the server with /mcp" : ""}.`) : ok(name, "up to date");
}
function checkBundle(o) {
  const name = "Plugin server bundle";
  const srcDir = join3(o.repoRoot, "mcp", "src");
  const bundle = join3(o.repoRoot, "plugins", "quarterdeck-goals", "server", "quarterdeck-mcp.mjs");
  if (!existsSync4(srcDir)) return ok(name, "not a Quarterdeck checkout (installed plugin) \u2014 skipped");
  if (!existsSync4(bundle)) return fail(name, "plugins/quarterdeck-goals/server/quarterdeck-mcp.mjs is missing, so the plugin has no server", "Run `npm run build --prefix mcp`, then /reload-plugins.");
  const built = statSync2(bundle).mtimeMs;
  return Math.max(newestMtime(srcDir), newestMtime(join3(o.repoRoot, "core", "src"))) > built + 1e3 ? warn(name, "source files changed since the last build", "Run `npm run build --prefix mcp`, then /reload-plugins.") : ok(name, "up to date");
}
function checkServerSetup(o) {
  const name = "quarterdeck MCP server";
  const user = readJson(join3(o.home, ".claude.json")).mcpServers ?? {};
  const projectFile = [join3(o.cwd, ".mcp.json"), join3(o.repoRoot, ".mcp.json")].find((f) => existsSync4(f));
  const project = projectFile ? readJson(projectFile).mcpServers ?? {} : {};
  const plugin = enabledPlugins(o)[PLUGIN] === true;
  const byHand = [user.quarterdeck && "added for your user", project.quarterdeck && `in ${projectFile}`].filter(Boolean);
  const results = [];
  if (plugin && byHand.length) {
    const fixes = [user.quarterdeck && "Run `claude mcp remove --scope user quarterdeck`", project.quarterdeck && `remove "quarterdeck" from ${projectFile}`].filter(Boolean);
    results.push(warn(
      name,
      `provided by the ${PLUGIN} plugin, but also set up by hand (${byHand.join("; ")}), so two copies run`,
      `${fixes.join(" and ")}, then restart Claude Code.`.replace(/^r/, "R")
    ));
  } else if (plugin) {
    results.push(ok(name, `provided by the ${PLUGIN} plugin`));
  } else if (byHand.length) {
    results.push(warn(
      name,
      `set up by hand (${byHand.join("; ")}), so it doesn't update`,
      "Install the quarterdeck-goals plugin (see the plugins check), then remove the hand-added server."
    ));
  }
  if (project["conductor-channel"]) {
    results.push(warn(".mcp.json conductor-channel", "the channel server was removed, so this entry fails to start", 'Remove "conductor-channel" from .mcp.json.'));
  }
  return results;
}
function checkPermissionRules(o) {
  if (enabledPlugins(o)[PLUGIN] !== true) return null;
  const files = [join3(o.home, ".claude", "settings.json"), join3(o.cwd, ".claude", "settings.json"), join3(o.cwd, ".claude", "settings.local.json")];
  const stale = files.filter((f) => {
    const perms = readJson(f).permissions;
    return perms !== void 0 && JSON.stringify(perms).includes("mcp__quarterdeck__");
  });
  if (!stale.length) return null;
  return warn(
    "Permission rules",
    `${stale.join(", ")} ${stale.length === 1 ? "has" : "have"} rules for mcp__quarterdeck__* tools, which the plugin's server names mcp__plugin_quarterdeck-goals_quarterdeck__*`,
    "Change those rules to the new prefix (or keep both)."
  );
}
function checkUpdates(o) {
  const known = readJson(join3(o.home, ".claude", "plugins", "known_marketplaces.json"));
  const m = known.quarterdeck;
  if (!m) return null;
  const name = "Updates";
  if (m.source?.source === "directory") return ok(name, `from your local folder${m.source.path ? ` ${m.source.path}` : ""} (after changes: \`npm run build\`, then /reload-plugins)`);
  return m.autoUpdate === true ? ok(name, "automatic (after one arrives, /reload-plugins or restart to use it)") : warn(
    name,
    "auto-update is off for the quarterdeck marketplace, so new versions arrive only when you update by hand",
    "In Claude Code: /plugin \u2192 Marketplaces \u2192 quarterdeck \u2192 Enable auto-update. Or now: `claude plugin update quarterdeck-goals@quarterdeck`."
  );
}
function checkHooks(o) {
  const file = join3(o.home, ".claude", "settings.json");
  if (!existsSync4(file)) return ok("Claude Code hooks", "none installed (none needed)");
  let text;
  try {
    text = readFileSync2(file, "utf8");
    JSON.parse(text);
  } catch {
    return fail("Claude Code hooks", "~/.claude/settings.json is not valid JSON", "Fix the JSON syntax.");
  }
  const problems = [
    text.includes("conductor-decompose") && "the obsolete decompose hook is still installed",
    text.includes("mcp__conductor__") && "the retired plan reminder hooks are still installed",
    text.includes("goal-guard") && "the old goal-guard hook is still installed (the guard plugin replaced it)"
  ].filter(Boolean);
  if (problems.length) return warn("Claude Code hooks", problems.join("; "), "Run `npm run setup-hooks --prefix mcp` to remove them.");
  return ok("Claude Code hooks", "up to date (none needed)");
}
var MARKETPLACE_SOURCE = "shannonbay/Quarterdeck#release";
function checkPlugin(o) {
  const install2 = (p) => `Run \`claude plugin marketplace add ${MARKETPLACE_SOURCE}\` then \`claude plugin install ${p} --scope user\`.`;
  const enabled = enabledPlugins(o);
  const name = "Claude Code plugins";
  if (enabled[PLUGIN] === false) return warn(name, `${PLUGIN} is installed but disabled`, `Run \`claude plugin enable ${PLUGIN}\`.`);
  if (enabled[PLUGIN] !== true) return warn(name, `${PLUGIN} not installed (it runs goals and shows the Goals pane)`, install2(PLUGIN));
  if (enabled[GUARD_PLUGIN] === false) return warn(name, `${GUARD_PLUGIN} is disabled, so goal runs are paused`, `Run \`claude plugin enable ${GUARD_PLUGIN}\`.`);
  if (enabled[GUARD_PLUGIN] !== true) return warn(name, `${GUARD_PLUGIN} not installed, so goal runs are paused`, install2(GUARD_PLUGIN));
  return ok(name, `${PLUGIN} and ${GUARD_PLUGIN} enabled`);
}
function checkRenameLeftovers(o) {
  const read = (file) => {
    try {
      return JSON.parse(readFileSync2(file, "utf8"));
    } catch {
      return {};
    }
  };
  const user = read(join3(o.home, ".claude.json"));
  const repo = read(join3(o.repoRoot, ".mcp.json"));
  const enabled = read(join3(o.home, ".claude", "settings.json")).enabledPlugins ?? {};
  const found = [];
  const fixes = [];
  if (!o.env.QUARTERDECK_DB && !o.env.CONDUCTOR_DB && existsSync4(join3(o.home, ".conductor", "tasks.db")) && !existsSync4(join3(o.home, ".quarterdeck", "tasks.db"))) {
    found.push("your goals are still in ~/.conductor");
    fixes.push("with Claude Code and the web app closed, rename ~/.conductor to ~/.quarterdeck");
  }
  if (user.mcpServers?.conductor) {
    found.push('a "conductor" MCP server is still added for your user');
    fixes.push("run `claude mcp remove --scope user conductor`");
  }
  if (repo.mcpServers?.conductor) {
    found.push('.mcp.json still has a "conductor" server');
    fixes.push("remove it from .mcp.json");
  }
  const oldPlugins = ["conductor-goals@conductor", "conductor-goals-guard@conductor"].filter((p) => p in enabled);
  if (oldPlugins.length) {
    found.push(`the old plugins are still installed (${oldPlugins.join(", ")})`);
    fixes.push(`run ${oldPlugins.map((p) => `\`claude plugin uninstall ${p}\``).join(" and ")}, then \`claude plugin marketplace remove conductor\``);
  }
  if (!found.length) return null;
  const fix = fixes.join("; ");
  return warn("Renamed from Conductor", found.join("; "), fix.charAt(0).toUpperCase() + fix.slice(1) + ".");
}
async function checkWeb(o) {
  const url = `http://localhost:${o.env.PORT ?? "3000"}/api/health`;
  return await getJson(url, o.fetchTimeoutMs) ? ok("Goal pages (web)", `running at ${url.replace("/api/health", "")}`) : ok("Goal pages (web)", "not running (optional: `npm run dev --prefix web` for goal pages and webhooks)");
}
async function checkGoals(o, plugins) {
  let goals;
  try {
    const core = await Promise.resolve().then(() => (init_src(), src_exports));
    const db = core.openDatabase(core.defaultDbPath(o.env, o.home));
    try {
      goals = core.listGoals(db, "active");
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
  if (goals.length === 0) return null;
  const names = goals.map((g) => g.plan.name).join(", ");
  return plugins.level === "ok" ? ok("Persistent goals", `${goals.length} active (${names}); they run while Claude Code is open`) : warn(
    "Persistent goals",
    `${goals.length} active (${names}) but they won't run: ${plugins.detail}`,
    plugins.fix ?? "Install the quarterdeck-goals and quarterdeck-guard plugins (see the Claude Code plugins check above)."
  );
}
async function checkRunner(o, deps) {
  const name = "Standing session";
  if (!existsSync4(join3(o.home, ".quarterdeck", "runner", "launch.mjs"))) return null;
  try {
    const d = deps ?? await realDeps();
    const s = status(d);
    const task = !["win32", "linux"].includes(d.platform) || taskInstalled(d);
    if (!s.running) return warn(name, `not running${task ? ` (${keepAliveName(d.platform)} starts it within 5 minutes)` : ""}, so goals run only while a Claude Code window is open`, "Run `quarterdeck runner start`, or `quarterdeck runner uninstall` if you no longer want it.");
    if (d.platform === "linux" && d.wsl) return warn(name, `${statusText(s)} But ${WSL_WARNING.replace(/^This is WSL, which/, "WSL")}`, "Run `quarterdeck runner uninstall` here and `quarterdeck runner install` in a Windows terminal.");
    if (s.waiting) return warn(name, "running but waiting to be told its folder is safe, so no goal runs in it", ATTACH_HINT);
    if (!task) return warn(name, `${statusText(s)} But ${keepAliveName(d.platform)} is missing, so nothing restarts it after a logon or an update`, "Run `quarterdeck runner install`.");
    return ok(name, statusText(s));
  } catch (e) {
    return warn(name, `could not be checked: ${firstLine2(e.message)}`, "Check that `claude agents --json` works in a terminal.");
  }
}
async function runDoctor(o = defaultOptions()) {
  const node = checkNode(o);
  const plugins = checkPlugin(o);
  const [db, web] = await Promise.all([checkDatabase(o), checkWeb(o)]);
  return [
    node,
    ...db,
    checkBuild(o, "core"),
    checkBuild(o, "mcp"),
    checkBundle(o),
    ...checkServerSetup(o),
    checkHooks(o),
    plugins,
    ...[checkUpdates(o), checkPermissionRules(o), checkRenameLeftovers(o)].filter((r) => r !== null),
    web,
    ...[await checkGoals(o, plugins), await checkRunner(o)].filter((r) => r !== null)
  ];
}
function formatResults(results) {
  const tag = { ok: "[ ok ]", warn: "[warn]", fail: "[FAIL]" };
  const lines = ["Quarterdeck doctor", ""];
  for (const r of results) {
    lines.push(`${tag[r.level]} ${r.name}: ${r.detail}`);
    if (r.fix) lines.push(`       fix: ${r.fix}`);
  }
  const fails = results.filter((r) => r.level === "fail").length;
  const warns = results.filter((r) => r.level === "warn").length;
  lines.push("", fails ? `${fails} problem(s) to fix, ${warns} warning(s).` : warns ? `No problems, ${warns} warning(s).` : "Everything looks good.");
  return lines.join("\n");
}
function readJson(file) {
  try {
    return JSON.parse(readFileSync2(file, "utf8"));
  } catch {
    return {};
  }
}
function enabledPlugins(o) {
  return readJson(join3(o.home, ".claude", "settings.json")).enabledPlugins ?? {};
}
function firstLine2(s) {
  return s.split("\n")[0];
}
function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join3(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(p));
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) newest = Math.max(newest, statSync2(p).mtimeMs);
  }
  return newest;
}
async function getJson(url, timeoutMs) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// src/cli.ts
var command = process.argv[2];
if (command === "doctor") {
  const results = await runDoctor();
  console.log(formatResults(results));
  process.exit(results.some((r) => r.level === "fail") ? 1 : 0);
} else if (command === "runner") {
  const { text, code } = await runnerCommand(process.argv.slice(3));
  if (text) console.log(text);
  process.exit(code);
} else {
  console.log([
    "Usage: quarterdeck <command>",
    "",
    "Commands:",
    "  doctor    Check that Quarterdeck is installed and configured correctly",
    "  runner    Run goals with no Claude Code window open (quarterdeck runner help)",
    "",
    "The MCP server itself is started by Claude Code from the quarterdeck-goals plugin (server/quarterdeck-mcp.mjs)."
  ].join("\n"));
  process.exit(command === void 0 || command === "help" || command === "--help" ? 0 : 1);
}
