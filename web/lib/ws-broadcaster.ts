import type { WebSocket } from 'ws'

const clients = new Map<string, Set<WebSocket>>()

export function registerClient(projectId: string, ws: WebSocket): void {
  if (!clients.has(projectId)) {
    clients.set(projectId, new Set())
  }
  clients.get(projectId)!.add(ws)
}

export function unregisterClient(projectId: string, ws: WebSocket): void {
  const set = clients.get(projectId)
  if (!set) return
  set.delete(ws)
  if (set.size === 0) clients.delete(projectId)
}

export function broadcast(projectId: string, event: object): void {
  const set = clients.get(projectId)
  if (!set || set.size === 0) return
  const message = JSON.stringify(event)
  for (const ws of set) {
    try {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(message)
      }
    } catch {
      // ignore send errors; client will be cleaned up on close
    }
  }
}

/** Returns connected client count for a project. Used in tests. */
export function clientCount(projectId: string): number {
  return clients.get(projectId)?.size ?? 0
}
