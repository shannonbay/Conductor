import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Which plan (and goal run) the tools act on.
 *
 * One MCP server serves a whole Claude Code session: the main conversation and
 * every subagent in it. The main conversation uses the process-wide open plan.
 * A goal run started by the quarterdeck-goals plugin runs in a subagent; the
 * plugin adds `run_scope` to each of its calls, and that call then gets a scope
 * of its own (the run's plan and run), so concurrent runs and the main
 * conversation never switch each other's open plan.
 */
interface Scope {
  planId: string | null
  runId: string | null
}

const global: Scope = { planId: null, runId: null }
const scoped = new AsyncLocalStorage<Scope>()

const current = (): Scope => scoped.getStore() ?? global

/** Runs `fn` with its own plan and run, leaving the process-wide ones untouched. */
export function withScope<T>(scope: Scope, fn: () => T): T {
  return scoped.run({ ...scope }, fn)
}

export function getOpenPlan(): string | null {
  return current().planId
}

export function setOpenPlan(id: string | null): void {
  const s = current()
  if (id !== s.planId) s.runId = null
  s.planId = id
}

/** The goal run being worked on (set by get_goal_brief with a run_id, or by the call's run scope). */
export function getOpenRun(): string | null {
  return current().runId
}

export function setOpenRun(id: string | null): void {
  current().runId = id
}
