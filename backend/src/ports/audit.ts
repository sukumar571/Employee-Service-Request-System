/**
 * Audit trail port (docs/database-design.md §2.12, `audit_logs`).
 * Security-relevant and administrative changes — request writes, SLA policy edits, role changes —
 * are recorded with actor, action, before/after images and a timestamp. This file is I/O-free on
 * purpose: the Postgres adapters live in `src/db/`, so services, repositories and tests depend only
 * on the interface.
 *
 * Two write paths exist, and the difference is deliberate (docs/database-design.md §2.12):
 *
 *  - **In-transaction** (`AuditWrite`, handed to a repository write): the audit row is inserted on
 *    the same connection as the change it describes, so a failed audit insert rolls the change back
 *    and a committed change can never be missing from the trail. Used for the request aggregate and
 *    for SLA policy edits.
 *  - **Best-effort** (`AuditSink.record`): never throws, so an audit outage cannot turn a completed
 *    login into a 500. Used for security events that have no business transaction of their own.
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
  /** When the described change happened (audit_logs.created_at); the database clock fills gaps. */
  readonly at?: string;
}

/**
 * Facts the adapter knows only after the write has executed inside its transaction. `at` is the same
 * instant the activity event was stamped with, so the trail and the audit row can never disagree.
 */
export interface WrittenRow {
  readonly entityId: string;
  readonly at: string;
  /** Request rows only: the gapless number, once the write has allocated one. */
  readonly requestNumber?: string | null;
  /** Request rows only: the optimistic-concurrency version the write left behind. */
  readonly version?: number;
  /**
   * The request a non-request row belongs to. A comment is its own entity, but the audit entry has to
   * point at the ticket it was left on, so the adapter supplies the parent id here.
   */
  readonly serviceRequestId?: string;
}

/**
 * One audit row for a repository write, described by the service and stamped by the adapter.
 * A function rather than a literal because the subject id, the request number and the resulting
 * version are only known once the row exists — and because describing the change *before* writing it
 * is what lets the insert happen inside the same transaction.
 */
export type AuditWrite = (row: WrittenRow) => AuditEntry;

/**
 * Completes a described audit row with the facts only the adapter can supply: the subject id and the
 * request it belongs to default to the row that was written, and the instant defaults to the write's
 * own timestamp. Shared by both adapters so memory mode and Postgres record the same thing.
 */
export function resolveAuditWrite(write: AuditWrite, row: WrittenRow): AuditEntry {
  const entry = write(row);
  return {
    ...entry,
    entityId: entry.entityId || row.entityId,
    serviceRequestId: entry.serviceRequestId ?? row.serviceRequestId ?? row.entityId,
    at: entry.at ?? row.at,
  };
}

export interface AuditSink {
  /** Implementations must not throw: losing an audit row may never fail the user's request. */
  record(entry: AuditEntry): Promise<void>;
}

/** Used when no audit adapter is wired (in-memory development mode): keeps the trail in RAM. */
export class RecordingAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = [];

  record(entry: AuditEntry): Promise<void> {
    this.entries.push(withRedaction(entry));
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Payload hygiene
// ---------------------------------------------------------------------------

/**
 * Keys that can only ever name a secret. `isSensitiveKey` breaks a name into words on both separators
 * and camel-case boundaries, and also compares the de-segmented whole, so `password_hash`,
 * `newPassword` and `api_key` are all caught while an ordinary field such as `bypass` or `author` is
 * not. Every entry of this set must therefore be a single word.
 */
const SENSITIVE_TOKENS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'apikey',
  'accesskey',
  'privatekey',
  'session',
  'salt',
  'hash',
  'otp',
  'totp',
  'mfa',
  'jwt',
  'bearer',
  'refresh',
]);

/** Longest string kept verbatim; anything longer is stored truncated with an explicit marker. */
export const AUDIT_VALUE_MAX = 512;
/** Guard against a self-referential payload (an `Error.cause` chain) looping the reducer. */
const AUDIT_MAX_DEPTH = 6;

const REDACTED = '[redacted]';
const TRUNCATED = '…[truncated]';

/** `api_key`, `apiKey` and `ApiKey` all name the same thing: split them the same way. */
function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

function isSensitiveKey(key: string): boolean {
  const parts = words(key);
  return parts.some((part) => SENSITIVE_TOKENS.has(part)) || SENSITIVE_TOKENS.has(parts.join(''));
}

function clip(value: string): string {
  return value.length <= AUDIT_VALUE_MAX ? value : `${value.slice(0, AUDIT_VALUE_MAX)}${TRUNCATED}`;
}

/**
 * Depth-limited, cycle-safe normalisation of a payload: secrets become `'[redacted]'`, long strings
 * are clipped and non-JSON values (functions, `bigint`, `Date`) become their string form so the
 * `JSON.stringify` in the adapter cannot throw on something it cannot serialise.
 */
function sanitize(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return clip(value);
  if (depth >= AUDIT_MAX_DEPTH) return '[depth-limit]';

  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return undefined; // function, symbol, undefined — never storeable

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : sanitize(item, depth + 1);
  }
  return out;
}

/** Applies the sensitivity/truncation policy to one entry's before/after images. Idempotent. */
export function withRedaction(entry: AuditEntry): AuditEntry {
  return {
    ...entry,
    ...(entry.before === undefined ? {} : { before: sanitize(entry.before, 0) }),
    ...(entry.after === undefined ? {} : { after: sanitize(entry.after, 0) }),
  };
}

/** The single normalisation both audit write paths run through before they reach SQL. */
export function auditEntryForStorage(entry: AuditEntry): AuditEntry {
  const normalized = withRedaction(entry);
  return {
    actorId: normalized.actorId,
    actorRole: normalized.actorRole,
    action: normalized.action,
    entityType: normalized.entityType,
    entityId: normalized.entityId,
    ...(normalized.before === undefined ? {} : { before: normalized.before }),
    ...(normalized.after === undefined ? {} : { after: normalized.after }),
    ...(normalized.requestId === undefined ? {} : { requestId: normalized.requestId }),
    ...(normalized.serviceRequestId === undefined
      ? {}
      : { serviceRequestId: normalized.serviceRequestId }),
    ...(normalized.at === undefined ? {} : { at: normalized.at }),
  };
}
