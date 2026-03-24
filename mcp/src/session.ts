let openPlanId: string | null = null

export function getOpenPlan(): string | null {
  return openPlanId
}

export function setOpenPlan(id: string | null): void {
  openPlanId = id
}
