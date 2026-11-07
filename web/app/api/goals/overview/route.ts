import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import {
  listGoals, getGoalItems, listRuns, getOpenRun, listHealth, listMemory, getSchedule, getAutonomySuggestions, getEvents,
} from '@/lib/db'
import { describeActivity } from '@/lib/goal-activity'
import { itemView } from '@/lib/goal-views'
import { serverError } from '@/lib/api-utils'

const RUNS = 5
const OPEN_ITEMS = 10
const HEALTH = 20
const MEMORY = 10
/** Recent events read to find a running agent's latest step. */
const ACTIVITY_EVENTS = 20

/**
 * GET — every goal that isn't retired, with what a compact view (the Claude
 * Code plugin's pane) needs, in one call. Carries an ETag: send it back as
 * If-None-Match and an unchanged overview answers 304 with no body.
 */
export async function GET(req: NextRequest) {
  try {
    const goals = listGoals()
      .filter(({ goal }) => goal.status !== 'retired')
      .sort((a, b) => a.plan.name.localeCompare(b.plan.name))
      .map(({ plan, goal }) => {
        const items = getGoalItems(plan.id)
        const open = items.filter((t) => t.status === 'pending' || t.status === 'active')
        const openRun = getOpenRun(plan.id) ?? null
        const runs = listRuns(plan.id, RUNS, { includeSkipped: false })
        return {
          id: plan.id,
          name: plan.name,
          objective: goal.objective,
          status: goal.status,
          next_run_at: goal.next_run_at,
          schedule: getSchedule(plan.id),
          open_run: openRun,
          activity: describeActivity({
            goal,
            openRun,
            lastRun: runs.find((r) => r.status !== 'queued' && r.status !== 'running') ?? null,
            events: openRun?.status === 'running' ? getEvents(plan.id, undefined, ACTIVITY_EVENTS) : [],
            items,
          }),
          runs: runs.map((r) => ({
            id: r.id, status: r.status, trigger: r.trigger, summary: r.summary, started_at: r.started_at, ended_at: r.ended_at,
          })),
          needs_you: open.filter((t) => t.review_requested_at).map(itemView),
          open_items: open.filter((t) => !t.review_requested_at).slice(0, OPEN_ITEMS).map(itemView),
          open_item_count: open.filter((t) => !t.review_requested_at).length,
          health: listHealth(plan.id, HEALTH).map((h) => ({ passed: h.passed, value: h.value, created_at: h.created_at })),
          memory: listMemory(plan.id, { activeOnly: true }).slice(-MEMORY).reverse()
            .map((m) => ({ id: m.id, kind: m.kind, text: m.text, source: m.source, pinned: m.pinned, created_at: m.created_at })),
          suggestions: getAutonomySuggestions(plan.id),
        }
      })

    const body = JSON.stringify({ goals })
    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`
    const headers = { ETag: etag, 'Cache-Control': 'no-cache' }
    if (req.headers.get('if-none-match') === etag) return new NextResponse(null, { status: 304, headers })
    return new NextResponse(body, { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } })
  } catch (e) {
    return serverError(e)
  }
}
