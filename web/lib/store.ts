'use client'

import { create } from 'zustand'
import type { Task, TreeNode, AgentSession, ProjectRow, TreeStats } from './db'
import type { ProposedTask, ModifyDiff } from './planning'

interface Store {
  // Project
  project: ProjectRow | null
  treeStats: TreeStats | null

  // Tree
  tree: TreeNode[]
  taskMap: Map<string, Task>

  // Selection
  selectedTaskId: string | null
  expandedIds: Set<string>

  // Agent
  agentSession: AgentSession | null

  // AI drafts
  planDraft: ProposedTask[] | null
  modifyDiff: ModifyDiff | null

  // Actions
  setProject(project: ProjectRow, stats: TreeStats): void
  setTree(nodes: TreeNode[]): void
  updateTask(task: Task): void
  removeTask(taskId: string): void
  setSelectedTaskId(id: string | null): void
  toggleExpanded(id: string): void
  expandAll(): void
  setAgentSession(session: AgentSession | null): void
  setPlanDraft(draft: ProposedTask[] | null): void
  setModifyDiff(diff: ModifyDiff | null): void
}

function flattenTree(nodes: TreeNode[], map = new Map<string, Task>()): Map<string, Task> {
  for (const node of nodes) {
    const { children: _, ...task } = node
    map.set(node.id, task as Task)
    flattenTree(node.children, map)
  }
  return map
}

export const useStore = create<Store>((set, get) => ({
  project: null,
  treeStats: null,
  tree: [],
  taskMap: new Map(),
  selectedTaskId: null,
  expandedIds: new Set(),
  agentSession: null,
  planDraft: null,
  modifyDiff: null,

  setProject(project, stats) {
    set({ project, treeStats: stats })
  },

  setTree(nodes) {
    set({ tree: nodes, taskMap: flattenTree(nodes) })
  },

  updateTask(task) {
    const { taskMap } = get()
    const newMap = new Map(taskMap)
    newMap.set(task.id, task)
    set({ taskMap: newMap })
  },

  removeTask(taskId) {
    const { taskMap } = get()
    const newMap = new Map(taskMap)
    // Remove task and all descendants
    for (const key of newMap.keys()) {
      if (key === taskId || key.startsWith(`${taskId}.`)) newMap.delete(key)
    }
    set({ taskMap: newMap })
  },

  setSelectedTaskId(id) {
    set({ selectedTaskId: id })
  },

  toggleExpanded(id) {
    const { expandedIds } = get()
    const next = new Set(expandedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    set({ expandedIds: next })
  },

  expandAll() {
    const { taskMap } = get()
    set({ expandedIds: new Set(taskMap.keys()) })
  },

  setAgentSession(session) {
    set({ agentSession: session })
  },

  setPlanDraft(draft) {
    set({ planDraft: draft })
  },

  setModifyDiff(diff) {
    set({ modifyDiff: diff })
  },
}))
