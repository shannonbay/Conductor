import Link from 'next/link'
import { listPlans, getTreeStats } from '@/lib/db'
import { NewPlanButton } from '@/components/NewPlanButton'
import { SettingsButton } from '@/components/SettingsButton'

export const dynamic = 'force-dynamic'

export default function DashboardPage() {
  const projects = listPlans('active')
  const archivedProjects = listPlans('archived')

  const withStats = (ps: typeof projects) =>
    ps.map((p) => ({ ...p, stats: getTreeStats(p.id) }))

  const active = withStats(projects)
  const archived = withStats(archivedProjects)

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Conductor</h1>
        <div className="flex items-center gap-2">
          <SettingsButton />
          <NewPlanButton />
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-10">
        {active.length === 0 && archived.length === 0 ? (
          <div className="text-center py-24">
            <h2 className="text-2xl font-medium text-gray-700 mb-2">What do you want to work on?</h2>
            <p className="text-gray-500 mb-6">Create a plan to start organizing your work into a task tree.</p>
            <NewPlanButton size="lg" />
          </div>
        ) : (
          <>
            <section>
              <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">Active Plans</h2>
              <div className="grid gap-3">
                {active.map((p) => (
                  <Link
                    key={p.id}
                    href={`/plans/${p.id}`}
                    className="bg-white rounded-lg border border-gray-200 px-5 py-4 hover:border-gray-400 hover:shadow-sm transition-all flex items-center justify-between"
                  >
                    <div>
                      <p className="font-medium text-gray-900">{p.name}</p>
                      {p.description && <p className="text-sm text-gray-500 mt-0.5 line-clamp-1">{p.description}</p>}
                    </div>
                    <div className="text-sm text-gray-400 tabular-nums ml-4 flex-shrink-0">
                      {p.stats.completed}/{p.stats.total_tasks} complete
                    </div>
                  </Link>
                ))}
                {active.length === 0 && (
                  <p className="text-gray-400 text-sm text-center py-4">No active plans</p>
                )}
              </div>
            </section>

            {archived.length > 0 && (
              <section className="mt-10">
                <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">Archived</h2>
                <div className="grid gap-3">
                  {archived.map((p) => (
                    <Link
                      key={p.id}
                      href={`/plans/${p.id}`}
                      className="bg-gray-50 rounded-lg border border-gray-200 px-5 py-4 hover:border-gray-400 transition-all flex items-center justify-between opacity-70 hover:opacity-100"
                    >
                      <p className="font-medium text-gray-700">{p.name}</p>
                      <span className="text-xs text-gray-400 ml-4">archived</span>
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  )
}
