import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    env: { CONDUCTOR_DB: ':memory:' },
    setupFiles: ['./src/tests/setup.ts'],
  },
})
