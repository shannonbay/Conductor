'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useStore } from '@/lib/store'
import { useProjectWebSocket } from '@/lib/use-project-ws'
import { TreePanel } from '@/components/TreePanel'
import { DetailPane } from '@/components/DetailPane'
import { ActivityFeed } from '@/components/ActivityFeed'
import type { ProjectRow, TreeNode, TreeStats, Event, AgentSession } from '@/lib/db'

interface Props {
  project: ProjectRow
  tree: TreeNode[]
  stats: TreeStats
  events: Event[]
  agentSession: AgentSession | null
}

export function ProjectView({ project, tree, stats, events, agentSession }: Props) {
  const router = useRouter()
  const [acting, setActing] = useState(false)
  const { setProject, setTree, setAgentSession, agentSession: liveSession } = useStore()

  async function handleArchive() {
    setActing(true)
    await fetch(`/api/projects/${project.id}/archive`, { method: 'POST' })
    router.push('/')
  }

  async function handleUnarchive() {
    setActing(true)
    await fetch(`/api/projects/${project.id}/restore`, { method: 'POST' })
    router.push('/')
  }

  async function handleDelete() {
    if (!confirm(`Delete project "${project.name}"? This cannot be undone.`)) return
    setActing(true)
    await fetch(`/api/projects/${project.id}`, { method: 'DELETE' })
    router.push('/')
  }

  // Initialise store from server-rendered data
  useEffect(() => {
    setProject(project, stats)
    setTree(tree)
    setAgentSession(agentSession)
  }, [project.id])

  // Subscribe to live updates
  useProjectWebSocket(project.id)

  const currentSession = liveSession ?? agentSession

  // Collect locked task IDs from agent session
  const lockedTaskIds = new Set<string>()
  if (currentSession?.status === 'running' || currentSession?.status === 'paused') {
    // We don't have the full list here; it will update via WebSocket
  }

  return (
    <div className="h-screen flex flex-col bg-white">
      {/* Top bar */}
      <header className="border-b flex items-center gap-4 px-4 py-2 flex-shrink-0">
        <Link href="/" className="text-sm text-gray-500 hover:text-gray-900">← Projects</Link>
        <h1 className="font-semibold text-gray-900 flex-1 min-w-0 truncate">{project.name}</h1>
        <span className="text-xs text-gray-400">{stats.completed}/{stats.total_tasks} tasks complete</span>
        {project.status === 'active' ? (
          <button onClick={handleArchive} disabled={acting} className="text-xs px-2 py-1 rounded border text-gray-600 hover:bg-gray-50 disabled:opacity-50">Archive</button>
        ) : (
          <button onClick={handleUnarchive} disabled={acting} className="text-xs px-2 py-1 rounded border text-gray-600 hover:bg-gray-50 disabled:opacity-50">Unarchive</button>
        )}
        <button onClick={handleDelete} disabled={acting} className="text-xs px-2 py-1 rounded border text-red-600 hover:bg-red-50 disabled:opacity-50">Delete</button>
        {currentSession && (
          <span className={`text-xs px-2 py-0.5 rounded ${currentSession.status === 'running' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>
            🤖 Agent {currentSession.status}
          </span>
        )}
      </header>

      {/* Main content */}
      <div className="flex-1 flex min-h-0">
        {/* Tree panel */}
        <div className="w-72 border-r flex flex-col flex-shrink-0">
          <div className="px-3 py-2 border-b">
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Task Tree</span>
          </div>
          <TreePanel agentLockedTaskIds={lockedTaskIds} />
        </div>

        {/* Detail + Activity */}
        <div className="flex-1 flex flex-col min-w-0">
          <DetailPane projectId={project.id} />

          {/* Activity feed */}
          <div className="border-t flex-shrink-0 max-h-48 overflow-y-auto">
            <div className="px-4 py-2 border-b">
              <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Activity</span>
            </div>
            <div className="px-4 py-3">
              <ActivityFeed events={events} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
