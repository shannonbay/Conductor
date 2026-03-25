import { NextRequest } from 'next/server'
import { getPlan } from '@/lib/db'
import { cancelAgent } from '@/lib/agent-runner'
import { ok, notFound, err, serverError } from '@/lib/api-utils'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: planId } = await params
    if (!getPlan(planId)) return notFound('Project')
    try {
      await cancelAgent(planId)
      return ok({ status: 'cancelled' })
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e), 409)
    }
  } catch (e) {
    return serverError(e)
  }
}
