import type { UserRole } from '@esrs/shared';

/**
 * Default-deny authorization model (docs/requirements.md §7, docs/security-plan.md §4).
 * `can()` answers "may this role ever perform this action"; object-level rules (is it your
 * request? your team?) are separate helpers so routes/services apply both layers.
 *
 * Every action used by a route must be declared here — the permission-matrix test
 * (docs/test-plan.md §6 SEC-TC-04) fails CI when an endpoint is missing from this list.
 */

export interface RbacActor {
  readonly userId: string;
  readonly role: UserRole | 'anonymous';
  /** Team (category) the agent/manager belongs to — drives queue scoping (ST-301). */
  readonly teamCategoryId?: string | null;
}

export const RBAC_ACTIONS = [
  'request.create',
  'request.read.own',
  'request.read.team',
  'request.read.all',
  'request.transition',
  'request.cancel',
  'request.assign',
  'request.claim',
  'comment.create',
  'comment.internal',
  'attachment.download',
  'sla_policy.read',
  'sla_policy.update',
  'user.manage',
  'taxonomy.manage',
  'analytics.read',
  'audit.read',
  'notification.read',
] as const;

export type RbacAction = (typeof RBAC_ACTIONS)[number];

/** No identity at all. Every action is denied for this actor — the fail-closed default. */
export const ANONYMOUS_ACTOR: RbacActor = { userId: 'anonymous', role: 'anonymous' };

const ALL_STAFF: readonly UserRole[] = ['agent', 'manager', 'admin'];
const EVERYONE: readonly UserRole[] = ['employee', 'agent', 'manager', 'admin'];
const MANAGER_AND_ABOVE: readonly UserRole[] = ['manager', 'admin'];

export const PERMISSIONS: Record<RbacAction, readonly UserRole[]> = {
  'request.create': EVERYONE,
  'request.read.own': EVERYONE,
  'request.read.team': ALL_STAFF,
  'request.read.all': MANAGER_AND_ABOVE,
  'request.transition': ALL_STAFF,
  'request.cancel': EVERYONE,
  'request.assign': MANAGER_AND_ABOVE,
  'request.claim': ALL_STAFF,
  'comment.create': EVERYONE,
  'comment.internal': ALL_STAFF,
  'attachment.download': EVERYONE,
  'sla_policy.read': EVERYONE,
  'sla_policy.update': MANAGER_AND_ABOVE,
  'user.manage': ['admin'],
  'taxonomy.manage': ['admin'],
  'analytics.read': MANAGER_AND_ABOVE,
  'audit.read': ['admin'],
  'notification.read': EVERYONE,
};

/** Role ordering for "at least" checks (ST-105, manager+ surfaces). */
export const ROLE_RANK: Record<UserRole, number> = {
  employee: 1,
  agent: 2,
  manager: 3,
  admin: 4,
};

export function can(actor: Pick<RbacActor, 'role'>, action: RbacAction): boolean {
  if (actor.role === 'anonymous') return false;
  const allowed = PERMISSIONS[action];
  return allowed ? allowed.includes(actor.role) : false; // default deny
}

export function roleAtLeast(actor: Pick<RbacActor, 'role'>, minimum: UserRole): boolean {
  return actor.role !== 'anonymous' && ROLE_RANK[actor.role] >= ROLE_RANK[minimum];
}

/** Queue/detail scoping: managers and admins see all teams; agents only their own. */
export function canSeeTeam(actor: RbacActor, categoryTeamId: string): boolean {
  if (roleAtLeast(actor, 'manager')) return true;
  return actor.role === 'agent' && actor.teamCategoryId === categoryTeamId;
}

/** Internal notes are never visible to requesters (AC-5, edge case docs/requirements.md §16). */
export function canSeeInternalNotes(actor: Pick<RbacActor, 'role'>): boolean {
  return roleAtLeast(actor, 'agent');
}
