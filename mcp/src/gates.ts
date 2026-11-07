import type { NewTask } from './db.js'

type GateInput = {
  acceptance_criteria?: string[]
  verify_command?: string | null
  verify_timeout_s?: number
  requires_approval?: boolean
}

/** Picks the gate fields that were actually provided, for insert/update. */
export function gateFieldsFrom(input: GateInput): Partial<Pick<NewTask, 'acceptance_criteria' | 'verify_command' | 'verify_timeout_s' | 'requires_approval'>> {
  const fields: ReturnType<typeof gateFieldsFrom> = {}
  if (input.acceptance_criteria !== undefined) fields.acceptance_criteria = input.acceptance_criteria
  if (input.verify_command !== undefined) fields.verify_command = input.verify_command
  if (input.verify_timeout_s !== undefined) fields.verify_timeout_s = input.verify_timeout_s
  if (input.requires_approval !== undefined) fields.requires_approval = input.requires_approval
  return fields
}

/** Short description of a new task's gates for the history log, or undefined if it has none. */
export function gateSummary(input: GateInput): Record<string, unknown> | undefined {
  const g: Record<string, unknown> = {}
  if (input.acceptance_criteria?.length) g.acceptance_criteria = input.acceptance_criteria
  if (input.verify_command) g.verify_command = input.verify_command
  if (input.requires_approval) g.requires_approval = true
  return Object.keys(g).length ? g : undefined
}
