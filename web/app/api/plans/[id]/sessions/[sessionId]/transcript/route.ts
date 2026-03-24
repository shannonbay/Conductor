import { NextRequest, NextResponse } from 'next/server'
import { getPlan, getSession, getTranscriptMessages } from '@/lib/db'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; sessionId: string }> },
) {
  const { id, sessionId } = await params

  const plan = getPlan(id)
  if (!plan) return NextResponse.json({ error: 'Plan not found' }, { status: 404 })

  const session = getSession(sessionId)
  if (!session || session.plan_id !== id) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  const messages = getTranscriptMessages(sessionId)
  return NextResponse.json(messages)
}
