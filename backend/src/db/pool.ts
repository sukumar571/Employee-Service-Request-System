import type { DatabaseHealth } from '@esrs/shared';
import pg from 'pg';
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import type { DatabaseConfig } from '../config/env.js';
import { AppError } from '../lib/errors/appError.js';

const { Pool: PgPool } = pg;

/**
 * Postgres access port (docs/system-architecture.md §4). Repositories receive this interface, so
 * domain/service tests can run without a database and the app boots happily when DATABASE_URL is
 * unset (useful for frontend work and CI).
 */
export interface Database {
  readonly configured: boolean;
  query<T extends QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  transaction<R>(work: (client: pg.PoolClient) => Promise<R>): Promise<R>;
  ping(): Promise<DatabaseHealth>;
  close(): Promise<void>;
}

export function createDatabase(
  config?: DatabaseConfig,
  opts: { onError?: (error: Error) => void } = {},
): Database {
  if (!config) {
    return new UnconfiguredDatabase();
  }

  let pool: Pool | undefined;
  const getPool = (): Pool => {
    pool ??= new PgPool({
      connectionString: config.url,
      max: config.poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: config.statementTimeoutMs,
      query_timeout: config.statementTimeoutMs,
    });
    pool.on('error', (error) => opts.onError?.(error));
    return pool;
  };

  return {
    configured: true,

    async query<T extends QueryResultRow>(sql: string, params: readonly unknown[] = []) {
      // Parameters only — never interpolate values into SQL (docs/security-plan.md §5).
      return getPool().query<T>(sql, params as unknown[]);
    },

    async transaction<R>(work: (client: pg.PoolClient) => Promise<R>) {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async ping(): Promise<DatabaseHealth> {
      const startedAt = performance.now();
      try {
        await getPool().query('SELECT 1');
        return { state: 'up', latency_ms: Math.round(performance.now() - startedAt) };
      } catch {
        return { state: 'down', latency_ms: Math.round(performance.now() - startedAt) };
      }
    },

    async close() {
      await pool?.end();
      pool = undefined;
    },
  };
}

/** Returned when DATABASE_URL is not set: reads report `not_configured`, writes fail loudly. */
class UnconfiguredDatabase implements Database {
  readonly configured = false;

  // Not `async`: there is nothing to await here, and returning the settled promise keeps the
  // port contract (`@typescript-eslint/require-await`) honest.
  query<T extends QueryResultRow>(): Promise<QueryResult<T>> {
    return Promise.reject(this.unavailable());
  }

  transaction<R>(): Promise<R> {
    return Promise.reject(this.unavailable());
  }

  ping(): Promise<DatabaseHealth> {
    return Promise.resolve({ state: 'not_configured' });
  }

  close(): Promise<void> {
    // Nothing to release.
    return Promise.resolve();
  }

  private unavailable(): AppError {
    return new AppError(
      'SERVICE_UNAVAILABLE',
      'DATABASE_URL is not configured; start Postgres with `npm run db:up` and set the variable',
    );
  }
}
