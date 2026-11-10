import Link from 'next/link'
import { listGoals, getGoalItems, listRuns } from '@/lib/db'
import { NewGoalButton } from '@/components/NewGoalButton'

export const dynamic = 'force-dynamic'

export default function DashboardPage() {
  const goals = listGoals()
    .filter(({ goal }) => goal.status !== 'retired')
    .map(({ plan, goal }) => {
      const open = getGoalItems(plan.id).filter((t) => t.status === 'pending' || t.status === 'active')
      return { plan, goal, needsYou: open.filter((t) => t.review_requested_at).length, open: open.length, lastRun: listRuns(plan.id, 1)[0] }
    })

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Quarterdeck</h1>
        <div className="flex items-center gap-2">
          <NewGoalButton />
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-10">
        {goals.length > 0 && (
          <section className="mb-10">
            <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">Goals</h2>
            <div className="grid gap-3">
              {goals.map(({ plan, goal, needsYou, open, lastRun }) => (
                <Link
                  key={plan.id}
                  href={`/goals/${plan.id}`}
                  className="bg-white rounded-lg border border-gray-200 px-5 py-4 hover:border-gray-400 hover:shadow-sm transition-all flex items-center justify-between gap-4"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-gray-900">{plan.name}</p>
                      {goal.status === 'paused' && <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">paused</span>}
                    </div>
                    <p className="text-sm text-gray-500 mt-0.5 line-clamp-1">{goal.objective}</p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0 text-sm">
                    {needsYou > 0 && (
                      <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">{needsYou} need{needsYou === 1 ? 's' : ''} you</span>
                    )}
                    <span className="text-gray-400 tabular-nums">{open} open</span>
                    {lastRun && <span className="text-gray-400">· last run {lastRun.status}</span>}
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {goals.length === 0 && (
          <div className="text-center py-24">
            <h2 className="text-2xl font-medium text-gray-700 mb-2">No goals yet</h2>
            <p className="text-gray-500 mb-6">A goal is something you want kept true, worked on by agents on a schedule. Create one here or with /goal-new in Claude Code.</p>
            <NewGoalButton />
          </div>
        )}
      </main>
    </div>
  )
}
