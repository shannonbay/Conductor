/**
 * The session state the pane and band draw from (declared in ../types).
 * The engine reads state references in the file that declares them, so the
 * rest of the plugin goes through these accessors.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { ActiveRun, Confirm, PhoneState, RunEntry, Snapshot, Todos } from '../types'
import { EMPTY } from './model'

type Engine = EngineInterface

export const PANE = 'quarterdeck-goals'

const snapshot = atom({ plugin: 'quarterdeck-goals', key: 'snapshot' } as const, EMPTY, { shape: 'snapshot-5' })
const rejecting = atom({ plugin: 'quarterdeck-goals', key: 'rejecting' } as const, null)
const addingTo = atom({ plugin: 'quarterdeck-goals', key: 'addingTo' } as const, null)
const askingAbout = atom({ plugin: 'quarterdeck-goals', key: 'askingAbout' } as const, null)
const discussing = atom({ plugin: 'quarterdeck-goals', key: 'discussing' } as const, null)
const editingTodo = atom({ plugin: 'quarterdeck-goals', key: 'editingTodo' } as const, null)
const busy = atom({ plugin: 'quarterdeck-goals', key: 'busy' } as const, null)
const notice = atom({ plugin: 'quarterdeck-goals', key: 'notice' } as const, null)
const expanded = atom({ plugin: 'quarterdeck-goals', key: 'expanded' } as const, [])
const confirm = atom({ plugin: 'quarterdeck-goals', key: 'confirm' } as const, null)
const activeRun = atom({ plugin: 'quarterdeck-goals', key: 'activeRun' } as const, null)
const runs = atom({ plugin: 'quarterdeck-goals', key: 'runs' } as const, {})
const guardMissing = atom({ plugin: 'quarterdeck-goals', key: 'guardMissing' } as const, false)
/** Set while plan mode refuses the runner's calls: no runs start here until it ends. */
const planMode = atom({ plugin: 'quarterdeck-goals', key: 'planMode' } as const, false)
const todos = atom({ plugin: 'quarterdeck-goals', key: 'todos' } as const, null)
const phone = atom({ plugin: 'quarterdeck-goals', key: 'phone' } as const, 'unknown')
const spinnerFrame = atom({ plugin: 'quarterdeck-goals', key: 'spinnerFrame' } as const, 0)

export async function getSpinnerFrame($: Engine): Promise<number> {
  return read($, spinnerFrame)
}
/** The next frame (wrapping well before the number gets large). */
export async function advanceSpinner($: Engine): Promise<void> {
  await update($, spinnerFrame, (n) => (n + 1) % 1000)
}

export async function getPhone($: Engine): Promise<PhoneState> {
  return read($, phone)
}
/** Writes only on a change, so the pane redraws only when it does. */
export async function setPhone($: Engine, value: PhoneState): Promise<void> {
  if ((await read($, phone)) !== value) await update($, phone, () => value)
}

export async function getSnapshot($: Engine): Promise<Snapshot> {
  return read($, snapshot)
}
export async function setSnapshot($: Engine, value: Snapshot): Promise<void> {
  await update($, snapshot, () => value)
}

export async function getRejecting($: Engine): Promise<string | null> {
  return read($, rejecting)
}
export async function setRejecting($: Engine, value: string | null): Promise<void> {
  await update($, rejecting, () => value)
}

export async function getBusy($: Engine): Promise<string | null> {
  return read($, busy)
}
export async function setBusy($: Engine, value: string | null): Promise<void> {
  await update($, busy, () => value)
}

export async function getNotice($: Engine): Promise<string | null> {
  return read($, notice)
}
export async function setNotice($: Engine, value: string | null): Promise<void> {
  await update($, notice, () => value)
}

export async function getExpanded($: Engine): Promise<string[]> {
  return read($, expanded)
}
export async function toggleExpanded($: Engine, goalId: string): Promise<void> {
  await update($, expanded, (ids) => (ids.includes(goalId) ? ids.filter((id) => id !== goalId) : [...ids, goalId]))
}

export async function getConfirm($: Engine): Promise<Confirm | null> {
  return read($, confirm)
}
export async function setConfirm($: Engine, value: Confirm | null): Promise<void> {
  await update($, confirm, () => value)
}

export async function getActiveRun($: Engine): Promise<ActiveRun | null> {
  return read($, activeRun)
}
export async function setActiveRun($: Engine, value: ActiveRun | null): Promise<void> {
  await update($, activeRun, () => value)
}

export async function getGuardMissing($: Engine): Promise<boolean> {
  return read($, guardMissing)
}
/** Writes only on a change, so the pane redraws only when the guard comes or goes. */
export async function getPlanMode($: Engine): Promise<boolean> {
  return read($, planMode)
}

export async function setPlanMode($: Engine, value: boolean): Promise<void> {
  if ((await read($, planMode)) !== value) await update($, planMode, () => value)
}

export async function setGuardMissing($: Engine, value: boolean): Promise<void> {
  if ((await read($, guardMissing)) !== value) await update($, guardMissing, () => value)
}

export async function getRuns($: Engine): Promise<Record<string, RunEntry>> {
  return read($, runs)
}
export async function addRun($: Engine, agentId: string, entry: RunEntry): Promise<void> {
  await update($, runs, (all) => ({ ...all, [agentId]: entry }))
}
export async function removeRun($: Engine, agentId: string): Promise<void> {
  await update($, runs, (all) => {
    const { [agentId]: _gone, ...rest } = all
    return rest
  })
}

export async function getTodos($: Engine): Promise<Todos | null> {
  return read($, todos)
}
export async function setTodos($: Engine, value: Todos | null): Promise<void> {
  await update($, todos, () => value)
}

export async function getAddingTo($: Engine): Promise<string | null> {
  return read($, addingTo)
}
export async function setAddingTo($: Engine, value: string | null): Promise<void> {
  await update($, addingTo, () => value)
}

export async function getAskingAbout($: Engine): Promise<string | null> {
  return read($, askingAbout)
}
export async function setAskingAbout($: Engine, value: string | null): Promise<void> {
  await update($, askingAbout, () => value)
}

export async function getDiscussing($: Engine): Promise<string | null> {
  return read($, discussing)
}
export async function setDiscussing($: Engine, value: string | null): Promise<void> {
  await update($, discussing, () => value)
}

export async function getEditingTodo($: Engine): Promise<string | null> {
  return read($, editingTodo)
}
export async function setEditingTodo($: Engine, value: string | null): Promise<void> {
  await update($, editingTodo, () => value)
}
