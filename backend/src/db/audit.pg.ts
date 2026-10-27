import type { AuditEntry, AuditSink } from '../ports/audit.js';
import type { Logger } from '../lib/logger.js';
import { auditParams, INSERT_AUDIT_SQL } from './audit.sql.js';
import type { Database } from './pool.js';

/**
 * Postgres adapter for the *best-effort* audit path: security events that have no business
 * transaction of their own (login, refresh, role provisioning). Failures are logged, never rethrown:
 * an audit outage must not turn a completed action into a 500. The error is loud in logs so ops can
 * backfill.
 *
 * Request and SLA-policy writes do NOT come through here — they stamp their `audit_logs` rows on
 * their own transaction client (see `db/audit.sql.js` and `src/ports/audit.ts`), which is what makes
 * that half of the trail atomic with the change it describes.
 */
export class PostgresAuditSink implements AuditSink {
  constructor(
    private readonly database: Database,
    private readonly logger: Logger,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.database.query(INSERT_AUDIT_SQL, auditParams(entry));
    } catch (error) {
      this.logger.error(
        { err: error, action: entry.action, entity: `${entry.entityType}:${entry.entityId}` },
        'audit log write failed',
      );
    }
  }
}
