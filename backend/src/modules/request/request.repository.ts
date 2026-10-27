import type {
  CommentVisibility,
  RequestEventType,
  RequestPriority,
  RequestStatus,
  SlaState,
} from '@esrs/shared';
import type { AuditWrite } from '../../ports/audit.js';

/**
 * Persistence port for the request aggregate (docs/database-design.md §2.3–§2.8): the request row and
 * everything that only makes sense attached to it — assignment history, the SLA tracker, the
 * append-only activity trail and the comment thread.
 *
 * The service depends on this interface only. The Postgres adapter is used when `DATABASE_URL` is
 * set; the in-memory adapter keeps the API and the HTTP test suite runnable without a database —
 * the same port/adapter split as the SLA module.
 *
 * Every write that touches more than one table (submit, assign, resolve, reopen, a priority edit, a
 * comment) is a single repository method, so the transaction lives in exactly one place and a caller
 * can never half-apply a lifecycle change. Each of those writes also carries its `audit` rows, which
 * the adapter inserts on the *same* transaction client: the audit trail is atomic with the change.
 */

/** Denormalised display data resolved by the adapter (JOIN in Postgres, directory lookup in memory). */
export interface RequestParty {
  readonly id: string;
  readonly fullName: string;
}

export interface RequestTaxonomy {
  readonly id: string;
  readonly name: string;
}

/** SLA projection stored alongside a request. `state` is derived, never written by a client. */
export interface StoredSla {
  readonly firstResponseDueAt: string | null;
  readonly resolutionDueAt: string | null;
  readonly state: SlaState;
  /**
   * The tracker's frozen `policy_snapshot` (business-hours window + targets). It is carried through
   * untouched so resolving can re-stamp the tracker against the policy that was in force at
   * submission rather than whatever a manager set since (ST-404, edge case docs/requirements.md §16.6).
   */
  readonly policySnapshot: Record<string, unknown>;
}

export interface StoredRequest {
  readonly id: string;
  readonly requestNumber: string | null;
  readonly requester: RequestParty;
  readonly assignee: RequestParty | null;
  readonly category: RequestTaxonomy;
  readonly subCategory: RequestTaxonomy | null;
  readonly department: RequestTaxonomy | null;
  readonly title: string;
  readonly description: string;
  readonly status: RequestStatus;
  readonly priority: RequestPriority;
  readonly statusReason: string | null;
  readonly resolutionNote: string | null;
  readonly submittedAt: string | null;
  readonly resolvedAt: string | null;
  readonly closedAt: string | null;
  readonly cancelledAt: string | null;
  readonly reopenedFrom: string | null;
  readonly reopenCount: number;
  readonly requesterInactive: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sla: StoredSla | null;
}

/** Filters the caller asked for, already validated and scope-resolved by the service. */
export interface RequestListCriteria {
  readonly page: number;
  readonly pageSize: number;
  readonly statuses: readonly RequestStatus[];
  readonly priorities: readonly RequestPriority[];
  readonly categoryId: string | null;
  readonly subCategoryId: string | null;
  readonly departmentId: string | null;
  readonly requesterId: string | null;
  /** `'me'` and `'unassigned'` are resolved to a concrete id/condition before the call. */
  readonly assigneeId: string | null;
  readonly unassigned: boolean;
  readonly sla: SlaState | null;
  readonly search: string | null;
  readonly sortKey: string;
  readonly sortDescending: boolean;
  /** Row-visibility predicate supplied by the adapter for the caller's scope. */
  readonly scope: RequestScope;
}

export type RequestScope =
  /** Manager/admin: every team's queue, though another author's draft stays invisible. */
  | { readonly kind: 'all'; readonly userId: string }
  /** Employee: only their own tickets (drafts included). */
  | { readonly kind: 'requester'; readonly userId: string }
  /** Agent: own tickets, tickets they hold, and their team's queue (never others' drafts). */
  | { readonly kind: 'team'; readonly userId: string; readonly teamCategoryId: string | null };

export interface RequestPage {
  readonly items: StoredRequest[];
  readonly total: number;
}

/**
 * Outcome of a conditional write. The adapter distinguishes the three cases the HTTP layer has to
 * report differently, so the service never has to guess whether `undefined` meant "missing" or
 * "someone else wrote first" (404 vs 409).
 */
export type WriteOutcome =
  | { readonly kind: 'applied'; readonly request: StoredRequest }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'version_conflict'; readonly currentVersion: number };

export interface NewRequestWrite {
  readonly requesterId: string;
  readonly categoryId: string;
  readonly subCategoryId: string | null;
  readonly departmentId: string | null;
  readonly title: string;
  readonly description: string;
  readonly priority: RequestPriority;
  /** `submitted` runs the full pipeline (number + tracker + event); `draft` writes one row. */
  readonly status: Extract<RequestStatus, 'draft' | 'submitted'>;
  readonly at: string;
  readonly tracker: TrackerWrite | null;
  readonly actorId: string;
  readonly actorRole: string;
  /** Audit rows stamped inside this same transaction (a draft and a submit record different actions). */
  readonly audit: readonly AuditWrite[];
}

/** Editable content fields; an absent key means "leave unchanged", an explicit `null` clears it. */
export interface RequestEditWrite {
  readonly id: string;
  readonly expectedVersion: number | null;
  readonly patch: {
    readonly title?: string;
    readonly description?: string;
    readonly categoryId?: string;
    readonly subCategoryId?: string | null;
    readonly priority?: RequestPriority;
  };
  readonly event: LifecycleEventWrite | null;
  readonly actorId: string;
  readonly actorRole: string;
  readonly audit: readonly AuditWrite[];
}

/** Everything a transition needs to write, in the order the adapter applies it. */
export interface TransitionWrite {
  readonly id: string;
  readonly expectedVersion: number | null;
  readonly fromStatus: RequestStatus;
  readonly toStatus: RequestStatus;
  readonly assigneeId: string | null;
  readonly statusReason: string | null;
  readonly resolutionNote: string | null;
  /** Timestamps to stamp on the row; only the columns named here are written. */
  readonly timestamps: Partial<
    Record<'submittedAt' | 'resolvedAt' | 'closedAt' | 'cancelledAt', string>
  >;
  /**
   * Timestamps to return to NULL. A reopen clears the closure stamps so the row cannot claim to be
   * resolved while its status says `assigned`; the original times survive in `request_events`.
   */
  readonly clearTimestamps: readonly ('submittedAt' | 'resolvedAt' | 'closedAt' | 'cancelledAt')[];
  readonly incrementReopen: boolean;
  /**
   * Year for a gapless `REQ-<year>-<seq>` allocation performed *inside* the same transaction, so a
   * rolled-back submit never burns a number and a committed one never leaves a gap (design §5).
   */
  readonly allocateNumberYear: number | null;
  readonly event: LifecycleEventWrite;
  /** Closes the currently open assignment row, if any, before inserting the new one. */
  readonly closeOpenAssignment: boolean;
  readonly assignment: { readonly agentId: string; readonly reason: AssignmentReason } | null;
  readonly tracker: TrackerWrite | null;
  readonly actorId: string;
  readonly actorRole: string;
  readonly audit: readonly AuditWrite[];
}

/**
 * A comment as stored. `author` and `createdAt` are never supplied by the caller: the adapter writes
 * the acting user id and stamps the instant, so the person and the time cannot be forged through the
 * API (AC-5, BR-8).
 */
export interface StoredComment {
  readonly id: string;
  readonly requestId: string;
  readonly author: RequestParty;
  readonly body: string;
  readonly visibility: CommentVisibility;
  /** BR-8: written after the request reached a terminal status. */
  readonly isPostClosure: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewCommentWrite {
  readonly requestId: string;
  readonly authorId: string;
  readonly authorRole: string;
  readonly body: string;
  readonly visibility: CommentVisibility;
  readonly isPostClosure: boolean;
  readonly at: string;
  /**
   * The `comment_added` entry for the user-visible activity trail. Its `detail` describes the comment
   * (id, visibility, length) and never repeats the body — the body lives in `comments` only.
   */
  readonly event: LifecycleEventWrite;
  readonly audit: readonly AuditWrite[];
}

export interface CommentListCriteria {
  readonly requestId: string;
  /** Agent+ reads internal notes; everybody else gets the `public` rows only, filtered in SQL. */
  readonly includeInternal: boolean;
  readonly limit: number;
  readonly offset: number;
}

export interface CommentPage {
  readonly items: StoredComment[];
  readonly total: number;
}

/**
 * One row of the merged activity feed: a lifecycle event or a comment, never an audit row.
 * `detail` carries the comment body for `kind: 'comment'` and a summary for a `comment_added` event.
 */
export interface TimelineRecord {
  readonly kind: 'event' | 'comment';
  readonly id: string;
  readonly eventType: string;
  readonly actor: RequestParty | null;
  readonly actorRole: string;
  readonly fromStatus: RequestStatus | null;
  readonly toStatus: RequestStatus | null;
  readonly detail: Record<string, unknown>;
  readonly createdAt: string;
}

export interface TimelineCriteria {
  readonly requestId: string;
  readonly includeInternal: boolean;
  readonly limit: number;
}

export type AssignmentReason = 'claim' | 'manager_assign' | 'reassign' | 'reopened';

export interface LifecycleEventWrite {
  readonly eventType: RequestEventType;
  readonly detail: Record<string, unknown>;
}

/** Policy snapshot + due dates frozen at submission (ST-404: later policy edits do not move them). */
export interface TrackerWrite {
  readonly submittedAt: string;
  readonly firstResponseDueAt: string | null;
  readonly resolutionDueAt: string | null;
  readonly policySnapshot: Record<string, unknown>;
  /** `'resume'` clears the warning/breach stamps so a reopened ticket can alert again. */
  readonly resume?: boolean;
  /** Stamped the first time an agent acts on the ticket (FR-17 first-response adherence). */
  readonly markFirstResponse?: boolean;
  /** Recorded when the ticket is resolved: did it land inside the frozen target? */
  readonly completionStatus?: 'met' | 'breached' | null;
}

export interface RequestEventRecord {
  readonly id: string;
  readonly eventType: string;
  readonly actor: RequestParty | null;
  readonly actorRole: string;
  readonly fromStatus: RequestStatus | null;
  readonly toStatus: RequestStatus | null;
  readonly detail: Record<string, unknown>;
  readonly createdAt: string;
}

/**
 * Read bounds for the event trail. `includeInternal` needs explaining, because a lifecycle event is
 * never hidden by it: the trail of what happened to a ticket is not comment content. The exception is
 * the `comment_added` marker, which carries a *comment's* metadata — visibility and length — and so
 * follows the same rule as the note itself. Without that, `GET /requests/{id}/events` would announce
 * that a staff-only note exists on a ticket the note was written to keep private.
 */
export interface EventListCriteria {
  readonly requestId: string;
  readonly includeInternal: boolean;
  readonly limit: number;
}

/** Minimal taxonomy read used to validate identifiers before a write (BR-2). */
export interface TaxonomyRecord {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
}

export interface RequestRepository {
  list(criteria: RequestListCriteria): Promise<RequestPage>;
  find(id: string): Promise<StoredRequest | undefined>;
  create(write: NewRequestWrite): Promise<StoredRequest>;
  /** Draft content edit; the row is locked and its `version` verified inside one transaction. */
  edit(write: RequestEditWrite): Promise<WriteOutcome>;
  /**
   * Applies a lifecycle transition and every related row (assignment, event, tracker, number) in one
   * transaction, under a `FOR UPDATE` row lock with the caller's `expectedVersion` verified.
   */
  transition(write: TransitionWrite): Promise<WriteOutcome>;
  /**
   * The append-only trail, oldest first, bounded by `limit`. The limit applies *after* the internal-note
   * filter, so the page describes the set the caller may see rather than the table.
   */
  events(criteria: EventListCriteria): Promise<RequestEventRecord[]>;
  /**
   * Adds a comment, its `comment_added` activity entry and its audit rows in one transaction, so an
   * internal note can never be half-written into the thread.
   */
  addComment(write: NewCommentWrite): Promise<StoredComment>;
  listComments(criteria: CommentListCriteria): Promise<CommentPage>;
  /**
   * Lifecycle events and comments merged into one chronologically ordered feed. The comment markers
   * inside `request_events` are skipped in favour of the real comment rows, so nothing shows twice.
   */
  timeline(criteria: TimelineCriteria): Promise<TimelineRecord[]>;
  findCategory(id: string): Promise<TaxonomyRecord | undefined>;
  findSubCategory(
    id: string,
  ): Promise<(TaxonomyRecord & { readonly categoryId: string }) | undefined>;
  findDepartment(id: string): Promise<TaxonomyRecord | undefined>;
  /** Open (non-terminal) workload for an agent — used to reject a bad reassignment. */
  countOpenForAssignee(agentId: string): Promise<number>;
}
