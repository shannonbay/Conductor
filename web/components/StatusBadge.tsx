import { cn } from '@/lib/cn'

type Status = 'active' | 'pending' | 'completed' | 'abandoned'

const config: Record<Status, { label: string; className: string }> = {
  active: { label: 'Active', className: 'bg-blue-100 text-blue-700' },
  pending: { label: 'Pending', className: 'bg-gray-100 text-gray-600' },
  completed: { label: 'Completed', className: 'bg-green-100 text-green-700' },
  abandoned: { label: 'Abandoned', className: 'bg-red-100 text-red-600' },
}

export function StatusBadge({ status }: { status: Status }) {
  const { label, className } = config[status]
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded text-xs font-medium', className)}>
      {label}
    </span>
  )
}
