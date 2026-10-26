import { defineConfig } from 'vitest/config';

/**
 * Database checks run without a PostgreSQL instance: they compare the SQL text against the
 * contract in `@esrs/shared` (docs/test-plan.md §4, contract test C-02). Applying the migrations
 * themselves is an integration step (`npm run db:migrate`) and is evidenced in `evidence/`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
