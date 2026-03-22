import { notFound } from 'next/navigation'
import { getProject, getFullTree, getTreeStats, getEvents, getActiveSession } from '@/lib/db'
import { ProjectView } from './ProjectView'

export const dynamic = 'force-dynamic'

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const project = getProject(id)
  if (!project) notFound()

  const tree = getFullTree(id)
  const stats = getTreeStats(id)
  const events = getEvents(id)
  const agentSession = getActiveSession(id) ?? null

  return (
    <ProjectView
      project={project}
      tree={tree}
      stats={stats}
      events={events}
      agentSession={agentSession}
    />
  )
}
