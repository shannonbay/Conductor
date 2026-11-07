let openPlanId: string | null = null
/** The goal run this session is working on (set by get_goal_brief with a run_id). */
let openRunId: string | null = null

export function getOpenPlan(): string | null {
  return openPlanId
}

export function setOpenPlan(id: string | null): void {
  if (id !== openPlanId) openRunId = null
  openPlanId = id
}

export function getOpenRun(): string | null {
  return openRunId
}

export function setOpenRun(id: string | null): void {
  openRunId = id
}
