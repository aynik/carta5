import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Codec tests - run in Node.js environment
    include: ['tests/**/*.test.js'],
    environment: 'node',
    globals: true,
    coverage: {
      include: ['codec/**/*.js'],
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: 'coverage',
    },
  },
})
