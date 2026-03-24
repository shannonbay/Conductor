import { NextRequest } from 'next/server'
import { getPlan } from '@/lib/db'
import { pauseAgent } from '@/lib/agent-runner'
import { ok, notFound, err, serverError } from '@/lib/api-utils'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: planId } = await params
    if (!getPlan(planId)) return notFound('Project')
    try {
      pauseAgent(planId)
      return ok({ status: 'paused' })
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e), 409)
    }
  } catch (e) {
    return serverError(e)
  }
}
