import {
  DEFAULT_BUSINESS_HOURS,
  DEFAULT_SLA_POLICIES,
  slaSummarySchema,
  type RequestPriority,
} from '@esrs/shared';
import { AppError } from '../../lib/errors/appError.js';
import { FixedClock } from '../../domain/ports/clock.js';
import { RecordingAuditSink } from '../../ports/audit.js';
import { describe, expect, it } from 'vitest';
import { InMemorySlaPolicyRepository, defaultRecords } from './sla.repository.memory.js';
import type { SlaPolicyRecord } from './sla.repository.js';
import { SlaService } from './sla.service.js';

/**
 * Service-level SLA tests. The business-hour math itself is covered by
 * `src/domain/sla/businessHours.test.ts` (TC-SLA-01…07); this file checks orchestration:
 * ordering, the manager edit path, the audit trail and the derived urgency states.
 */
const IST = (iso: string): Date => new Date(iso);
const MON_10 = IST('2026-10-26T10:00:00+05:30'); // Monday
const FRI_1830 = IST('2026-10-30T18:30:00+05:30'); // Friday, after the window closed

const manager = { userId: 'user-900', role: 'manager' as const };
const reason = 'Retargeted after the Q1 capacity review';

/**
 * The audit sink is a repository dependency, not a service one: the `sla_policy.updated` row is handed
 * to `save()` and written by whoever writes the policy, so the two can share a transaction.
 */
function service(now = MON_10) {
  const clock = new FixedClock(now);
  const audit = new RecordingAuditSink();
  const repository = new InMemorySlaPolicyRepository(clock, defaultRecords(), audit);
  return {
    clock,
    audit,
    repository,
    sla: new SlaService({ repository, clock }),
  };
}

describe('SlaService.listPolicies', () => {
  it('returns all four priorities in the frozen contract order', async () => {
    const { sla } = service();
    const policies = await sla.listPolicies();
    expect(policies.map((policy) => policy.priority)).toEqual([
      'low',
      'medium',
      'high',
      'critical',
    ]);
    expect(policies[0]).toMatchObject({
      first_response_minutes: DEFAULT_SLA_POLICIES.low.first_response_minutes,
      resolution_minutes: DEFAULT_SLA_POLICIES.low.resolution_minutes,
      business_hours: DEFAULT_BUSINESS_HOURS,
    });
  });
});

describe('SlaService.computeDueDates — business time, not elapsed time', () => {
  const policyFor = (priority: RequestPriority): SlaPolicyRecord => ({
    priority,
    ...DEFAULT_SLA_POLICIES[priority],
    business_hours: DEFAULT_BUSINESS_HOURS,
  });

  it('adds critical targets inside the same working day (FR-14)', () => {
    const { sla } = service();
    const due = sla.computeDueDates(MON_10, policyFor('critical'));
    expect(IST(due.first_response_due_at).getTime()).toBe(
      IST('2026-10-26T10:30:00+05:30').getTime(),
    );
    expect(IST(due.resolution_due_at).getTime()).toBe(IST('2026-10-26T14:00:00+05:30').getTime());
  });

  it('spends a 24-business-hour target over three working days (TC-SLA-01)', () => {
    const { sla } = service();
    const due = sla.computeDueDates(MON_10, policyFor('high'));
    expect(IST(due.resolution_due_at).getTime()).toBe(IST('2026-10-28T16:00:00+05:30').getTime());
  });

  it('pushes a submission made after closing time to the next working morning', () => {
    const { sla } = service();
    const due = sla.computeDueDates(FRI_1830, policyFor('critical'));
    // Friday 18:30 is outside the window, so the clock starts Monday 09:00: 240 minutes → 13:00.
    expect(IST(due.resolution_due_at).getTime()).toBe(IST('2026-11-02T13:00:00+05:30').getTime());
  });

  it('rejects an unparseable business window as a validation error', () => {
    const { sla } = service();
    const broken: SlaPolicyRecord = {
      ...policyFor('low'),
      business_hours: { ...DEFAULT_BUSINESS_HOURS, start: '18:00', end: '09:00' },
    };
    expect(() => sla.computeDueDates(MON_10, broken)).toThrow(AppError);
  });
});

describe('SlaService.updatePolicy (ST-403)', () => {
  it('applies the new targets and records an audit entry with before/after', async () => {
    const { sla, audit, clock } = service();
    const updated = await sla.updatePolicy(
      'high',
      { first_response_minutes: 60, resolution_minutes: 720, reason },
      manager,
      'req-abc-123',
    );

    expect(updated).toMatchObject({
      priority: 'high',
      first_response_minutes: 60,
      resolution_minutes: 720,
      updated_by: manager.userId,
    });
    expect(updated.updated_at).toBe(clock.now().toISOString());

    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      actorId: manager.userId,
      actorRole: 'manager',
      action: 'sla_policy.updated',
      entityType: 'sla_policy',
      entityId: 'high',
      requestId: 'req-abc-123',
    });
    expect(audit.entries[0]?.after).toMatchObject({ reason });
  });

  it('rejects a resolution target that is not longer than the response target', async () => {
    const { sla } = service();
    let failure: unknown;
    try {
      await sla.updatePolicy(
        'high',
        { first_response_minutes: 600, resolution_minutes: 480, reason },
        manager,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe('VALIDATION_ERROR');
    expect((failure as AppError).status).toBe(400);
    expect((failure as AppError).details?.[0]?.path).toBe('resolution_minutes');
  });

  it('reports NOT_FOUND for a priority with no policy row', async () => {
    const clock = new FixedClock(MON_10);
    const partial: SlaPolicyRecord = {
      priority: 'low',
      first_response_minutes: 480,
      resolution_minutes: 2700,
      business_hours: DEFAULT_BUSINESS_HOURS,
    };
    const sla = new SlaService({
      repository: new InMemorySlaPolicyRepository(clock, [partial], new RecordingAuditSink()),
      clock,
    });
    await expect(sla.getPolicy('critical')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('SlaService.summarize — derived urgency (FR-16/FR-17)', () => {
  const policy: SlaPolicyRecord = {
    priority: 'medium',
    first_response_minutes: 60,
    resolution_minutes: 540, // one full business day (09:00–18:00 = 540 min)
    business_hours: DEFAULT_BUSINESS_HOURS,
  };
  // Monday 10:00 + 540 business minutes = Tuesday 10:00 (480 left on Monday, 60 on Tuesday).
  const tracker = {
    submitted_at: MON_10.toISOString(),
    resolution_due_at: IST('2026-10-27T10:00:00+05:30').toISOString(),
  };

  it('is safe at 67 % of the business budget', () => {
    const { sla } = service(IST('2026-10-26T16:00:00+05:30'));
    const summary = sla.summarize(policy, tracker);
    expect(summary.state).toBe('safe');
    expect(summary.resolution_business_minutes_remaining).toBe(180);
    expect(summary.first_response_due_at).toBeNull();
    expect(slaSummarySchema.parse(summary)).toMatchObject({ state: 'safe' });
  });

  it('warns once 75 % of the budget is consumed', () => {
    const { sla } = service(IST('2026-10-27T09:00:00+05:30'));
    const summary = sla.summarize(policy, tracker);
    expect(summary.state).toBe('warning');
    expect(summary.resolution_business_minutes_remaining).toBe(60);
  });

  it('is breached at and after the due date', () => {
    const { sla } = service(IST('2026-10-27T11:00:00+05:30'));
    const summary = sla.summarize(policy, tracker);
    expect(summary.state).toBe('breached');
    expect(summary.resolution_business_minutes_remaining).toBe(0);
  });

  it('echoes a first-response deadline when the tracker carries one', () => {
    const { sla } = service(MON_10);
    const summary = sla.summarize(policy, {
      ...tracker,
      first_response_due_at: IST('2026-10-26T11:00:00+05:30'),
    });
    expect(summary.first_response_due_at).toBe(IST('2026-10-26T11:00:00+05:30').toISOString());
  });
});
