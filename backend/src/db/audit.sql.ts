import { USER_ROLES } from '@esrs/shared';
import type { PoolClient } from 'pg';
import {
  auditEntryForStorage,
  resolveAuditWrite,
  type AuditEntry,
  type AuditWrite,
  type WrittenRow,
} from '../ports/audit.js';

/**
 * The one SQL statement that writes `audit_logs`, shared by both audit paths: `PostgresAuditSink`
 * (best-effort, outside any business transaction) and the repository writes that stamp their audit
 * rows on the transaction's own client. One statement means the two paths cannot drift apart into
 * recording different things.
 *
 * Every value is a bound parameter, and `created_at` falls back to the database clock when the entry
 * carries no timestamp, so a row always has one.
 */
export const INSERT_AUDIT_SQL = `INSERT INTO audit_logs
  (actor_id, actor_role, action, entity_type, entity_id, before, after, http_request_id, request_id, created_at)
 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, COALESCE($10::timestamptz, now()))`;

/** `BIGINT` columns take decimal ids; anything else (a test JWT subject, `'anonymous'`) is NULL. */
const NUMERIC_ID = /^\d{1,19}$/;

/**
 * `audit_logs.actor_role` is the `user_role` enum, and a value the enum cannot hold would raise
 * `22P02` — written on a business connection, that would abort the very operation being audited.
 * A role outside the enum is therefore recorded as NULL: the actor id, action and payloads survive.
 */
function roleSnapshot(role: string | undefined): string | null {
  return role && (USER_ROLES as readonly string[]).includes(role) ? role : null;
}

/** The bound parameters for one entry, after the redaction policy has been applied. */
export function auditParams(entry: AuditEntry): readonly unknown[] {
  const stored = auditEntryForStorage(entry);
  return [
    NUMERIC_ID.test(stored.actorId) ? stored.actorId : null,
    roleSnapshot(stored.actorRole),
    stored.action,
    stored.entityType,
    stored.entityId,
    stored.before === undefined ? null : JSON.stringify(stored.before),
    stored.after === undefined ? null : JSON.stringify(stored.after),
    stored.requestId ?? null,
    stored.serviceRequestId && NUMERIC_ID.test(stored.serviceRequestId)
      ? stored.serviceRequestId
      : null,
    stored.at ?? null,
  ];
}

/**
 * Inserts one audit row on `client`. Called from inside a repository transaction, so a failure here
 * propagates and rolls the business write back with it — the deliberate trade-off described in
 * `src/ports/audit.ts`.
 */
export async function insertAudit(client: PoolClient, entry: AuditEntry): Promise<void> {
  await client.query(INSERT_AUDIT_SQL, auditParams(entry) as unknown[]);
}

/** Stamps a write's audit rows inside the transaction that performed the write. */
export async function insertAuditWrites(
  client: PoolClient,
  writes: readonly AuditWrite[],
  row: WrittenRow,
): Promise<void> {
  for (const write of writes) {
    await insertAudit(client, resolveAuditWrite(write, row));
  }
}
