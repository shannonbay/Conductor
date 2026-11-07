import { beforeEach } from 'vitest'
import { clearAllData } from '../db.js'
import { setOpenPlan, setOpenRun } from '../session.js'

beforeEach(() => {
  clearAllData()
  setOpenPlan(null)
  setOpenRun(null)
})
