import { describe, it, expect, afterEach } from 'vitest'
import type { IncomingMessage } from 'http'
import { allowedHosts, isAllowedRequest } from '@/lib/request-guard'

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe('request-guard', () => {
  const allowed = allowedHosts('localhost', 3000)

  afterEach(() => { delete process.env.CONDUCTOR_ALLOWED_HOSTS })

  it('allows same-origin requests to localhost', () => {
    expect(isAllowedRequest(req({ host: 'localhost:3000', origin: 'http://localhost:3000' }), allowed)).toBe(true)
    expect(isAllowedRequest(req({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' }), allowed)).toBe(true)
  })

  it('allows requests with no Origin header (curl, same-origin GET)', () => {
    expect(isAllowedRequest(req({ host: 'localhost:3000' }), allowed)).toBe(true)
  })

  it('blocks cross-site requests', () => {
    expect(isAllowedRequest(req({ host: 'localhost:3000', origin: 'https://evil.example' }), allowed)).toBe(false)
    expect(isAllowedRequest(req({ host: 'localhost:3000', origin: 'http://localhost:4000' }), allowed)).toBe(false)
  })

  it('blocks the opaque "null" origin', () => {
    expect(isAllowedRequest(req({ host: 'localhost:3000', origin: 'null' }), allowed)).toBe(false)
  })

  it('blocks DNS-rebinding (foreign Host header)', () => {
    expect(isAllowedRequest(req({ host: 'evil.example:3000' }), allowed)).toBe(false)
    expect(isAllowedRequest(req({}), allowed)).toBe(false)
  })

  it('honours CONDUCTOR_ALLOWED_HOSTS', () => {
    process.env.CONDUCTOR_ALLOWED_HOSTS = '192.168.1.5:3000'
    const extra = allowedHosts('localhost', 3000)
    expect(isAllowedRequest(req({ host: '192.168.1.5:3000', origin: 'http://192.168.1.5:3000' }), extra)).toBe(true)
  })
})
