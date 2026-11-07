import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getGoal, insertMemory } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

type Params = { params: Promise<{ id: string }> }

const MemorySchema = z.object({
  kind: z.enum(['fact', 'rule', 'preference']),
  text: z.string().trim().min(1, 'Text is required'),
  pinned: z.boolean().optional(),
})

/** POST — add a human-written memory. */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    if (!getGoal(id)) return notFound('Goal')
    const parsed = MemorySchema.safeParse(await req.json())
    if (!parsed.success) return err(parsed.error.issues[0].message)
    const memory = insertMemory({ plan_id: id, ...parsed.data, source: 'human' })
    recordEvent({ planId: id, taskId: id, eventType: 'memory_added', actor: 'human', payload: { memory_id: memory.id, text: memory.text } })
    return ok({ memory }, 201)
  } catch (e) {
    return serverError(e)
  }
}
