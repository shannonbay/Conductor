import { NextRequest } from 'next/server'
import { getPlan, getEvents } from '@/lib/db'
import { ok, notFound, serverError } from '@/lib/api-utils'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const plan = getPlan(id)
    if (!plan) return notFound('Plan')

    const limitParam = req.nextUrl.searchParams.get('limit')
    const limit = limitParam ? Math.max(1, Math.min(parseInt(limitParam, 10) || 200, 1000)) : 200

    // getEvents returns DESC; reverse to chronological order for the feed
    const events = getEvents(id, undefined, limit).reverse()
    return ok(events)
  } catch (e) {
    return serverError(e)
  }
}
