import { notFound } from 'next/navigation'
import { getGoal, getPlan } from '@/lib/db'
import { GoalView } from '@/components/GoalView'

export const dynamic = 'force-dynamic'

export default async function GoalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!getPlan(id) || !getGoal(id)) notFound()
  return <GoalView goalId={id} />
}
