import { describe, expect, it } from 'vitest';
import {
  allowedActionsFor,
  canPerform,
  InvalidTransitionError,
  isTransitionAllowed,
  requiresReason,
  REQUEST_ACTIONS,
  transitionFor,
  TRANSITION_TABLE,
} from './requestTransitions.js';
import type { ActorContext } from './requestTransitions.js';
import { REQUEST_STATUSES } from '../enums/index.js';
import type { RequestStatus } from '../enums/index.js';

const employee: ActorContext = { role: 'employee', isRequester: true, isAssignee: false };
const otherEmployee: ActorContext = { role: 'employee', isRequester: false, isAssignee: false };
const assigneeAgent: ActorContext = { role: 'agent', isRequester: false, isAssignee: true };
const strangerAgent: ActorContext = { role: 'agent', isRequester: false, isAssignee: false };
const manager: ActorContext = { role: 'manager', isRequester: false, isAssignee: false };

describe('request lifecycle table (docs/requirements.md §6)', () => {
  it('declares an entry for every status', () => {
    for (const status of REQUEST_STATUSES) {
      expect(TRANSITION_TABLE[status]).toBeDefined();
    }
  });

  it('cancelled and closed-only-reopen are terminal for agents', () => {
    expect(Object.keys(TRANSITION_TABLE.cancelled)).toHaveLength(0);
    expect(allowedActionsFor('cancelled', manager)).toEqual([]);
    expect(allowedActionsFor('closed', otherEmployee)).toEqual([]);
  });

  it('every declared transition targets a known status', () => {
    for (const status of REQUEST_STATUSES) {
      for (const action of REQUEST_ACTIONS) {
        const rule = TRANSITION_TABLE[status][action];
        if (rule) expect(REQUEST_STATUSES).toContain(rule.to);
      }
    }
  });
});

describe('transition legality by actor', () => {
  it('draft: only the requester may submit or cancel', () => {
    expect(canPerform('draft', 'submit', employee)).toBe(true);
    expect(canPerform('draft', 'submit', otherEmployee)).toBe(false);
    expect(canPerform('draft', 'claim', strangerAgent)).toBe(false);
  });

  it('submitted: agents claim, managers assign, requester cancels with reason', () => {
    expect(canPerform('submitted', 'claim', strangerAgent)).toBe(true);
    expect(canPerform('submitted', 'assign', manager)).toBe(true);
    expect(canPerform('submitted', 'assign', strangerAgent)).toBe(false);
    expect(requiresReason('submitted', 'cancel')).toBe(true);
  });

  it('in_progress: only the assignee (or a manager) may hold or resolve', () => {
    expect(canPerform('in_progress', 'resolve', assigneeAgent)).toBe(true);
    expect(canPerform('in_progress', 'resolve', strangerAgent)).toBe(false);
    expect(canPerform('in_progress', 'resolve', manager)).toBe(true);
    expect(canPerform('in_progress', 'hold', assigneeAgent)).toBe(true);
    expect(requiresReason('in_progress', 'hold')).toBe(true);
    expect(requiresReason('in_progress', 'resolve')).toBe(true);
  });

  it('requester cannot cancel once work has started (BR-5 / TC-SM-03)', () => {
    expect(canPerform('in_progress', 'cancel', employee)).toBe(false);
    expect(canPerform('on_hold', 'cancel', employee)).toBe(false);
  });

  it('resolved: requester confirms closure or reopens; employees cannot resolve', () => {
    expect(canPerform('resolved', 'close_confirm', employee)).toBe(true);
    expect(canPerform('resolved', 'close_confirm', otherEmployee)).toBe(false);
    expect(canPerform('resolved', 'reopen', employee)).toBe(true);
    expect(requiresReason('resolved', 'reopen')).toBe(true);
    expect(canPerform('resolved', 'resolve', assigneeAgent)).toBe(false);
  });

  it('on_hold resumes into in_progress (SLA clock restarts, FR-15)', () => {
    expect(transitionFor('on_hold', 'resume').to).toBe('in_progress');
  });

  it('reopen returns to assigned so the original SLA clock keeps running (FR-12)', () => {
    expect(transitionFor('resolved', 'reopen').to).toBe('assigned');
    expect(transitionFor('closed', 'reopen').to).toBe('assigned');
  });
});

describe('query helpers', () => {
  it('allowedActionsFor returns only legal, permitted actions', () => {
    expect(allowedActionsFor('submitted', employee)).toEqual(['cancel']);
    expect(allowedActionsFor('submitted', otherEmployee)).toEqual([]);
    expect(allowedActionsFor('assigned', assigneeAgent).sort()).toEqual(
      ['hold', 'resolve', 'start'].sort(),
    );
    expect(allowedActionsFor('assigned', strangerAgent)).toEqual([]);
  });

  it('isTransitionAllowed ignores the actor and only checks the table', () => {
    expect(isTransitionAllowed('draft', 'submit')).toBe(true);
    expect(isTransitionAllowed('draft', 'resolve')).toBe(false);
  });

  it('transitionFor throws a typed error for illegal transitions (TC-SM-05)', () => {
    expect(() => transitionFor('submitted', 'resolve')).toThrow(InvalidTransitionError);
    try {
      transitionFor('submitted', 'resolve');
    } catch (error) {
      const failure = error as InvalidTransitionError;
      expect(failure.status).toBe('submitted');
      expect(failure.action).toBe('resolve');
      expect(failure.message).toContain('submitted');
    }
  });

  it('requiresReason is false for undeclared pairs instead of throwing', () => {
    expect(requiresReason('cancelled', 'cancel')).toBe(false);
  });
});

describe('status coverage', () => {
  it('every status exposes at least one action except terminal ones', () => {
    const actionable: RequestStatus[] = REQUEST_STATUSES.filter(
      (status) => Object.keys(TRANSITION_TABLE[status]).length > 0,
    );
    expect(actionable).toEqual([
      'draft',
      'submitted',
      'assigned',
      'in_progress',
      'on_hold',
      'resolved',
      'closed',
    ]);
  });
});
