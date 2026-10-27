import type { RequestAction, RequestEventType, RequestStatus } from '@esrs/shared';
import { canPerform, requiresReason, transitionFor } from '@esrs/shared';
import type { ActorContext } from '@esrs/shared';

/**
 * Backend enforcement of the lifecycle (docs/requirements.md §6). This is the ONLY code path that
 * may change a request status; the service wraps it in a transaction with optimistic locking
 * (docs/system-architecture.md §4, docs/database-design.md §2.3).
 *
 * The legality table itself lives in `@esrs/shared` so the API and the UI can never disagree.
 */

export interface LifecycleState {
  readonly status: RequestStatus;
  readonly version: number;
  readonly requesterId: string;
  readonly assigneeId: string | null;
}

export interface TransitionCommand {
  readonly action: RequestAction;
  readonly actorId: string;
  readonly actorRole: ActorContext['role'];
  readonly expectedVersion?: number;
  readonly reason?: string;
}

export interface TransitionResult {
  readonly fromStatus: RequestStatus;
  readonly toStatus: RequestStatus;
  readonly eventType: RequestEventType;
  readonly version: number;
  readonly assigneeId: string | null;
  readonly reason?: string;
}

export class DomainRuleError extends Error {
  constructor(
    readonly kind: 'INVALID_TRANSITION' | 'REASON_REQUIRED' | 'VERSION_CONFLICT' | 'NOT_PERMITTED',
    message: string,
  ) {
    super(message);
    this.name = 'DomainRuleError';
  }
}

/** Actions that take the ticket into (or back to) work by a specific agent. */
const ASSIGNING_ACTIONS: ReadonlySet<RequestAction> = new Set(['claim', 'assign']);

const EVENT_FOR_ACTION: Record<RequestAction, RequestEventType> = {
  submit: 'submitted',
  cancel: 'cancelled',
  claim: 'claimed',
  assign: 'assigned',
  start: 'started',
  hold: 'placed_on_hold',
  resume: 'resumed',
  resolve: 'resolved',
  close_confirm: 'closed',
  reopen: 'reopened',
};

export function applyTransition(
  state: LifecycleState,
  command: TransitionCommand,
): TransitionResult {
  const actor: ActorContext = {
    role: command.actorRole,
    isRequester: state.requesterId === command.actorId,
    isAssignee: state.assigneeId !== null && state.assigneeId === command.actorId,
  };

  // 1. Optimistic concurrency (edge case §16.4) is checked first: a failed `If-Match` precondition
  //    means the writer is judging an action against a state they never saw, so reporting the move as
  //    illegal would be wrong — the actionable fact is that the row moved under them.
  if (command.expectedVersion !== undefined && command.expectedVersion !== state.version) {
    throw new DomainRuleError(
      'VERSION_CONFLICT',
      `Expected version ${command.expectedVersion} but the request is at version ${state.version}`,
    );
  }

  // 2. Legal transition for this status?
  const rule = transitionFor(state.status, command.action); // throws InvalidTransitionError

  // 3. May THIS actor perform it, given requester/assignee context?
  if (!canPerform(state.status, command.action, actor)) {
    throw new DomainRuleError(
      'NOT_PERMITTED',
      `Role '${command.actorRole}' may not ${command.action} a request in status '${state.status}'`,
    );
  }

  // 4. Mandatory reason (docs/requirements.md BR-5).
  const reason = command.reason?.trim();
  if (requiresReason(state.status, command.action) && (!reason || reason.length < 10)) {
    throw new DomainRuleError(
      'REASON_REQUIRED',
      `A reason of at least 10 characters is required to ${command.action} this request`,
    );
  }

  return {
    fromStatus: state.status,
    toStatus: rule.to,
    eventType: EVENT_FOR_ACTION[command.action],
    version: state.version + 1,
    // A claim self-assigns; an explicit assignment is resolved by the service (it knows the target
    // agent). Every other action leaves the assignee untouched.
    assigneeId: command.action === 'claim' ? command.actorId : state.assigneeId,
    ...(reason ? { reason } : {}),
  };
}

export function isAssigningAction(action: RequestAction): boolean {
  return ASSIGNING_ACTIONS.has(action);
}
