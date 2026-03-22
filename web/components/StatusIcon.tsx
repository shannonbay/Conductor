import { cn } from '@/lib/cn'

type Status = 'active' | 'pending' | 'completed' | 'abandoned'

interface Props {
  status: Status
  isAgentWorking?: boolean
  isBlocked?: boolean
}

export function StatusIcon({ status, isAgentWorking, isBlocked }: Props) {
  if (isBlocked) return <span className="text-amber-500 text-sm" title="Blocked">🔒</span>

  if (status === 'completed') {
    return <span className="text-green-600 font-bold text-sm" title="Completed">✓</span>
  }
  if (status === 'abandoned') {
    return <span className="text-red-400 text-sm" title="Abandoned">✗</span>
  }
  if (status === 'active') {
    return (
      <span
        className={cn('inline-block w-3 h-3 rounded-full border-2 border-blue-500 bg-blue-100', isAgentWorking && 'animate-pulse-slow')}
        title={isAgentWorking ? 'Active (agent working)' : 'Active'}
      />
    )
  }
  // pending
  return <span className="inline-block w-3 h-3 rounded-full border-2 border-gray-400" title="Pending" />
}
