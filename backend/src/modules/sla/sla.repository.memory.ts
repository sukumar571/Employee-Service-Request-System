import {
  DEFAULT_BUSINESS_HOURS,
  DEFAULT_SLA_POLICIES,
  REQUEST_PRIORITIES,
  type RequestPriority,
} from '@esrs/shared';
import type { Clock } from '../../domain/ports/clock.js';
import { resolveAuditWrite, type AuditSink, type AuditWrite } from '../../ports/audit.js';
import type { PolicyPatch, SlaPolicyRecord, SlaPolicyRepository } from './sla.repository.js';

/**
 * In-memory adapter used when `DATABASE_URL` is absent and by unit tests.
 * Seeded from `DEFAULT_SLA_POLICIES` in `@esrs/shared`, which the database seed also uses, so the
 * two can never disagree about the MVP targets (docs/requirements.md §8).
 *
 * The optional `audit` sink is how this adapter honours the port's transactional-audit contract: the
 * rows the caller describes are resolved through the same `resolveAuditWrite()` helper the Postgres
 * adapter uses. Memory mode has no transaction, so it has no rollback to lose — that guarantee is only
 * ever proven against the SQL adapter.
 */
export class InMemorySlaPolicyRepository implements SlaPolicyRepository {
  private readonly rows = new Map<RequestPriority, SlaPolicyRecord>();

  constructor(
    private readonly clock: Clock,
    seed: readonly SlaPolicyRecord[] = defaultRecords(),
    private readonly audit?: AuditSink,
  ) {
    for (const record of seed) this.rows.set(record.priority, record);
  }

  // The port is async (the Postgres adapter awaits), but this adapter has nothing to wait for,
  // so it returns settled promises instead of declaring empty `async` bodies.
  list(): Promise<SlaPolicyRecord[]> {
    return Promise.resolve([...this.rows.values()]);
  }

  find(priority: RequestPriority): Promise<SlaPolicyRecord | undefined> {
    return Promise.resolve(this.rows.get(priority));
  }

  save(
    priority: RequestPriority,
    patch: PolicyPatch,
    audit: readonly AuditWrite[] = [],
  ): Promise<SlaPolicyRecord> {
    const existing = this.rows.get(priority);
    if (!existing) {
      return Promise.reject(new Error(`Unknown SLA policy '${priority}'`));
    }
    const updated: SlaPolicyRecord = {
      ...existing,
      first_response_minutes: patch.first_response_minutes,
      resolution_minutes: patch.resolution_minutes,
      ...(patch.business_hours ? { business_hours: patch.business_hours } : {}),
      updated_at: this.clock.now().toISOString(),
      updated_by: patch.updated_by,
    };
    this.rows.set(priority, updated);
    for (const write of audit) {
      void this.audit?.record(
        resolveAuditWrite(write, { entityId: priority, at: updated.updated_at ?? '' }),
      );
    }
    return Promise.resolve(updated);
  }
}

export function defaultRecords(): SlaPolicyRecord[] {
  return REQUEST_PRIORITIES.map((priority) => {
    const targets = DEFAULT_SLA_POLICIES[priority];
    return {
      priority,
      first_response_minutes: targets.first_response_minutes,
      resolution_minutes: targets.resolution_minutes,
      business_hours: DEFAULT_BUSINESS_HOURS,
    };
  });
}
