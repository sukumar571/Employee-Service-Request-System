import { businessHoursSchema, requestPrioritySchema, type RequestPriority } from '@esrs/shared';
import type { PoolClient } from 'pg';
import { insertAuditWrites } from '../../db/audit.sql.js';
import { AppError } from '../../lib/errors/appError.js';
import type { Database } from '../../db/pool.js';
import type { AuditWrite } from '../../ports/audit.js';
import type { PolicyPatch, SlaPolicyRecord, SlaPolicyRepository } from './sla.repository.js';

/**
 * Postgres adapter for `sla_policies` (docs/database-design.md §2.8).
 * Column names follow the schema (`*_mins`); the wire contract uses `*_minutes`, and the mapping
 * happens here so no other layer sees the difference.
 *
 * A policy edit is the one administrative write outside the request aggregate that carries its own
 * audit row: the `SELECT … FOR UPDATE`, the upsert and the `audit_logs` insert share one
 * transaction, so a manager cannot change a target without the trail recording it, and a trail row
 * cannot be written against a policy that never changed.
 */
interface SlaPolicyRow {
  readonly priority: string;
  readonly first_response_mins: number;
  readonly resolution_mins: number;
  readonly business_hours: unknown;
  readonly updated_by: string | null;
  readonly updated_at: Date | null;
}

const COLUMNS = `priority, first_response_mins, resolution_mins, business_hours, updated_by, updated_at`;

export class PostgresSlaPolicyRepository implements SlaPolicyRepository {
  constructor(private readonly database: Database) {}

  async list(): Promise<SlaPolicyRecord[]> {
    const result = await this.database.query<SlaPolicyRow>(
      `SELECT ${COLUMNS} FROM sla_policies ORDER BY resolution_mins ASC`,
    );
    return result.rows.map(toRecord);
  }

  async find(priority: RequestPriority): Promise<SlaPolicyRecord | undefined> {
    const result = await this.database.query<SlaPolicyRow>(
      `SELECT ${COLUMNS} FROM sla_policies WHERE priority = $1`,
      [priority],
    );
    const row = result.rows[0];
    return row ? toRecord(row) : undefined;
  }

  async save(
    priority: RequestPriority,
    patch: PolicyPatch,
    audit: readonly AuditWrite[] = [],
  ): Promise<SlaPolicyRecord> {
    return this.database.transaction(async (client) => {
      const current = await selectPolicy(client, priority, true);
      const businessHours = patch.business_hours ?? current.business_hours;
      const actorId = asUserId(patch.updated_by);

      const result = await client.query<SlaPolicyRow>(
        `INSERT INTO sla_policies (priority, first_response_mins, resolution_mins, business_hours, updated_by, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, now())
         ON CONFLICT (priority) DO UPDATE
           SET first_response_mins = EXCLUDED.first_response_mins,
               resolution_mins     = EXCLUDED.resolution_mins,
               business_hours      = EXCLUDED.business_hours,
               updated_by          = EXCLUDED.updated_by,
               updated_at          = now()
         RETURNING ${COLUMNS}`,
        [
          priority, // the primary key is the enum value, so the upsert cannot retype it
          patch.first_response_minutes,
          patch.resolution_minutes,
          JSON.stringify(businessHours),
          actorId,
        ],
      );

      const row = result.rows[0];
      if (!row) throw new AppError('INTERNAL', 'SLA policy upsert returned no row');
      const updated = toRecord(row);

      // `entityId` is the priority, matching the natural key the API addresses the policy by
      // (`PUT /sla/policies/{priority}`); the row has no surrogate id to point at.
      await insertAuditWrites(client, audit, {
        entityId: priority,
        at: updated.updated_at ?? new Date().toISOString(),
      });
      return updated;
    });
  }
}

/** Reads one policy, optionally locking it for the duration of the caller's transaction. */
async function selectPolicy(
  client: PoolClient,
  priority: RequestPriority,
  forUpdate: boolean,
): Promise<SlaPolicyRecord> {
  const result = await client.query<SlaPolicyRow>(
    `SELECT ${COLUMNS} FROM sla_policies WHERE priority = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [priority],
  );
  const row = result.rows[0];
  if (!row) throw new AppError('NOT_FOUND', `SLA policy for priority '${priority}'`);
  return toRecord(row);
}

function toRecord(row: SlaPolicyRow): SlaPolicyRecord {
  const priority = requestPrioritySchema.safeParse(row.priority);
  const hours = businessHoursSchema.safeParse(row.business_hours);
  if (!priority.success || !hours.success) {
    // A malformed stored row is a server-side data defect, never the client's fault.
    throw new AppError('INTERNAL', 'Stored SLA policy is malformed', { cause: row.priority });
  }
  return {
    priority: priority.data,
    first_response_minutes: row.first_response_mins,
    resolution_minutes: row.resolution_mins,
    business_hours: hours.data,
    updated_by: row.updated_by ?? undefined,
    updated_at: row.updated_at ? row.updated_at.toISOString() : undefined,
  };
}

/** JWT subjects are decimal user ids; anything else is recorded as "unknown" instead of failing. */
function asUserId(value: string): number | null {
  return /^\d{1,18}$/.test(value) ? Number(value) : null;
}
