'use client'

import { useStore } from '@/lib/store'
import { TaskNode } from './TaskNode'
import type { TreeNode } from '@/lib/db'

interface Props {
  agentLockedTaskIds?: Set<string>
}

function renderNodes(
  nodes: TreeNode[],
  depth: number,
  expandedIds: Set<string>,
  selectedTaskId: string | null,
  agentLockedTaskIds: Set<string>,
  onSelect: (id: string) => void,
  onToggle: (id: string) => void,
): React.ReactNode {
  return nodes.map((node) => {
    const isExpanded = expandedIds.has(node.id)
    return (
      <div key={node.id}>
        <TaskNode
          task={node}
          depth={depth}
          isSelected={selectedTaskId === node.id}
          isExpanded={isExpanded}
          hasChildren={node.children.length > 0}
          isAgentWorking={agentLockedTaskIds.has(node.id)}
          onSelect={() => onSelect(node.id)}
          onToggle={() => onToggle(node.id)}
        />
        {isExpanded && node.children.length > 0 && (
          <div>
            {renderNodes(node.children, depth + 1, expandedIds, selectedTaskId, agentLockedTaskIds, onSelect, onToggle)}
          </div>
        )}
      </div>
    )
  })
}

export function TreePanel({ agentLockedTaskIds = new Set() }: Props) {
  const { tree, selectedTaskId, expandedIds, setSelectedTaskId, toggleExpanded } = useStore()

  if (tree.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm p-6 text-center">
        No tasks yet.
        <br />
        Select a project and create a task to get started.
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto py-2">
      {renderNodes(tree, 0, expandedIds, selectedTaskId, agentLockedTaskIds, setSelectedTaskId, toggleExpanded)}
    </div>
  )
}
