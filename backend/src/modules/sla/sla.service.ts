import {
  REQUEST_PRIORITIES,
  SLA_WARNING_RATIO,
  type RequestPriority,
  type SlaPolicyDto,
  type SlaState,
  type SlaSummary,
  type UpdateSlaPolicyBody,
} from '@esrs/shared';
import type { Clock } from '../../domain/ports/clock.js';
import { AppError } from '../../lib/errors/appError.js';
import { notFound } from '../../lib/errors/httpErrors.js';
import {
  InvalidBusinessWindowError,
  addBusinessMinutes,
  elapsedBusinessMinutes,
  remainingBusinessMinutes,
  toWindow,
} from '../../domain/sla/businessHours.js';
import type { RbacActor } from '../../domain/rbac/policy.js';
import type { AuditWrite } from '../../ports/audit.js';
import type { SlaPolicyRecord, SlaPolicyRepository } from './sla.repository.js';

/**
 * SLA policy + calculation service (docs/requirements.md §8, FR-14…FR-17).
 * Due dates are computed in BUSINESS time; the math itself is pure and unit-tested
 * (`src/domain/sla/businessHours.test.ts`), this layer orchestrates it and owns the audit trail.
 */
export interface DueDates {
  readonly first_response_due_at: string;
  readonly resolution_due_at: string;
}

export interface TrackerTimes {
  readonly submitted_at: Date | string;
  readonly resolution_due_at: Date | string;
  readonly first_response_due_at?: Date | string | null;
}

export interface SlaServiceDependencies {
  readonly repository: SlaPolicyRepository;
  readonly clock: Clock;
}

export class SlaService {
  constructor(private readonly deps: SlaServiceDependencies) {}

  /** Deterministic wire order (the frozen `REQUEST_PRIORITIES` order) for stable clients/snapshots. */
  async listPolicies(): Promise<SlaPolicyDto[]> {
    const records = await this.deps.repository.list();
    const byPriority = new Map(records.map((record) => [record.priority, record]));
    return REQUEST_PRIORITIES.flatMap((priority) => {
      const record = byPriority.get(priority);
      return record ? [toDto(record)] : [];
    });
  }

  async getPolicy(priority: RequestPriority): Promise<SlaPolicyDto> {
    return toDto(await this.requireRecord(priority));
  }

  /**
   * ST-403: managers may retarget a priority, and the change applies to NEW requests only —
   * outstanding trackers keep their `policy_snapshot` (docs/requirements.md §16.6).
   */
  async updatePolicy(
    priority: RequestPriority,
    body: UpdateSlaPolicyBody,
    actor: RbacActor,
    requestId?: string,
  ): Promise<SlaPolicyDto> {
    const before = await this.requireRecord(priority);

    if (body.resolution_minutes <= body.first_response_minutes) {
      const message = 'Resolution target must be longer than the first-response target';
      throw new AppError('VALIDATION_ERROR', message, {
        details: [{ path: 'resolution_minutes', message }],
      });
    }

    // The audit row travels with the write instead of being recorded after it: on Postgres the policy
    // `UPDATE` and this `audit_logs` insert share one transaction, so a manager cannot move a target
    // without the trail, and a trail row cannot describe a change that did not land.
    const audit: AuditWrite[] = [
      () => ({
        actorId: actor.userId,
        actorRole: actor.role,
        action: 'sla_policy.updated',
        entityType: 'sla_policy',
        entityId: priority,
        before: {
          first_response_minutes: before.first_response_minutes,
          resolution_minutes: before.resolution_minutes,
        },
        after: {
          first_response_minutes: body.first_response_minutes,
          resolution_minutes: body.resolution_minutes,
          reason: body.reason,
        },
        requestId,
      }),
    ];

    const updated = await this.deps.repository.save(
      priority,
      {
        first_response_minutes: body.first_response_minutes,
        resolution_minutes: body.resolution_minutes,
        updated_by: actor.userId,
      },
      audit,
    );

    return toDto(updated);
  }

  /** Business-hours due dates for a freshly submitted request (FR-14). */
  computeDueDates(submittedAt: Date, policy: SlaPolicyRecord): DueDates {
    const window = windowOf(policy);
    return {
      first_response_due_at: addBusinessMinutes(
        submittedAt,
        policy.first_response_minutes,
        window,
      ).toISOString(),
      resolution_due_at: addBusinessMinutes(
        submittedAt,
        policy.resolution_minutes,
        window,
      ).toISOString(),
    };
  }

  /**
   * Derived urgency for badges and queues — never stored, always recomputed from the tracker.
   * Pause handling: the resume path extends `resolution_due_at` by the paused business minutes
   * (docs/requirements.md FR-15), so this calculation only compares "now" with the stored due date.
   */
  summarize(policy: SlaPolicyRecord, tracker: TrackerTimes): SlaSummary {
    const window = windowOf(policy);
    const now = this.deps.clock.now();
    const submittedAt = new Date(tracker.submitted_at);
    const due = new Date(tracker.resolution_due_at);

    const elapsed = elapsedBusinessMinutes(submittedAt, now, window);
    const remaining = remainingBusinessMinutes(now, due, window);
    const consumedRatio = policy.resolution_minutes > 0 ? elapsed / policy.resolution_minutes : 1;
    const state: SlaState =
      remaining <= 0 ? 'breached' : consumedRatio >= SLA_WARNING_RATIO ? 'warning' : 'safe';

    return {
      first_response_due_at: tracker.first_response_due_at
        ? new Date(tracker.first_response_due_at).toISOString()
        : null,
      resolution_due_at: due.toISOString(),
      resolution_business_minutes_remaining: remaining,
      state,
    };
  }

  private async requireRecord(priority: RequestPriority): Promise<SlaPolicyRecord> {
    const record = await this.deps.repository.find(priority);
    if (!record) throw notFound(`SLA policy for priority '${priority}'`);
    return record;
  }
}

function windowOf(policy: SlaPolicyRecord) {
  try {
    return toWindow(policy.business_hours);
  } catch (error) {
    if (error instanceof InvalidBusinessWindowError) {
      throw new AppError('VALIDATION_ERROR', error.message, { cause: error });
    }
    throw error;
  }
}

function toDto(record: SlaPolicyRecord): SlaPolicyDto {
  return {
    priority: record.priority,
    first_response_minutes: record.first_response_minutes,
    resolution_minutes: record.resolution_minutes,
    business_hours: record.business_hours,
    ...(record.updated_at ? { updated_at: record.updated_at } : {}),
    ...(record.updated_by ? { updated_by: record.updated_by } : {}),
  };
}
