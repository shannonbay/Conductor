import type { WebSocket } from 'ws'

// Anchor to globalThis so all module instances (server.ts + Next.js API routes)
// share the same Map. In dev mode Next.js compiles API routes in isolation from
// server.ts, which would otherwise give each a separate in-memory singleton.
const g = globalThis as typeof globalThis & { __conductorWsClients?: Map<string, Set<WebSocket>> }
if (!g.__conductorWsClients) g.__conductorWsClients = new Map()
const clients = g.__conductorWsClients

export function registerClient(planId: string, ws: WebSocket): void {
  if (!clients.has(planId)) {
    clients.set(planId, new Set())
  }
  clients.get(planId)!.add(ws)
}

export function unregisterClient(planId: string, ws: WebSocket): void {
  const set = clients.get(planId)
  if (!set) return
  set.delete(ws)
  if (set.size === 0) clients.delete(planId)
}

export function broadcast(planId: string, event: object): void {
  const set = clients.get(planId)
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

/** Returns connected client count for a plan. Used in tests. */
export function clientCount(planId: string): number {
  return clients.get(planId)?.size ?? 0
}
