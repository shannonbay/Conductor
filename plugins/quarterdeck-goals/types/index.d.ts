/** A goal work item: a proposal waiting for the person, or an open item. */
export type Item = { id: string; title: string; category: string | null; summary: string | null; /** A question or request for the person, not a proposal. */ asksPerson?: boolean }

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
  /** Tokens the run's agent used, all kinds summed (0 when unknown). */
  tokens?: number
  /** The model the run's agent actually used, as its turns reported it (null when unknown). */
  model?: string | null
}

/** One memory entry the goal's runs read. */
export type Memory = {
  id: string; kind: string; text: string; pinned: boolean
  /** What its run had read before writing it: briefs that hand it out mark their runs untrusted until the person trusts it. */
  untrusted?: string
}

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
  /** How many items wait for the person (needsYou may hold only the first few). */
  needsYouCount: number
  /** False when the overview gave only a card: no runs beyond the last, memory, open items, instructions or tool rules. */
  detail: boolean
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
  /** The model its runs use (an alias or a full id); null: the model of the session that starts each run. */
  model: string | null
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
  /** Checks whose new lines start a run (empty on a card: `watchCount` has how many). */
  watches: Watch[]
  watchCount: number
  /** A watch's check has failed several times in a row. */
  watchFailing: boolean
}

export type Watch = {
  name: string
  everyMinutes: number
  /** The command it runs. */
  runs: string
  lastFiredAt: string | null
  failing: boolean
  error: string | null
}

/** The latest read of the Quarterdeck web app. */
export type Snapshot = {
  reachable: boolean
  error: string | null
  goals: GoalCard[]
  fetchedAt: number
  /** The overview's ETag, sent back so an unchanged overview answers 304. */
  etag: string | null
  /** Set while goal runs are held because the usage limit is reached. */
  hold: { until: string; reason: string } | null
  /** Set when a newer Quarterdeck in another session has upgraded the database: this session should /reload-plugins. */
  outdated?: boolean
  /** Set while the standing session (`quarterdeck runner`) is the one starting goal runs. */
  standing?: boolean
  /** Set when a newer Quarterdeck than the installed one is published. */
  update?: Update
}

/** A published Quarterdeck newer than the installed one. */
export type Update = { installed: string; latest: string }

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
  | { kind: 'delete-goal'; goalId: string }

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

/**
 * Whether alerts can reach the person's phone from this session, as far as the
 * plugin has seen: `connected` after a message from the phone or a push that
 * went out, `no_transport` when Remote Control isn't connected, `config_off`
 * when mobile push is off in /config.
 */
export type PhoneState = 'unknown' | 'connected' | 'no_transport' | 'config_off'

declare module 'claude-code' {
  interface PluginState {
    'quarterdeck-goals': {
      snapshot: Shaped<Snapshot>
      /** "<goalId>/<itemId>" while its feedback box is open. */
      rejecting: string | null
      /** The to-do list whose add box is open. */
      addingTo: string | null
      /** "<listId>/<itemId>" while that to-do's question box is open. */
      askingAbout: string | null
      /** "goal:<goalId>" or "run:<runId>" while that Discuss question box is open. */
      discussing: string | null
      /** "<listId>/<itemId>" while that to-do's edit box is open. */
      editingTodo: string | null
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
      /** True while the quarterdeck-guard plugin isn't loaded, so no run starts. */
      guardMissing: boolean
      /** The person's to-do lists for this session's project. */
      todos: Todos | null
      /** Whether phone alerts can get through, learned from the last push and from messages sent from the phone. */
      phone: PhoneState
    }
  }
}
