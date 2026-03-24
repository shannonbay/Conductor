import { NextRequest } from 'next/server'
import { getPlan, getActiveSession } from '@/lib/db'
import { ok, notFound, serverError } from '@/lib/api-utils'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: planId } = await params
    if (!getPlan(planId)) return notFound('Project')
    const session = getActiveSession(planId)
    return ok(session ?? null)
  } catch (e) {
    return serverError(e)
  }
}
