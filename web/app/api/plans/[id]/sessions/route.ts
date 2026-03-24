import { NextRequest, NextResponse } from 'next/server'
import { getPlan, getSessionsForPlan } from '@/lib/db'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const plan = getPlan(id)
  if (!plan) return NextResponse.json({ error: 'Plan not found' }, { status: 404 })

  const sessions = getSessionsForPlan(id)
  return NextResponse.json(sessions)
}
