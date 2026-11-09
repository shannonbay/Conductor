import { describe, it, expect } from 'vitest'
import { unsafeLink, unsubscribe_one_click } from '../../tools/unsubscribe.js'

describe('unsubscribe_one_click', () => {
  it('sends one RFC 8058 POST and reports the answer', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const post = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(null, { status: 202 })
    }) as unknown as typeof fetch
    const r = await unsubscribe_one_click({ url: '<https://lists.example.com/u?id=42>' }, post)
    expect(r).toMatchObject({ unsubscribed: true, status: 202 })
    expect(calls[0]).toMatchObject({ url: 'https://lists.example.com/u?id=42', init: { method: 'POST', body: 'List-Unsubscribe=One-Click' } })
  })

  it('says to fall back when the sender refuses', async () => {
    const post = (async () => new Response(null, { status: 405 })) as unknown as typeof fetch
    expect(await unsubscribe_one_click({ url: 'https://lists.example.com/u' }, post)).toMatchObject({ unsubscribed: false, status: 405 })
  })

  it('refuses anything but a public https link', async () => {
    expect(unsafeLink('http://lists.example.com/u')).toMatch(/https/)
    expect(unsafeLink('https://localhost/u')).toMatch(/local/)
    expect(unsafeLink('https://192.168.1.10/u')).toMatch(/private/)
    expect(unsafeLink('https://10.0.0.1/u')).toMatch(/private/)
    expect(unsafeLink('mailto:unsub@example.com')).toMatch(/https/)
    expect(unsafeLink('https://email.chess.com/unsub/abc')).toBeNull()
    await expect(unsubscribe_one_click({ url: 'http://example.com/u' })).rejects.toThrow(/only https/)
  })
})
