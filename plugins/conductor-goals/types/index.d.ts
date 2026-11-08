/** A goal work item: a proposal waiting for the person, or an open item. */
export type Item = { id: string; title: string; category: string | null; summary: string | null }

/** One goal run. */
export type Run = {
  id: string
  status: string
  trigger: string
  summary: string | null
  startedAt: string
  endedAt: string | null
  /** The subagent that did it (its transcript has what it actually did). */
  agentId: string | null
}

/** One memory entry the goal's runs read. */
export type Memory = { id: string; kind: string; text: string; pinned: boolean }

/** What a goal's agent is doing now, or what it does next, in one line. */
export type Activity = {
  state: 'running' | 'queued' | 'paused' | 'idle'
  text: string
  /** When a running agent took its latest step. */
  at: string | null
}

/** When a goal runs on its own: every N minutes (optionally inside a daily window) or on a cron expression. */
export type Schedule = { kind: 'interval'; minutes: number; active_hours?: string } | { kind: 'cron'; expr: string }

/** One goal as the pane shows it. */
export type GoalCard = {
  id: string
  name: string
  objective: string
  /** active | paused */
  status: string
  activity: Activity
  needsYou: Item[]
  /** The first open items (not awaiting review); `openItemCount` has the total. */
  openItems: Item[]
  openItemCount: number
  /** The run that is queued or running, if any. */
  openRun: { id: string; status: string } | null
  /** Most recent first. */
  runs: Run[]
  nextRunAt: string | null
  /** null: runs only on demand. */
  schedule: Schedule | null
  /** Runs once; done (status 'retired') when its run leaves nothing open. */
  oneOff: boolean
  instructions: string
  /** Action category → off | propose | auto (unlisted: propose). */
  autonomy: Record<string, string>
  /** Tool name pattern → action category. */
  toolMap: Record<string, string>
  health: { passed: boolean; value: number | null } | null
  /** Health values, oldest first. */
  trend: number[]
  /** Most recent first. */
  memory: Memory[]
  /** Categories approved every time lately: candidates for 'auto'. */
  suggestions: { category: string; approvedInARow: number }[]
}

/** The latest read of the Conductor web app. */
export type Snapshot = {
  reachable: boolean
  error: string | null
  goals: GoalCard[]
  fetchedAt: number
  /** The overview's ETag, sent back so an unchanged overview answers 304. */
  etag: string | null
  /** Set while goal runs are held because the usage limit is reached. */
  hold: { until: string; reason: string } | null
}

/** One to-do on the person's list. */
export type TodoItem = { id: string; text: string; status: string; depth: number; notes: string | null }

/** A to-do list: an active plan in the project's directory. */
export type TodoList = { id: string; name: string; items: TodoItem[]; open: number; done: number }

/** The project's to-do lists as last read. */
export type Todos = { dir: string; lists: TodoList[] }

/** A destructive action waiting for a second press. */
export type Confirm =
  | { kind: 'cancel-run'; goalId: string }
  | { kind: 'delete-memory'; goalId: string; memoryId: string }
  | { kind: 'auto'; goalId: string; category: string }

/** The goal run this Claude Code session is carrying out. */
export type ActiveRun = { goalId: string; runId: string; startedAt: number }

/** A goal run this plugin started in a subagent. */
export type RunEntry = {
  runId: string
  goalId: string
  name: string
  startedAt: number
  /** When the run is stopped and marked timed out. */
  deadline: number
  maxMinutes: number
}

declare module 'claude-code' {
  interface PluginState {
    'conductor-goals': {
      snapshot: Shaped<Snapshot>
      /** "<goalId>/<itemId>" while its feedback box is open. */
      rejecting: string | null
      /** The to-do list whose add box is open. */
      addingTo: string | null
      /** The action a button is doing, e.g. "approve:g1/11" or "run:g1". */
      busy: string | null
      /** The last action's error, shown at the bottom of the pane. */
      notice: string | null
      /** Ids of the goals whose details are shown. */
      expanded: string[]
      confirm: Confirm | null
      activeRun: ActiveRun | null
      /** Runs this session's plugin started, by subagent id. */
      runs: Record<string, RunEntry>
      /** True while the conductor-goals-guard plugin isn't loaded, so no run starts. */
      guardMissing: boolean
      /** The person's to-do lists for this session's project. */
      todos: Todos | null
    }
  }
}
