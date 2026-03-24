import { notFound } from 'next/navigation'
import { getPlan, getFullTree, getTreeStats, getEvents, getActiveSession } from '@/lib/db'
import { PlanView } from './PlanView'

export const dynamic = 'force-dynamic'

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const project = getPlan(id)
  if (!project) notFound()

  const tree = getFullTree(id)
  const stats = getTreeStats(id)
  const events = getEvents(id, undefined, 200).reverse()
  const agentSession = getActiveSession(id) ?? null

  return (
    <PlanView
      project={project}
      tree={tree}
      stats={stats}
      events={events}
      agentSession={agentSession}
    />
  )
}
