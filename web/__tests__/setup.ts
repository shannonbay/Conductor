import { beforeEach } from 'vitest'
import { clearAllData, resetDb } from '@/lib/db.js'

beforeEach(() => {
  // Each test gets a fresh in-memory database
  resetDb()
  clearAllData()
})
