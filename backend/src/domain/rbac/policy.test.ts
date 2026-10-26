import type { UserRole } from '@esrs/shared';
import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_ACTOR as ANONYMOUS,
  can,
  canSeeInternalNotes,
  canSeeTeam,
  PERMISSIONS,
  RBAC_ACTIONS,
  roleAtLeast,
  type RbacAction,
  type RbacActor,
} from './policy.js';

/**
 * Permission-matrix test (docs/test-plan.md §6 SEC-TC-04): the defaults from
 * docs/requirements.md §7 must hold for every declared action, and nothing may be allowed by
 * accident when an action is missing from the map.
 */
const actor = (role: RbacActor['role'], teamCategoryId?: string): RbacActor => ({
  userId: `user-${role}`,
  role,
  teamCategoryId,
});

describe('can() — default deny', () => {
  it('declares a permission for every action', () => {
    const missing = RBAC_ACTIONS.filter((action) => PERMISSIONS[action] === undefined);
    expect(missing).toEqual([]);
  });

  it('denies an anonymous caller for every action', () => {
    for (const action of RBAC_ACTIONS) {
      expect(can(ANONYMOUS, action)).toBe(false);
    }
  });

  it('denies an unknown action instead of guessing', () => {
    const unknownAction = 'request.read' as unknown as RbacAction;
    expect(can(actor('admin'), unknownAction)).toBe(false);
  });
});

describe('can() — documented role matrix (requirements.md §7)', () => {
  it('lets employees act only on their own requests, comments and notifications', () => {
    const employee = actor('employee');
    expect(can(employee, 'request.create')).toBe(true);
    expect(can(employee, 'request.cancel')).toBe(true);
    expect(can(employee, 'notification.read')).toBe(true);
    for (const action of [
      'request.read.team',
      'request.read.all',
      'request.transition',
      'request.claim',
      'request.assign',
      'comment.internal',
      'sla_policy.update',
      'analytics.read',
      'audit.read',
      'user.manage',
      'taxonomy.manage',
    ] satisfies RbacAction[]) {
      expect(can(employee, action)).toBe(false);
    }
  });

  it('lets agents work tickets but not change policy, users or audit', () => {
    const agent = actor('agent');
    expect(can(agent, 'request.claim')).toBe(true);
    expect(can(agent, 'request.transition')).toBe(true);
    expect(can(agent, 'comment.internal')).toBe(true);
    expect(can(agent, 'request.read.all')).toBe(false);
    expect(can(agent, 'request.assign')).toBe(false);
    expect(can(agent, 'sla_policy.update')).toBe(false);
    expect(can(agent, 'analytics.read')).toBe(false);
    expect(can(agent, 'audit.read')).toBe(false);
    expect(can(agent, 'user.manage')).toBe(false);
  });

  it('lets managers own SLA policy and analytics but not user management or audit', () => {
    const manager = actor('manager');
    expect(can(manager, 'request.read.all')).toBe(true);
    expect(can(manager, 'request.assign')).toBe(true);
    expect(can(manager, 'sla_policy.update')).toBe(true);
    expect(can(manager, 'analytics.read')).toBe(true);
    expect(can(manager, 'user.manage')).toBe(false);
    expect(can(manager, 'taxonomy.manage')).toBe(false);
    expect(can(manager, 'audit.read')).toBe(false);
  });

  it('lets admins do everything, including the admin-only rows', () => {
    for (const action of RBAC_ACTIONS) {
      expect(can(actor('admin'), action)).toBe(true);
    }
  });
});

describe('roleAtLeast()', () => {
  it('orders employee < agent < manager < admin', () => {
    const ranks: UserRole[] = ['employee', 'agent', 'manager', 'admin'];
    ranks.forEach((role, index) => {
      expect(roleAtLeast(actor(role), 'employee')).toBe(true);
      expect(roleAtLeast(actor(role), 'agent')).toBe(index >= 1);
      expect(roleAtLeast(actor(role), 'manager')).toBe(index >= 2);
      expect(roleAtLeast(actor(role), 'admin')).toBe(index === 3);
    });
  });

  it('never satisfies a minimum for an anonymous caller', () => {
    expect(roleAtLeast(ANONYMOUS, 'employee')).toBe(false);
  });
});

describe('object-level scoping', () => {
  it('confines an agent to their own team queue', () => {
    const itAgent = actor('agent', 'cat-it');
    expect(canSeeTeam(itAgent, 'cat-it')).toBe(true);
    expect(canSeeTeam(itAgent, 'cat-hr')).toBe(false);
  });

  it('lets managers and admins see every team, and employees see none', () => {
    expect(canSeeTeam(actor('manager', 'cat-hr'), 'cat-fac')).toBe(true);
    expect(canSeeTeam(actor('admin'), 'cat-fac')).toBe(true);
    expect(canSeeTeam(actor('employee'), 'cat-fac')).toBe(false);
  });

  it('hides internal notes from employees (AC-5)', () => {
    expect(canSeeInternalNotes(actor('employee'))).toBe(false);
    expect(canSeeInternalNotes(actor('agent'))).toBe(true);
    expect(canSeeInternalNotes(ANONYMOUS)).toBe(false);
  });
});
