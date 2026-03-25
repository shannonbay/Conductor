import { NextResponse } from 'next/server'

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status })
}

export function err(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status })
}

export function notFound(what = 'Resource'): NextResponse {
  return err(`${what} not found`, 404)
}

export function conflict(message: string): NextResponse {
  return err(message, 409)
}

export function serverError(e: unknown): NextResponse {
  const message = e instanceof Error ? e.message : String(e)
  console.error('[API Error]', e)
  const name = e instanceof Error ? e.name : ''
  if (name === 'ChannelNotConnectedError' || name === 'ChannelBusyError') {
    return err(message, 503)
  }
  return err(message, 500)
}
