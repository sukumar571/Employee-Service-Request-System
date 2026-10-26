import type { AuditEntry, AuditSink } from '../ports/audit.js';
import type { Logger } from '../lib/logger.js';
import type { Database } from './pool.js';

/**
 * Postgres adapter for the audit trail.
 * Failures are logged, never rethrown: an audit outage must not turn a valid admin action into a
 * 500 (the request already committed). The error is loud in logs so ops can backfill.
 */
export class PostgresAuditSink implements AuditSink {
  constructor(
    private readonly database: Database,
    private readonly logger: Logger,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.database.query(
        `INSERT INTO audit_logs
           (actor_id, actor_role, action, entity_type, entity_id, before, after, http_request_id, request_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
        [
          entry.actorId,
          entry.actorRole ?? null,
          entry.action,
          entry.entityType,
          entry.entityId,
          entry.before === undefined ? null : JSON.stringify(entry.before),
          entry.after === undefined ? null : JSON.stringify(entry.after),
          entry.requestId ?? null,
          entry.serviceRequestId ?? null,
        ],
      );
    } catch (error) {
      this.logger.error(
        { err: error, action: entry.action, entity: `${entry.entityType}:${entry.entityId}` },
        'audit log write failed',
      );
    }
  }
}
