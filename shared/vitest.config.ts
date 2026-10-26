import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      // Contract + domain rules must be near-fully covered (docs/test-plan.md coverage gates).
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
