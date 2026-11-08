import { describe, it, expect } from 'vitest'
import { isListed, PLAN_TOOLS } from '../tool-filter.js'

describe('tool listing', () => {
  it('hides the plan tools by default, keeping the ones goal items use', () => {
    for (const name of PLAN_TOOLS) expect(isListed(name, {})).toBe(false)
    for (const name of ['update_task', 'set_status', 'get_goal_brief', 'add_item', 'end_run', 'todo_add']) expect(isListed(name, {})).toBe(true)
  })

  it('lists everything with CONDUCTOR_TOOLS=all', () => {
    for (const name of PLAN_TOOLS) expect(isListed(name, { CONDUCTOR_TOOLS: 'all' })).toBe(true)
  })
})
