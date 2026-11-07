import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'url'

export default defineConfig({
  test: {
    environment: 'node',
    env: { CONDUCTOR_DB: ':memory:' },
    setupFiles: ['./src/tests/setup.ts'],
  },
  resolve: {
    // Test against core's source so tests never run on a stale core/dist build
    alias: { '@conductor/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
  },
})
