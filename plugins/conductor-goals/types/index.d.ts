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
}

/** A destructive action waiting for a second press. */
export type Confirm =
  | { kind: 'cancel-run'; goalId: string }
  | { kind: 'delete-memory'; goalId: string; memoryId: string }

/** The goal run this Claude Code session is carrying out. */
export type ActiveRun = { goalId: string; runId: string; startedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'conductor-goals': {
      snapshot: Shaped<Snapshot>
      /** "<goalId>/<itemId>" while its feedback box is open. */
      rejecting: string | null
      /** The action a button is doing, e.g. "approve:g1/11" or "run:g1". */
      busy: string | null
      /** The last action's error, shown at the bottom of the pane. */
      notice: string | null
      /** Ids of the goals whose details are shown. */
      expanded: string[]
      confirm: Confirm | null
      activeRun: ActiveRun | null
    }
  }
}
