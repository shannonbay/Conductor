'use client'

import { cn } from '@/lib/cn'
import { StatusIcon } from './StatusIcon'
import type { Task } from '@/lib/db'

interface Props {
  task: Task & { children?: { id: string }[] }
  depth: number
  isSelected: boolean
  isExpanded: boolean
  hasChildren: boolean
  isAgentWorking: boolean
  onSelect: () => void
  onToggle: () => void
}

export function TaskNode({ task, depth, isSelected, isExpanded, hasChildren, isAgentWorking, onSelect, onToggle }: Props) {
  const isBlocked = task.status === 'pending' && (task.depends_on?.length ?? 0) > 0

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 cursor-pointer rounded-md mx-1 group text-sm',
        isSelected ? 'bg-gray-100 text-gray-900' : 'text-gray-700 hover:bg-gray-50',
      )}
      style={{ paddingLeft: `${12 + depth * 16}px` }}
      onClick={onSelect}
    >
      {/* Expand/collapse toggle */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggle() }}
        className={cn('w-4 h-4 flex items-center justify-center text-gray-400 hover:text-gray-700 flex-shrink-0', !hasChildren && 'invisible')}
        aria-label={isExpanded ? 'Collapse' : 'Expand'}
      >
        {isExpanded ? '▾' : '▸'}
      </button>

      {/* Status icon */}
      <span className="flex-shrink-0 flex items-center">
        <StatusIcon status={task.status} isAgentWorking={isAgentWorking} isBlocked={isBlocked} />
      </span>

      {/* Task ID */}
      <span className="text-xs text-gray-400 font-mono flex-shrink-0">{task.id}</span>

      {/* Goal */}
      <span className="truncate flex-1 min-w-0">{task.goal}</span>

      {/* Agent indicator */}
      {isAgentWorking && (
        <span className="text-xs text-blue-500 flex-shrink-0">🤖</span>
      )}
    </div>
  )
}
