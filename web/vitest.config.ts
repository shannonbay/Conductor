import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    env: { CONDUCTOR_DB: ':memory:' },
    setupFiles: ['./__tests__/setup.ts'],
    globals: true,
    include: ['./__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', '.next'],
    server: {
      deps: {
        // Force @testing-library/react and its React deps through Vite so aliases apply
        inline: ['@testing-library/react', '@testing-library/dom', '@testing-library/jest-dom'],
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      // Ensure tests use the same React version as the app (React 19 in web/node_modules)
      'react': path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
      'react-dom/client': path.resolve(__dirname, 'node_modules/react-dom/client'),
    },
  },
})
