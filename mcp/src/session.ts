let openProjectId: string | null = null

export function getOpenProject(): string | null {
  return openProjectId
}

export function setOpenProject(id: string | null): void {
  openProjectId = id
}
