import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'url'

export default defineConfig({
  test: {
    environment: 'node',
    env: { QUARTERDECK_DB: ':memory:' },
    setupFiles: ['./src/tests/setup.ts'],
  },
  resolve: {
    // Test against core's source so tests never run on a stale core/dist build
    alias: { '@quarterdeck/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
  },
})
