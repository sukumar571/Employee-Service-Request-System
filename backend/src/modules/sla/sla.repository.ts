import type { BusinessHours, RequestPriority } from '@esrs/shared';
import type { AuditWrite } from '../../ports/audit.js';

/**
 * Persistence port for SLA policies (docs/database-design.md §2.8, `sla_policies`).
 * Services depend on this interface only — the Postgres adapter is used when `DATABASE_URL` is set,
 * the in-memory adapter keeps the API and the test suite runnable without a database.
 */
export interface SlaPolicyRecord {
  readonly priority: RequestPriority;
  readonly first_response_minutes: number;
  readonly resolution_minutes: number;
  readonly business_hours: BusinessHours;
  readonly updated_at?: string;
  readonly updated_by?: string;
}

export interface SlaPolicyRepository {
  list(): Promise<SlaPolicyRecord[]>;
  find(priority: RequestPriority): Promise<SlaPolicyRecord | undefined>;
  /**
   * Manager+ edit (ST-403): applies to NEW requests only — outstanding trackers keep their snapshot.
   * The policy's audit rows are passed in rather than recorded by the caller, so the Postgres adapter
   * can insert them on the same client as the `UPDATE`: a policy change and its trail row commit
   * together, and a rejected change leaves no row behind.
   */
  save(
    priority: RequestPriority,
    patch: PolicyPatch,
    audit?: readonly AuditWrite[],
  ): Promise<SlaPolicyRecord>;
}

export interface PolicyPatch {
  readonly first_response_minutes: number;
  readonly resolution_minutes: number;
  readonly business_hours?: BusinessHours;
  readonly updated_by: string;
}
