import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Integration tests in this scaffold need no database; when Phase 6 adds Postgres-backed
    // tests they run against the `postgres-test` container (docs/test-plan.md §10).
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts', 'src/**/index.ts'],
      // Overall gate from docs/test-plan.md. The stricter 90 % gate for `src/domain/**` is
      // enforced by the domain unit tests themselves plus the @esrs/shared package thresholds.
      thresholds: { lines: 70, branches: 70, functions: 70, statements: 70 },
    },
  },
});
