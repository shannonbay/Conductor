'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useStore } from '@/lib/store'
import { useProjectWebSocket } from '@/lib/use-project-ws'
import { TreePanel } from '@/components/TreePanel'
import { DetailPane } from '@/components/DetailPane'
import { ActivityFeed } from '@/components/ActivityFeed'
import { ProjectPlanOverlay } from '@/components/ProjectPlanOverlay'
import { SettingsButton } from '@/components/SettingsButton'
import type { ProjectRow, TreeNode, TreeStats, Event, AgentSession } from '@/lib/db'
import type { ProjectPlanProposal } from '@/lib/project-planner'

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
  const [genOpen, setGenOpen] = useState(false)
  const [genLoading, setGenLoading] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [genProposal, setGenProposal] = useState<ProjectPlanProposal | null>(null)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [newTaskGoal, setNewTaskGoal] = useState('')
  const [newTaskPlan, setNewTaskPlan] = useState('')
  const [newTaskParentId, setNewTaskParentId] = useState('')
  const [newTaskLoading, setNewTaskLoading] = useState(false)
  const [newTaskError, setNewTaskError] = useState<string | null>(null)
  const [promptText, setPromptText] = useState('')
  const [promptSending, setPromptSending] = useState(false)
  const { setProject, setTree, setAgentSession, agentSession: liveSession, selectedTaskId } = useStore()

  async function handleGenerate() {
    setGenOpen(true)
    setGenLoading(true)
    setGenError(null)
    setGenProposal(null)
    try {
      const res = await fetch(`/api/projects/${project.id}/generate-plan`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to generate plan')
      setGenProposal(data.proposal)
    } catch (e) {
      setGenError(e instanceof Error ? e.message : 'Error')
    } finally {
      setGenLoading(false)
    }
  }

  function openNewTask() {
    setNewTaskParentId(selectedTaskId ?? '')
    setNewTaskGoal('')
    setNewTaskPlan('')
    setNewTaskError(null)
    setNewTaskOpen(true)
  }

  async function handleCreateTask(e: React.FormEvent) {
    e.preventDefault()
    const steps = newTaskPlan.split('\n').map(s => s.trim()).filter(Boolean)
    if (!newTaskGoal.trim() || steps.length === 0) return
    setNewTaskLoading(true)
    setNewTaskError(null)
    try {
      const res = await fetch(`/api/projects/${project.id}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal: newTaskGoal.trim(),
          plan: steps,
          parent_id: newTaskParentId.trim() || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to create task')
      setNewTaskOpen(false)
    } catch (e) {
      setNewTaskError(e instanceof Error ? e.message : 'Error')
    } finally {
      setNewTaskLoading(false)
    }
  }

  async function handleSendPrompt(e: React.FormEvent) {
    e.preventDefault()
    if (!promptText.trim() || !currentSession) return
    setPromptSending(true)
    try {
      await fetch(`/api/projects/${project.id}/agent/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: promptText.trim() }),
      })
      setPromptText('')
    } finally {
      setPromptSending(false)
    }
  }

  async function handleArchive() {
    setActing(true)
    await fetch(`/api/projects/${project.id}/archive`, { method: 'POST' })
    router.refresh()
    router.push('/')
  }

  async function handleUnarchive() {
    setActing(true)
    await fetch(`/api/projects/${project.id}/restore`, { method: 'POST' })
    router.refresh()
    router.push('/')
  }

  async function handleDelete() {
    if (!confirm(`Delete project "${project.name}"? This cannot be undone.`)) return
    setActing(true)
    await fetch(`/api/projects/${project.id}`, { method: 'DELETE' })
    router.refresh()
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
        <SettingsButton />
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
          <div className="px-3 py-2 border-b flex items-center justify-between">
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Task Tree</span>
            <div className="flex items-center gap-1">
              <button
                onClick={handleGenerate}
                title="Generate plan with AI"
                className="text-gray-400 hover:text-gray-700 text-xs leading-none px-1"
              >
                ✦✦✦
              </button>
              <button
                onClick={openNewTask}
                title="New task"
                className="text-gray-400 hover:text-gray-700 text-base leading-none px-1"
              >
                +
              </button>
            </div>
          </div>
          <TreePanel agentLockedTaskIds={lockedTaskIds} />
        </div>

        {/* Detail + Activity */}
        <div className="flex-1 flex flex-col min-w-0">
          <DetailPane projectId={project.id} />

          {/* Prompt bar */}
          <div className="border-t flex-shrink-0 px-3 py-2">
            <form onSubmit={handleSendPrompt} className="flex gap-2">
              <input
                value={promptText}
                onChange={e => setPromptText(e.target.value)}
                disabled={!currentSession || promptSending}
                placeholder={currentSession ? 'Send instruction to agent…' : 'Start an agent on a task to send instructions'}
                className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-gray-900 disabled:bg-gray-50 disabled:text-gray-400"
              />
              <button
                type="submit"
                disabled={!promptText.trim() || !currentSession || promptSending}
                className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {promptSending ? '…' : '↑'}
              </button>
            </form>
          </div>

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

      {genOpen && (
        <ProjectPlanOverlay
          projectId={project.id}
          loading={genLoading}
          error={genError}
          proposal={genProposal}
          onClose={() => setGenOpen(false)}
          onRetry={handleGenerate}
          onAccepted={() => setGenOpen(false)}
        />
      )}

      {newTaskOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
            <h2 className="text-lg font-semibold mb-4">New Task</h2>
            <form onSubmit={handleCreateTask} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Goal</label>
                <input
                  autoFocus
                  value={newTaskGoal}
                  onChange={e => setNewTaskGoal(e.target.value)}
                  placeholder="What should this task accomplish?"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Plan steps <span className="text-gray-400 font-normal">(one per line)</span>
                </label>
                <textarea
                  value={newTaskPlan}
                  onChange={e => setNewTaskPlan(e.target.value)}
                  rows={4}
                  placeholder={"Step one\nStep two\nStep three"}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 resize-none font-mono"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Parent task ID <span className="text-gray-400 font-normal">(leave blank for root)</span>
                </label>
                <input
                  value={newTaskParentId}
                  onChange={e => setNewTaskParentId(e.target.value)}
                  placeholder="e.g. 1.2"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 font-mono"
                />
              </div>
              {newTaskError && <p className="text-sm text-red-600">{newTaskError}</p>}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setNewTaskOpen(false)}
                  className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!newTaskGoal.trim() || !newTaskPlan.trim() || newTaskLoading}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {newTaskLoading ? 'Creating…' : 'Create Task'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
