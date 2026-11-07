import { isProposal, type Task } from '@/lib/db'

/** A goal work item as the goal page and the overview show it. */
export function itemView(t: Task) {
  return {
    id: t.id,
    goal: t.goal,
    status: t.status,
    result: t.result,
    notes: t.notes,
    external_ref: t.external_ref,
    run_id: t.run_id,
    action: isProposal(t) ? t.state.action : null,
    awaiting_review: t.review_requested_at !== null,
    approved_to_execute: isProposal(t) && t.approved_at !== null && t.status === 'active',
    updated_at: t.updated_at,
  }
}

export type ItemView = ReturnType<typeof itemView>
