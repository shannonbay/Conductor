/**
 * The session state the pane and band draw from (declared in ../types).
 * The engine reads state references in the file that declares them, so the
 * rest of the plugin goes through these accessors.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { ActiveRun, Confirm, RunEntry, Snapshot } from '../types'
import { EMPTY } from './model'

type $ = EngineInterface

export const PANE = 'conductor-goals'

const snapshot = atom({ plugin: 'conductor-goals', key: 'snapshot' } as const, EMPTY, { shape: 'snapshot-3' })
const rejecting = atom({ plugin: 'conductor-goals', key: 'rejecting' } as const, null)
const busy = atom({ plugin: 'conductor-goals', key: 'busy' } as const, null)
const notice = atom({ plugin: 'conductor-goals', key: 'notice' } as const, null)
const expanded = atom({ plugin: 'conductor-goals', key: 'expanded' } as const, [])
const confirm = atom({ plugin: 'conductor-goals', key: 'confirm' } as const, null)
const activeRun = atom({ plugin: 'conductor-goals', key: 'activeRun' } as const, null)
const runs = atom({ plugin: 'conductor-goals', key: 'runs' } as const, {})
const guardMissing = atom({ plugin: 'conductor-goals', key: 'guardMissing' } as const, false)

export async function getSnapshot($: $): Promise<Snapshot> {
  return read($, snapshot)
}
export async function setSnapshot($: $, value: Snapshot): Promise<void> {
  await update($, snapshot, () => value)
}

export async function getRejecting($: $): Promise<string | null> {
  return read($, rejecting)
}
export async function setRejecting($: $, value: string | null): Promise<void> {
  await update($, rejecting, () => value)
}

export async function getBusy($: $): Promise<string | null> {
  return read($, busy)
}
export async function setBusy($: $, value: string | null): Promise<void> {
  await update($, busy, () => value)
}

export async function getNotice($: $): Promise<string | null> {
  return read($, notice)
}
export async function setNotice($: $, value: string | null): Promise<void> {
  await update($, notice, () => value)
}

export async function getExpanded($: $): Promise<string[]> {
  return read($, expanded)
}
export async function toggleExpanded($: $, goalId: string): Promise<void> {
  await update($, expanded, (ids) => (ids.includes(goalId) ? ids.filter((id) => id !== goalId) : [...ids, goalId]))
}

export async function getConfirm($: $): Promise<Confirm | null> {
  return read($, confirm)
}
export async function setConfirm($: $, value: Confirm | null): Promise<void> {
  await update($, confirm, () => value)
}

export async function getActiveRun($: $): Promise<ActiveRun | null> {
  return read($, activeRun)
}
export async function setActiveRun($: $, value: ActiveRun | null): Promise<void> {
  await update($, activeRun, () => value)
}

export async function getGuardMissing($: $): Promise<boolean> {
  return read($, guardMissing)
}
/** Writes only on a change, so the pane redraws only when the guard comes or goes. */
export async function setGuardMissing($: $, value: boolean): Promise<void> {
  if ((await read($, guardMissing)) !== value) await update($, guardMissing, () => value)
}

export async function getRuns($: $): Promise<Record<string, RunEntry>> {
  return read($, runs)
}
export async function addRun($: $, agentId: string, entry: RunEntry): Promise<void> {
  await update($, runs, (all) => ({ ...all, [agentId]: entry }))
}
export async function removeRun($: $, agentId: string): Promise<void> {
  await update($, runs, (all) => {
    const { [agentId]: _gone, ...rest } = all
    return rest
  })
}
