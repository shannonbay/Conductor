import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/ws-broadcaster', () => ({
  broadcast: vi.fn(),
  clientCount: vi.fn(() => 1),
}))

import { broadcast, clientCount } from '@/lib/ws-broadcaster'
import { startWatchingPlan, pollOnce, resetPoller } from '@/lib/mcp-poller'
import { insertPlan, insertTask, updateTask, deleteTaskTree } from '@/lib/db'

const now = new Date().toISOString()

function setup() {
  insertPlan({ id: 'p1', name: 'P', description: null, status: 'active', working_dir: '/tmp', created_at: now, updated_at: now })
  insertTask({ id: '1', plan_id: 'p1', goal: 'root', status: 'pending', result: null, abandon_reason: null, state: {}, depends_on: null, created_at: now, updated_at: now })
  startWatchingPlan('p1')
}

describe('mcp-poller', () => {
  beforeEach(() => {
    resetPoller()
    vi.mocked(broadcast).mockClear()
    vi.mocked(clientCount).mockReturnValue(1)
  })

  it('does not broadcast when nothing changed', () => {
    setup()
    pollOnce()
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('broadcasts once per change, not repeatedly', () => {
    setup()
    updateTask('p1', '1', { status: 'active' })
    pollOnce()
    pollOnce()
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith('p1', { type: 'mcp_update' })
  })

  it('detects deleted tasks', () => {
    setup()
    deleteTaskTree('p1', '1')
    pollOnce()
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('does not broadcast when no browser is connected, and does not replay later', () => {
    setup()
    vi.mocked(clientCount).mockReturnValue(0)
    updateTask('p1', '1', { status: 'active' })
    pollOnce()
    vi.mocked(clientCount).mockReturnValue(1)
    pollOnce()
    expect(broadcast).not.toHaveBeenCalled()
  })
})
