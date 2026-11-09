/**
 * One-click unsubscribe (RFC 8058): a single POST to a mailing list's https
 * List-Unsubscribe link, for a message whose List-Unsubscribe-Post header is
 * "List-Unsubscribe=One-Click". No browser, no page to read or click.
 *
 * It has an effect outside the computer, so a goal run may use it only for an
 * approved action: the guard plugin checks it against the goal's tool rules
 * (the unsubscribe template maps it to email.unsubscribe).
 */
import { UnsubscribeOneClickSchema } from '../schema.js'

const TIMEOUT_MS = 15_000

/** Why a link can't be used, or null: https only, and never this computer or a private network. */
export function unsafeLink(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim().replace(/^<|>$/g, ''))
  } catch {
    return 'not a web address'
  }
  if (url.protocol !== 'https:') return 'only https links can be used'
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !host.includes(':')) return 'a local address'
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return 'a private network address'
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return 'a private network address'
  return null
}

export async function unsubscribe_one_click(args: unknown, post: typeof fetch = fetch) {
  const { url } = UnsubscribeOneClickSchema.parse(args)
  const link = url.trim().replace(/^<|>$/g, '')
  const problem = unsafeLink(link)
  if (problem) throw new Error(`Can't use that unsubscribe link: ${problem}.`)
  const res = await post(link, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  // 2xx is done; a redirect after the POST is how some senders confirm
  const done = res.status >= 200 && res.status < 400
  return {
    unsubscribed: done,
    status: res.status,
    note: done
      ? 'The sender accepted the one-click unsubscribe.'
      : `The sender answered ${res.status}: fall back to the link in Chrome or the mailto address, or ask the person.`,
  }
}
