import type { DatabaseHealth, Liveness, SystemStatus } from '@esrs/shared';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db/pool.js';
import type { Clock } from '../../domain/ports/clock.js';

/**
 * Liveness vs readiness separation (docs/system-architecture.md §8):
 * `/live` answers "is this process serving traffic" and must never depend on Postgres,
 * `/ready` answers "can this instance do useful work" and reports the database state.
 */
export interface HealthDependencies {
  readonly config: AppConfig;
  readonly database: Database;
  readonly clock: Clock;
  readonly version: string;
}

export interface ReadinessReport {
  readonly status: SystemStatus;
  /** HTTP status the caller should return: 503 when a required dependency is down. */
  readonly httpStatus: 200 | 503;
}

export function liveness(deps: HealthDependencies): Liveness {
  return {
    status: 'ok',
    service: deps.config.serviceName,
    version: deps.version,
    environment: deps.config.environment,
    timestamp: deps.clock.now().toISOString(),
  };
}

export async function readiness(deps: HealthDependencies): Promise<ReadinessReport> {
  const database: DatabaseHealth = await deps.database.ping();
  const databaseUp = database.state === 'up';

  const status: SystemStatus = {
    status: databaseUp ? 'ok' : 'degraded',
    service: deps.config.serviceName,
    version: deps.version,
    environment: deps.config.environment,
    uptime_seconds: Math.round(process.uptime()),
    timestamp: deps.clock.now().toISOString(),
    database,
  };

  return {
    status,
    // `not_configured` still answers 200: the API intentionally serves contract endpoints
    // (GET /meta) without a database, so it may stay in the load balancer (docs/system-architecture.md §8).
    httpStatus: database.state === 'down' ? 503 : 200,
  };
}
