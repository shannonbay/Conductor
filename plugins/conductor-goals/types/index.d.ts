/** A proposal waiting for the person. */
export type Item = { id: string; title: string; category: string | null; summary: string | null }

/** One goal as the pane shows it. */
export type GoalCard = {
  id: string
  name: string
  status: string
  needsYou: Item[]
  running: boolean
  lastRun: { id: string; status: string; summary: string | null; at: string | null } | null
  nextRunAt: string | null
  health: { passed: boolean; value: number | null } | null
  /** Health values, oldest first. */
  trend: number[]
}

/** The latest read of the Conductor web app. */
export type Snapshot = { reachable: boolean; error: string | null; goals: GoalCard[]; fetchedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'conductor-goals': {
      snapshot: Shaped<Snapshot>
      /** "<goalId>/<itemId>" while its feedback box is open. */
      rejecting: string | null
      /** What a button is doing right now, e.g. "approve". */
      busy: string | null
      /** The last action's error, shown at the bottom of the pane. */
      notice: string | null
    }
  }
}
