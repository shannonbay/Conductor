import { beforeEach } from 'vitest'
import { clearAllData } from '../db.js'
import { setOpenPlan } from '../session.js'

beforeEach(() => {
  clearAllData()
  setOpenPlan(null)
})
