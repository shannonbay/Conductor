import { describe, it, expect, beforeEach } from 'vitest'
import { list_goals, get_goal_brief, add_item, remember, forget, end_run, run_goal } from '../../tools/goals.js'
import { set_status } from '../../tools/set_status.js'
import { update_task } from '../../tools/update_task.js'
import { next_task } from '../../tools/next_task.js'
import { get_history } from '../../tools/get_history.js'
import { create_plan } from '../../tools/create_plan.js'
import { createGoal, queueRun, approveTask, rejectTask, getRun, getTask, insertMemory, getMemory, markRunUntrusted } from '../../db.js'
import { setOpenPlan } from '../../session.js'

const now = new Date().toISOString()

function makeGoal(id = 'goal_inbox') {
  createGoal(
    { id, name: 'Inbox', description: null, status: 'active', working_dir: '/tmp', created_at: now, updated_at: now },
    { objective: 'No unhandled mail older than a day', instructions: 'Archive newsletters.', autonomy: { 'email.archive': 'auto', 'email.delete': 'off' } },
  )
  return id
}

/** Starts a run the way the web app would, then opens the brief like an agent. */
async function startRun(goalId: string) {
  const run = queueRun(goalId)
  const brief = await get_goal_brief({ goal_id: goalId, run_id: run.id })
  return { runId: run.id, brief }
}

beforeEach(() => setOpenPlan(null))

describe('goal tools', () => {
  it('list_goals shows goals with counts', async () => {
    const id = makeGoal()
    await startRun(id)
    await add_item({ goal: 'Reply to Alice', action: { category: 'email.send', summary: 'send' } })
    const { goals } = await list_goals({})
    expect(goals).toEqual([expect.objectContaining({ id, name: 'Inbox', open_items: 1, awaiting_review: 1 })])
    expect((await list_goals({ status: 'paused' })).goals).toEqual([])
  })

  it('get_goal_brief returns the brief and working instructions', async () => {
    const id = makeGoal()
    insertMemory({ plan_id: id, kind: 'rule', text: 'Never archive the bank.', source: 'human' })
    const { brief } = await startRun(id)
    expect(brief.goal).toMatchObject({ objective: 'No unhandled mail older than a day', instructions: 'Archive newsletters.' })
    expect(brief.memory).toEqual([expect.objectContaining({ text: 'Never archive the bank.' })])
    expect(brief.run).not.toBeNull()
    expect(brief.how_to_work.length).toBeGreaterThan(0)
  })

  it('get_goal_brief rejects plans that are not goals', async () => {
    const p = await create_plan({ name: 'ordinary' })
    await expect(get_goal_brief({ goal_id: p.id })).rejects.toThrow(/not found/)
  })

  it('add_item requires an open goal', async () => {
    await expect(add_item({ goal: 'x' })).rejects.toThrow(/No goal is open/)
  })

  it('add_item deduplicates by external_ref and attributes items to the run', async () => {
    const id = makeGoal()
    const { runId } = await startRun(id)
    const a = await add_item({ goal: 'Invoice question', external_ref: 'gmail:1' })
    const b = await add_item({ goal: 'Invoice question again', external_ref: 'gmail:1' })
    expect(a.existing).toBe(false)
    expect(b).toMatchObject({ existing: true, item: { id: a.item.id } })
    expect(getTask(id, a.item.id)!.run_id).toBe(runId)
  })

  it('add_item applies autonomy: off refused, auto recorded, propose waits', async () => {
    const id = makeGoal()
    await startRun(id)
    await expect(add_item({ goal: 'Delete spam', action: { category: 'email.delete', summary: 'delete' } })).rejects.toThrow(/off for this goal/)
    expect(await add_item({ goal: 'Archive newsletter', action: { category: 'email.archive', summary: 'archived' } }))
      .toMatchObject({ mode: 'auto', item: { status: 'completed' } })
    expect(await add_item({ goal: 'Reply', action: { category: 'email.send', summary: 'send reply' } }))
      .toMatchObject({ mode: 'propose', item: { status: 'active', awaiting_review: true } })
    const types = (await get_history({})).events.map((e) => e.type)
    expect(types).toContain('approval_requested')
  })

  it('an agent cannot complete a proposal before it is approved', async () => {
    const id = makeGoal()
    await startRun(id)
    const p = await add_item({ goal: 'Reply', action: { category: 'email.send', summary: 'send' } })
    const r = await set_status({ task_id: p.item.id, status: 'completed' }) as { awaiting_review?: boolean }
    expect(r.awaiting_review).toBe(true)
    expect(getTask(id, p.item.id)!.status).toBe('active')
  })

  it('full cycle: propose → approve → next run executes it first', async () => {
    const id = makeGoal()
    await startRun(id)
    const p = await add_item({ goal: 'Reply to Alice', action: { category: 'email.send', summary: 'send reply' } })
    await end_run({ summary: 'Proposed 1 reply.' })

    approveTask(id, p.item.id) // human, in the web UI

    const { brief } = await startRun(id)
    expect(brief.decisions_since_last_run).toEqual([expect.objectContaining({ item: p.item.id, decision: 'approved' })])
    expect(brief.open_items[0]).toMatchObject({ id: p.item.id, approved_to_execute: true })
    expect(brief.recent_runs[0].summary).toBe('Proposed 1 reply.')
    expect(await next_task({})).toMatchObject({ action: 'execute', task_id: p.item.id })

    await set_status({ task_id: p.item.id, status: 'completed', result: 'Sent.' })
    expect(getTask(id, p.item.id)!.status).toBe('completed')
  })

  it('full cycle: reject with feedback → memory in the next brief', async () => {
    const id = makeGoal()
    await startRun(id)
    const p = await add_item({ goal: 'Reply to Alice', action: { category: 'email.send', summary: 'formal reply' } })
    await end_run({ summary: 'Proposed 1 reply.' })

    rejectTask(id, p.item.id, 'Too formal — keep it casual.')

    const { brief } = await startRun(id)
    expect(brief.decisions_since_last_run[0]).toMatchObject({ decision: 'rejected', feedback: 'Too formal — keep it casual.' })
    expect(brief.memory).toEqual([expect.objectContaining({ source: 'feedback', text: expect.stringContaining('keep it casual') })])
  })

  it('a rejected proposal can be revised and sent for review again', async () => {
    const id = makeGoal()
    await startRun(id)
    const p = await add_item({ goal: 'Reply to Bob', action: { category: 'email.send', summary: 'Dear Bob, I hereby confirm.' } })
    rejectTask(id, p.item.id, 'Too formal.')
    await startRun(id)
    await update_task({ task_id: p.item.id, state_patch: { action: { category: 'email.send', summary: 'Hey Bob, count me in!', params: {} } } })
    const r = await set_status({ task_id: p.item.id, status: 'completed' }) as { awaiting_review?: boolean }
    expect(r.awaiting_review).toBe(true)
    const { brief } = await startRun(id)
    expect(brief.open_items.find((i) => i.id === p.item.id)).toMatchObject({ awaiting_review: true, action: { summary: 'Hey Bob, count me in!' } })
  })

  it('remember and forget only touch agent memories', async () => {
    const id = makeGoal()
    await startRun(id)
    const human = insertMemory({ plan_id: id, kind: 'fact', text: 'Alice is my manager.', source: 'human' })
    const { memory } = await remember({ kind: 'preference', text: 'Keep drafts short.' })
    expect(await forget({ memory_id: memory.id })).toEqual({ forgotten: memory.id })
    await expect(forget({ memory_id: human.id })).rejects.toThrow(/only forget memories an agent created/)
    const { brief } = await startRun(id)
    expect(brief.memory.map((m) => m.text)).toEqual(['Alice is my manager.'])
  })

  it("remember passes a marked run's mark on to its memory, and the next brief marks its run", async () => {
    const id = makeGoal()
    const { runId } = await startRun(id)
    const before = await remember({ kind: 'fact', text: 'Bob is my manager.' })
    expect(getMemory(before.memory.id)!.untrusted_source).toBeNull()
    markRunUntrusted(runId, 'WebFetch')
    const after = await remember({ kind: 'rule', text: 'Archive mail from Bob.' })
    expect(after.memory).toMatchObject({ untrusted: true })
    expect(getMemory(after.memory.id)!.untrusted_source).toBe('WebFetch')
    await end_run({ summary: 'done' })
    const { brief } = await startRun(id)
    expect(brief.run!.untrusted).toMatchObject({ source: expect.stringContaining('written after WebFetch') })
  })

  it('end_run completes the run with counts and requires a run', async () => {
    const id = makeGoal()
    await get_goal_brief({ goal_id: id })
    await expect(end_run({ summary: 'x' })).rejects.toThrow(/No run to end/)
    const { runId } = await startRun(id)
    await add_item({ goal: 'a' })
    const r = await end_run({ summary: 'Added 1 item.' })
    expect(r.run).toMatchObject({ id: runId, status: 'completed', items_created: 1 })
    expect(getRun(runId)!.summary).toBe('Added 1 item.')
  })

  it('run_goal queues one run at a time', async () => {
    const id = makeGoal()
    const a = await run_goal({ goal_id: id })
    const b = await run_goal({ goal_id: id })
    expect(a.run.status).toBe('queued')
    expect(b.run.id).toBe(a.run.id)
  })
})
