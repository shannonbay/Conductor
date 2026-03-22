import { beforeEach } from 'vitest'
import { clearAllData } from '../db.js'
import { setOpenProject } from '../session.js'

beforeEach(() => {
  clearAllData()
  setOpenProject(null)
})
