import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getMemory, updateMemory, deleteMemory } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

type Params = { params: Promise<{ id: string; memoryId: string }> }

const PatchSchema = z.object({
  kind: z.enum(['fact', 'rule', 'preference']).optional(),
  text: z.string().trim().min(1).optional(),
  pinned: z.boolean().optional(),
  active: z.boolean().optional(),
  /** true: the person trusts a memory a run wrote after reading untrusted content. */
  trusted: z.literal(true).optional(),
})

function load(id: string, memoryId: string) {
  const m = getMemory(memoryId)
  return m && m.plan_id === id ? m : undefined
}

/**
 * PATCH — humans can edit, pin or deactivate any memory, including agent-written ones.
 * Trusting it, or rewriting its text (the words are then theirs), clears its untrusted mark.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { id, memoryId } = await params
    if (!load(id, memoryId)) return notFound('Memory')
    const parsed = PatchSchema.safeParse(await req.json())
    if (!parsed.success) return err(parsed.error.issues[0].message)
    const { trusted, ...fields } = parsed.data
    updateMemory(memoryId, { ...fields, ...((trusted || fields.text !== undefined) && { untrusted_source: null }) })
    recordEvent({ planId: id, taskId: id, eventType: 'memory_updated', actor: 'human', payload: { memory_id: memoryId, changes: Object.keys(parsed.data) } })
    return ok({ memory: getMemory(memoryId) })
  } catch (e) {
    return serverError(e)
  }
}

/** DELETE — remove a memory entirely. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const { id, memoryId } = await params
    const m = load(id, memoryId)
    if (!m) return notFound('Memory')
    deleteMemory(memoryId)
    recordEvent({ planId: id, taskId: id, eventType: 'memory_deleted', actor: 'human', payload: { memory_id: memoryId, text: m.text } })
    return ok({ deleted: memoryId })
  } catch (e) {
    return serverError(e)
  }
}
