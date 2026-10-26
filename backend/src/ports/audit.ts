/**
 * Audit trail port (docs/database-design.md §2.12, `audit_logs`).
 * Security-relevant changes — SLA policy edits, role changes, taxonomy edits — are recorded with
 * before/after images. This file is I/O-free on purpose: the Postgres adapter lives in
 * `src/db/audit.pg.ts`, so services and tests depend only on the interface.
 */
export interface AuditEntry {
  readonly actorId: string;
  readonly actorRole?: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly before?: unknown;
  readonly after?: unknown;
  /** x-request-id correlation (audit_logs.http_request_id). */
  readonly requestId?: string;
  /** Service request this entry relates to, where applicable (audit_logs.request_id FK). */
  readonly serviceRequestId?: string;
}

export interface AuditSink {
  /** Implementations must not throw: losing an audit row may never fail the user's request. */
  record(entry: AuditEntry): Promise<void>;
}

/** Used when no audit adapter is wired (in-memory development mode): keeps the trail in RAM. */
export class RecordingAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = [];

  record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}
