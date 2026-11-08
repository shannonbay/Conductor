import { NextRequest, NextResponse } from 'next/server'
import { overviewWithEtag } from '@/lib/db'
import { serverError } from '@/lib/api-utils'

/**
 * GET — every goal that isn't retired, with what a compact view needs, in one
 * call (built in core; the MCP tool goals_overview answers the same). Carries
 * an ETag: send it back as If-None-Match and an unchanged overview answers 304.
 */
export async function GET(req: NextRequest) {
  try {
    const { body, etag } = overviewWithEtag()
    const headers = { ETag: etag, 'Cache-Control': 'no-cache' }
    if (req.headers.get('if-none-match') === etag) return new NextResponse(null, { status: 304, headers })
    return new NextResponse(body, { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } })
  } catch (e) {
    return serverError(e)
  }
}
