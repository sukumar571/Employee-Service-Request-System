import { businessHoursSchema, requestPrioritySchema, type RequestPriority } from '@esrs/shared';
import { AppError } from '../../lib/errors/appError.js';
import type { Database } from '../../db/pool.js';
import type { PolicyPatch, SlaPolicyRecord, SlaPolicyRepository } from './sla.repository.js';

/**
 * Postgres adapter for `sla_policies` (docs/database-design.md §2.8).
 * Column names follow the schema (`*_mins`); the wire contract uses `*_minutes`, and the mapping
 * happens here so no other layer sees the difference.
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

  async save(priority: RequestPriority, patch: PolicyPatch): Promise<SlaPolicyRecord> {
    const current = await this.find(priority);
    if (!current) {
      throw new AppError('NOT_FOUND', `SLA policy for priority '${priority}'`);
    }
    const businessHours = patch.business_hours ?? current.business_hours;
    const actorId = asUserId(patch.updated_by);

    const result = await this.database.query<SlaPolicyRow>(
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
        priority,
        patch.first_response_minutes,
        patch.resolution_minutes,
        JSON.stringify(businessHours),
        actorId,
      ],
    );

    const row = result.rows[0];
    if (!row) throw new AppError('INTERNAL', 'SLA policy upsert returned no row');
    return toRecord(row);
  }
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
