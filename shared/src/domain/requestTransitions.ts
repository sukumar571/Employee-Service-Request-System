import type { RequestStatus, UserRole } from '../enums/index.js';
import { REQUEST_STATUSES, USER_ROLES } from '../enums/index.js';

/**
 * The single source of truth for the request lifecycle (docs/requirements.md §6).
 *
 * The backend state machine (`backend/src/domain/request/stateMachine.ts`) enforces legality and
 * the frontend derives which action buttons to show from `allowedActionsFor()` — so the two can
 * never drift (risk mitigation in docs/requirements.md §15).
 *
 * Role arrays answer "may this ROLE ever perform the action". Person-level rules (is the actor the
 * requester? the current assignee?) are additional flags evaluated by `allowedActionsFor()` and by
 * the backend RBAC policy, because they need resource context, not just a role.
 */
export const REQUEST_ACTIONS = [
  'submit',
  'cancel',
  'claim',
  'assign',
  'start',
  'hold',
  'resume',
  'resolve',
  'close_confirm',
  'reopen',
] as const;

export type RequestAction = (typeof REQUEST_ACTIONS)[number];

export interface TransitionRule {
  /** Status the request moves to. */
  readonly to: RequestStatus;
  /** Roles that may ever perform this action. */
  readonly roles: readonly UserRole[];
  /** Only the requester may perform it. */
  readonly requesterOnly?: boolean;
  /** Only the current assignee may perform it (managers/admins override via `managersBypass`). */
  readonly assigneeOnly?: boolean;
  /** Managers/admins may act even when `assigneeOnly` is set. */
  readonly managersBypass?: boolean;
  /** A non-empty `reason` is mandatory (docs/requirements.md BR-5, ST-303). */
  readonly reasonRequired?: boolean;
}

const AGENT_AND_ABOVE: readonly UserRole[] = ['agent', 'manager', 'admin'];
const MANAGER_AND_ABOVE: readonly UserRole[] = ['manager', 'admin'];

export const TRANSITION_TABLE: Readonly<
  Record<RequestStatus, Partial<Record<RequestAction, TransitionRule>>>
> = {
  draft: {
    submit: { to: 'submitted', roles: USER_ROLES, requesterOnly: true },
    cancel: { to: 'cancelled', roles: USER_ROLES, requesterOnly: true },
  },
  submitted: {
    claim: { to: 'assigned', roles: AGENT_AND_ABOVE },
    assign: { to: 'assigned', roles: MANAGER_AND_ABOVE },
    cancel: { to: 'cancelled', roles: USER_ROLES, requesterOnly: true, reasonRequired: true },
  },
  assigned: {
    start: { to: 'in_progress', roles: AGENT_AND_ABOVE, assigneeOnly: true, managersBypass: true },
    assign: { to: 'assigned', roles: MANAGER_AND_ABOVE },
    hold: {
      to: 'on_hold',
      roles: AGENT_AND_ABOVE,
      assigneeOnly: true,
      managersBypass: true,
      reasonRequired: true,
    },
    resolve: {
      to: 'resolved',
      roles: AGENT_AND_ABOVE,
      assigneeOnly: true,
      managersBypass: true,
      reasonRequired: true,
    },
    cancel: { to: 'cancelled', roles: USER_ROLES, requesterOnly: true, reasonRequired: true },
  },
  in_progress: {
    hold: {
      to: 'on_hold',
      roles: AGENT_AND_ABOVE,
      assigneeOnly: true,
      managersBypass: true,
      reasonRequired: true,
    },
    assign: { to: 'assigned', roles: MANAGER_AND_ABOVE },
    resolve: {
      to: 'resolved',
      roles: AGENT_AND_ABOVE,
      assigneeOnly: true,
      managersBypass: true,
      reasonRequired: true,
    },
  },
  on_hold: {
    resume: { to: 'in_progress', roles: AGENT_AND_ABOVE, assigneeOnly: true, managersBypass: true },
    assign: { to: 'assigned', roles: MANAGER_AND_ABOVE },
  },
  resolved: {
    close_confirm: { to: 'closed', roles: USER_ROLES, requesterOnly: true },
    // Reopening returns the ticket to its previous assignee and resumes the original SLA clock
    // (docs/requirements.md FR-12). The 7-day window is a time rule, checked in the service layer.
    reopen: { to: 'assigned', roles: USER_ROLES, requesterOnly: true, reasonRequired: true },
  },
  closed: {
    reopen: { to: 'assigned', roles: USER_ROLES, requesterOnly: true, reasonRequired: true },
  },
  cancelled: {},
};

export function transitionFor(status: RequestStatus, action: RequestAction): TransitionRule {
  const rule = TRANSITION_TABLE[status][action];
  if (!rule) {
    throw new InvalidTransitionError(status, action);
  }
  return rule;
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly status: RequestStatus,
    readonly action: RequestAction,
  ) {
    super(`Transition not allowed from '${status}' via '${action}'`);
    this.name = 'InvalidTransitionError';
  }
}

export function isTransitionAllowed(status: RequestStatus, action: RequestAction): boolean {
  return TRANSITION_TABLE[status][action] !== undefined;
}

export interface ActorContext {
  readonly role: UserRole;
  readonly isRequester: boolean;
  readonly isAssignee: boolean;
}

/** True when `actor` may perform `action` on a request in `status`. */
export function canPerform(
  status: RequestStatus,
  action: RequestAction,
  actor: ActorContext,
): boolean {
  const rule = TRANSITION_TABLE[status][action];
  if (!rule) return false;
  if (!rule.roles.includes(actor.role)) return false;
  if (rule.requesterOnly && !actor.isRequester) return false;
  if (rule.assigneeOnly && !actor.isAssignee) {
    const isManager = actor.role === 'manager' || actor.role === 'admin';
    if (!(rule.managersBypass && isManager)) return false;
  }
  return true;
}

/** Actions the given actor may currently perform — drives both UI buttons and API rejection. */
export function allowedActionsFor(status: RequestStatus, actor: ActorContext): RequestAction[] {
  return REQUEST_ACTIONS.filter((action) => canPerform(status, action, actor));
}

export function requiresReason(status: RequestStatus, action: RequestAction): boolean {
  return TRANSITION_TABLE[status][action]?.reasonRequired ?? false;
}

/** Wire form of one rule (`snake_case`, served by `GET /meta` so the SPA never re-codes the table). */
export interface LifecycleRuleDto {
  readonly from: RequestStatus;
  readonly action: RequestAction;
  readonly to: RequestStatus;
  /** Mutable on purpose: this mirrors the parsed wire shape (`z.array(...)`) the frontend consumes. */
  readonly roles: UserRole[];
  readonly requester_only: boolean;
  readonly assignee_only: boolean;
  readonly managers_bypass: boolean;
  readonly reason_required: boolean;
}

/** Flatten the transition table into DTOs, ordered by status then action (stable for snapshots). */
export function lifecycleRules(): LifecycleRuleDto[] {
  const rules: LifecycleRuleDto[] = [];
  for (const from of REQUEST_STATUSES) {
    const actions = TRANSITION_TABLE[from];
    for (const action of REQUEST_ACTIONS) {
      const rule = actions[action];
      if (!rule) continue;
      rules.push({
        from,
        action,
        to: rule.to,
        roles: [...rule.roles],
        requester_only: rule.requesterOnly ?? false,
        assignee_only: rule.assigneeOnly ?? false,
        managers_bypass: rule.managersBypass ?? false,
        reason_required: rule.reasonRequired ?? false,
      });
    }
  }
  return rules;
}
