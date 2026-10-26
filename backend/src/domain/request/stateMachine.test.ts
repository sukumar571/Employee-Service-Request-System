import { InvalidTransitionError, type RequestStatus } from '@esrs/shared';
import { describe, expect, it } from 'vitest';
import { applyTransition, DomainRuleError, isAssigningAction } from './stateMachine.js';
import type { LifecycleState, TransitionCommand } from './stateMachine.js';

const REQUESTER = 'user-100';
const AGENT = 'user-200';
const OTHER_AGENT = 'user-201';

function state(overrides: Partial<LifecycleState> = {}): LifecycleState {
  return {
    status: 'submitted',
    version: 3,
    requesterId: REQUESTER,
    assigneeId: null,
    ...overrides,
  };
}

function claim(actorId = AGENT, overrides: Partial<TransitionCommand> = {}): TransitionCommand {
  return { action: 'claim', actorId, actorRole: 'agent', ...overrides };
}

describe('applyTransition — legality and permissions (TC-SM-01…03)', () => {
  it('performs a legal claim and self-assigns the agent', () => {
    const result = applyTransition(state(), claim());
    expect(result).toMatchObject({
      fromStatus: 'submitted',
      toStatus: 'assigned',
      eventType: 'claimed',
      version: 4,
      assigneeId: AGENT,
    });
  });

  it('rejects an illegal transition without inventing a status (TC-SM-01)', () => {
    expect(() =>
      applyTransition(state({ status: 'submitted' }), {
        action: 'resolve',
        actorId: AGENT,
        actorRole: 'agent',
      }),
    ).toThrow(InvalidTransitionError);
  });

  it('rejects a request cancellation once work started (TC-SM-03)', () => {
    // `cancel` is only legal from submitted/assigned, so the shared table rejects it before
    // any actor/role check happens — no status is invented for the illegal attempt.
    expect(() =>
      applyTransition(state({ status: 'in_progress', assigneeId: AGENT }), {
        action: 'cancel',
        actorId: REQUESTER,
        actorRole: 'employee',
        reason: 'No longer needed at all',
      }),
    ).toThrow(InvalidTransitionError);
  });

  it('rejects a stranger agent resolving someone else’s ticket', () => {
    let failure: unknown;
    try {
      applyTransition(state({ status: 'in_progress', assigneeId: AGENT }), {
        action: 'resolve',
        actorId: OTHER_AGENT,
        actorRole: 'agent',
        reason: 'Fixed by rebooting the unit',
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DomainRuleError);
    expect((failure as DomainRuleError).kind).toBe('NOT_PERMITTED');
  });

  it('allows a manager to act on another agent’s ticket (managersBypass)', () => {
    const result = applyTransition(state({ status: 'in_progress', assigneeId: AGENT }), {
      action: 'resolve',
      actorId: 'user-900',
      actorRole: 'manager',
      reason: 'Escalated resolution verified with user',
    });
    expect(result.toStatus).toBe('resolved');
    expect(result.assigneeId).toBe(AGENT);
  });
});

describe('applyTransition — business rules', () => {
  it('requires a reason of at least 10 characters (BR-5)', () => {
    expect(() =>
      applyTransition(state({ status: 'assigned', assigneeId: AGENT }), {
        action: 'hold',
        actorId: AGENT,
        actorRole: 'agent',
        reason: 'too short',
      }),
    ).toThrow(/at least 10 characters/);
  });

  it('accepts a compliant reason and echoes it back', () => {
    const result = applyTransition(state({ status: 'assigned', assigneeId: AGENT }), {
      action: 'hold',
      actorId: AGENT,
      actorRole: 'agent',
      reason: 'Waiting for the employee to reply',
    });
    expect(result.toStatus).toBe('on_hold');
    expect(result.reason).toBe('Waiting for the employee to reply');
  });

  it('does not require a reason for submit', () => {
    const result = applyTransition(state({ status: 'draft' }), {
      action: 'submit',
      actorId: REQUESTER,
      actorRole: 'employee',
    });
    expect(result.toStatus).toBe('submitted');
    expect(result.reason).toBeUndefined();
  });
});

describe('applyTransition — optimistic concurrency (edge case §16.4)', () => {
  it('accepts a matching expectedVersion and bumps it', () => {
    const result = applyTransition(state(), claim(AGENT, { expectedVersion: 3 }));
    expect(result.version).toBe(4);
  });

  it('rejects a stale writer with VERSION_CONFLICT', () => {
    let failure: unknown;
    try {
      applyTransition(state({ version: 7 }), claim(AGENT, { expectedVersion: 3 }));
    } catch (error) {
      failure = error;
    }
    expect((failure as DomainRuleError).kind).toBe('VERSION_CONFLICT');
  });
});

describe('helpers', () => {
  it('flags the actions that change the assignee', () => {
    expect(isAssigningAction('claim')).toBe(true);
    expect(isAssigningAction('resolve')).toBe(false);
  });

  it('terminal statuses reject everything (TC-SM-05)', () => {
    const terminal: RequestStatus[] = ['cancelled'];
    for (const status of terminal) {
      expect(() => applyTransition(state({ status }), claim())).toThrow(InvalidTransitionError);
    }
  });
});
