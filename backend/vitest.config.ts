import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The HTTP integration suites boot a full Express app per file (JWT signing, bcrypt, the SLA
    // clock, the audit port) and the worker pool runs them side by side. Vitest's 5 s default is
    // measured against a cold, contended machine — the first write-heavy test in each of those files
    // was recorded at just over 5 s when the box was busy, so a real pass failed on the clock rather
    // than on an assertion. 15 s is still far below a hang and keeps genuine timeouts visible.
    testTimeout: 15_000,
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
