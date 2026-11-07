import type { IncomingMessage } from 'http'

/**
 * Protects the local server from other websites open in the same browser.
 *
 * - Host check: blocks DNS-rebinding, where an attacker's domain is pointed
 *   at 127.0.0.1 so their page can read our responses.
 * - Origin check: blocks cross-site requests (e.g. a hidden form POST to
 *   /api/plans/:id/agent/run) and cross-site WebSocket connections.
 *
 * Requests without an Origin header (curl, same-origin GETs) only need a valid Host.
 * Set CONDUCTOR_ALLOWED_HOSTS (comma-separated host:port list) to allow more,
 * e.g. when binding to a LAN address.
 */
export function allowedHosts(hostname: string, port: number): Set<string> {
  const hosts = new Set(
    ['localhost', '127.0.0.1', '[::1]', hostname].map((h) => `${h}:${port}`.toLowerCase()),
  )
  for (const h of (process.env.CONDUCTOR_ALLOWED_HOSTS ?? '').split(',')) {
    if (h.trim()) hosts.add(h.trim().toLowerCase())
  }
  return hosts
}

export function isAllowedRequest(req: IncomingMessage, allowed: Set<string>): boolean {
  const host = req.headers.host?.toLowerCase()
  if (!host || !allowed.has(host)) return false

  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return allowed.has(new URL(origin).host.toLowerCase())
  } catch {
    return false // includes the opaque "null" origin from sandboxed iframes / file://
  }
}
