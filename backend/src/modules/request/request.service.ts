import {
  allowedActionsFor,
  businessHoursSchema,
  requestDetailSchema,
  requestListItemSchema,
  resolveSort,
  type ActorContext,
  type AssignRequestBody,
  type CloseRequestBody,
  type CreateRequestBody,
  type ListRequestsQuery,
  type PatchRequestBody,
  type ReasonRequestBody,
  type RequestAction,
  type RequestDetail,
  type RequestEvent,
  type RequestListItem,
  type RequestPriority,
  type RequestStatus,
  type ResolveRequestBody,
  type ReopenRequestBody,
  type TransitionRequestBody,
  type UserRole,
} from '@esrs/shared';
import {
  can,
  canSeeInternalNotes,
  roleAtLeast,
  type RbacAction,
  type RbacActor,
} from '../../domain/rbac/policy.js';
import type { Clock } from '../../domain/ports/clock.js';
import { applyTransition, DomainRuleError } from '../../domain/request/stateMachine.js';
import { remainingBusinessMinutes, toWindow } from '../../domain/sla/businessHours.js';
import { AppError } from '../../lib/errors/appError.js';
import { conflict, forbidden, invalidTransition, notFound } from '../../lib/errors/httpErrors.js';
import type { AuditWrite } from '../../ports/audit.js';
import type { SlaService } from '../sla/sla.service.js';
import type { UserDirectory } from './request.directory.js';
import type {
  LifecycleEventWrite,
  RequestListCriteria,
  RequestRepository,
  RequestScope,
  StoredRequest,
  TrackerWrite,
  TransitionWrite,
  WriteOutcome,
} from './request.repository.js';

/**
 * Request lifecycle service (docs/requirements.md §6–§7; docs/api-specification.md §6).
 *
 * Responsibilities, in the order the code applies them:
 *
 *   1. **Row visibility** — an actor only ever reaches the rows their scope covers. A row that exists
 *      but sits outside the scope is answered `404 NOT_FOUND`, not `403`, so the API cannot be used
 *      to confirm which ticket ids are real (docs/security-plan.md §4).
 *   2. **Action permission** — the same RBAC actions the route gate uses, re-checked here because the
 *      generic `/transition` endpoint carries the action in its body, where no route can see it.
 *   3. **Lifecycle legality** — exclusively through `applyTransition()`, so this service and the
 *      shared transition table can never disagree about what a status change may do.
 *   4. **One atomic write** through the repository, which owns the transaction and the row lock.
 *   5. **The audit trail**, handed to that same repository write: the `audit_logs` rows are inserted
 *      on the transaction's own client, so a change and its audit entry commit or roll back together.
 *
 * The service *describes* each audit row and the adapter *stamps* it, because the subject id, the
 * allocated request number and the resulting version do not exist until the write has run. See
 * `src/ports/audit.ts` for the two audit paths and what each one guarantees.
 *
 * The SLA module is reached through `SlaService`, not its repository: services are the sanctioned
 * seam between modules (docs/system-architecture.md §2).
 */

/** A reopened ticket must be caught quickly: FR-12 allows seven days, then it stays closed. */
export const REOPEN_WINDOW_DAYS = 7;

/** Statuses a manager may no longer reprioritise — the workflow has finished. */
const NON_REPRIORITISABLE: readonly RequestStatus[] = ['closed', 'cancelled'];

/** Route-level gate per lifecycle action, mirrored here for the generic transition endpoint. */
const ACTION_PERMISSION: Record<RequestAction, RbacAction> = {
  submit: 'request.create',
  cancel: 'request.cancel',
  claim: 'request.claim',
  assign: 'request.assign',
  start: 'request.transition',
  hold: 'request.transition',
  resume: 'request.transition',
  resolve: 'request.resolve',
  close_confirm: 'request.close',
  reopen: 'request.reopen',
};

/** Payloads an action may carry; each endpoint passes the subset its own schema allows. */
export interface ActionInput {
  readonly reason?: string;
  readonly resolution_note?: string;
  readonly assignee_id?: string;
}

export interface RequestServiceDependencies {
  readonly repository: RequestRepository;
  readonly directory: UserDirectory;
  readonly clock: Clock;
  readonly sla: SlaService;
}

export interface ListResult {
  readonly items: RequestListItem[];
  readonly total: number;
}

export class RequestService {
  constructor(private readonly deps: RequestServiceDependencies) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async list(
    query: ListRequestsQuery,
    rawSortToken: unknown,
    actor: RbacActor,
  ): Promise<ListResult> {
    const order = resolveSort(query, rawSortToken);
    const criteria: RequestListCriteria = {
      page: query.page,
      pageSize: query.page_size,
      statuses: query.status ?? [],
      priorities: query.priority ?? [],
      categoryId: query.category_id ?? null,
      subCategoryId: query.sub_category_id ?? null,
      departmentId: query.department_id ?? null,
      requesterId: query.requester_id ?? null,
      assigneeId: resolveAssigneeFilter(query.assignee_id, actor.userId),
      unassigned: query.assignee_id === 'unassigned',
      sla: query.sla ?? null,
      search: query.q ?? null,
      sortKey: order.key,
      sortDescending: order.descending,
      scope: this.scopeFor(actor),
    };

    const page = await this.deps.repository.list(criteria);
    return {
      items: page.items.map((record) => this.toListItem(record, actor)),
      total: page.total,
    };
  }

  async get(id: string, actor: RbacActor): Promise<RequestDetail> {
    return this.toDetail(await this.requireVisible(id, actor), actor);
  }

  /**
   * `GET /requests/{id}/events` — the trail, scoped like the ticket itself. Lifecycle rows are never
   * filtered by role, but a `comment_added` marker describing an internal note is: it discloses that a
   * staff-only comment exists and how long it was, which is the note's own metadata (§7). Staff see
   * the marker exactly as the requester sees the public one.
   */
  async events(id: string, actor: RbacActor, limit: number): Promise<RequestEvent[]> {
    await this.requireVisible(id, actor);
    const rows = await this.deps.repository.events({
      requestId: id,
      includeInternal: canSeeInternalNotes(actor),
      limit,
    });
    return rows.map((row) => ({
      id: row.id,
      event_type: row.eventType,
      actor: row.actor ? { id: row.actor.id, full_name: row.actor.fullName } : null,
      actor_role: row.actorRole,
      from_status: row.fromStatus,
      to_status: row.toStatus,
      detail: row.detail,
      created_at: row.createdAt,
    }));
  }

  // -------------------------------------------------------------------------
  // Creation and editing
  // -------------------------------------------------------------------------

  async create(
    body: CreateRequestBody,
    actor: RbacActor,
    requestId?: string,
  ): Promise<RequestDetail> {
    const category = this.requireActive(
      await this.deps.repository.findCategory(body.category_id),
      'category_id',
      body.category_id,
      'Category is not available for new requests',
    );

    let subCategoryId: string | null = null;
    if (body.sub_category_id !== null && body.sub_category_id !== undefined) {
      const sub = this.requireActive(
        await this.deps.repository.findSubCategory(body.sub_category_id),
        'sub_category_id',
        body.sub_category_id,
        'Sub-category is not available',
      );
      if (sub.categoryId !== category.id) {
        throw issue('sub_category_id', 'Sub-category does not belong to the selected category');
      }
      subCategoryId = sub.id;
    }

    // The department is a snapshot taken when the ticket is raised (docs/database-design.md §2.3), so
    // a later transfer never rewrites history. It defaults to the requester's own department.
    const requester = await this.requireActiveActor(actor);
    const departmentId = body.department_id ?? requester.departmentId ?? null;
    if (departmentId) {
      this.requireActive(
        await this.deps.repository.findDepartment(departmentId),
        'department_id',
        departmentId,
        'Department does not exist',
      );
    }

    const now = this.deps.clock.now();
    const submitting = !body.draft;

    const record = await this.deps.repository.create({
      requesterId: actor.userId,
      categoryId: category.id,
      subCategoryId,
      departmentId,
      title: body.title,
      description: body.description,
      priority: body.priority,
      status: submitting ? 'submitted' : 'draft',
      at: now.toISOString(),
      tracker: submitting ? await this.buildTracker(body.priority, now) : null,
      actorId: actor.userId,
      actorRole: actor.role,
      audit: [
        ({ entityId, requestNumber }) => ({
          actorId: actor.userId,
          actorRole: actor.role,
          action: submitting ? 'request.submitted' : 'request.created',
          entityType: 'request',
          // The id comes from the row the adapter just wrote: `record` does not exist while this
          // closure is being evaluated, so the value must be read from the stamp, never from here.
          entityId,
          // Only what identifies the new ticket: the description and any attachment text stay out of
          // the audit trail, which is a pointer to the row, not a copy of it.
          after: {
            request_number: requestNumber,
            status: submitting ? 'submitted' : 'draft',
            priority: body.priority,
            category: category.name,
          },
          requestId,
        }),
      ],
    });

    return this.toDetail(record, actor);
  }

  /**
   * `PATCH /requests/{id}`.
   *
   * The body schema is `.strict()`, and that is what makes protected workflow fields impossible to
   * smuggle through this endpoint: `status`, `assignee_id`, `request_number`, `version` and
   * `resolution_note` are rejected as unknown keys with a 400 that names the key. On top of that,
   * content edits require ownership of a draft (ST-202) and `priority` requires manager+ (ST-304).
   */
  async edit(
    id: string,
    body: PatchRequestBody,
    actor: RbacActor,
    expectedVersion: number | null,
    requestId?: string,
  ): Promise<RequestDetail> {
    await this.requireActiveActor(actor);
    const record = await this.requireVisible(id, actor);

    if (body.priority !== undefined) {
      if (!roleAtLeast(actor, 'manager')) {
        throw forbidden('Only a manager or admin may change the priority of a request');
      }
      if (NON_REPRIORITISABLE.includes(record.status)) {
        throw conflict(`A ${record.status} request cannot be reprioritised`);
      }
      if (body.reason === undefined)
        throw issue('reason', 'A reason is required to change priority');
    }

    const touchesContent =
      body.title !== undefined ||
      body.description !== undefined ||
      body.category_id !== undefined ||
      body.sub_category_id !== undefined;

    if (touchesContent) {
      if (record.requester.id !== actor.userId) {
        throw forbidden('Only the requester can edit the content of this request');
      }
      if (record.status !== 'draft') {
        throw conflict(`Only a draft can be edited; this request is '${record.status}'`);
      }
      if (body.category_id !== undefined) {
        const category = this.requireActive(
          await this.deps.repository.findCategory(body.category_id),
          'category_id',
          body.category_id,
          'Category is not available for new requests',
        );
        if (body.sub_category_id) {
          const sub = await this.deps.repository.findSubCategory(body.sub_category_id);
          if (sub?.categoryId !== category.id) {
            throw issue('sub_category_id', 'Sub-category does not belong to the selected category');
          }
        }
      }
    }

    const event: LifecycleEventWrite | null =
      body.priority !== undefined && body.priority !== record.priority
        ? {
            eventType: 'priority_changed',
            detail: { from: record.priority, to: body.priority, reason: body.reason },
          }
        : null;

    const outcome = await this.deps.repository.edit({
      id,
      expectedVersion,
      patch: {
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.category_id === undefined ? {} : { categoryId: body.category_id }),
        ...(body.sub_category_id === undefined ? {} : { subCategoryId: body.sub_category_id }),
        ...(body.priority === undefined ? {} : { priority: body.priority }),
      },
      event,
      actorId: actor.userId,
      actorRole: actor.role,
      audit: [
        ({ entityId, version }) => ({
          actorId: actor.userId,
          actorRole: actor.role,
          action: 'request.updated',
          entityType: 'request',
          entityId,
          serviceRequestId: entityId,
          // The before image is the row this service read; the after image is the patch it asked for,
          // which the write has now applied. A rejected write never reaches this row at all.
          before: { title: record.title, priority: record.priority, status: record.status },
          after: {
            title: body.title ?? record.title,
            priority: body.priority ?? record.priority,
            category_id: body.category_id ?? record.category.id,
            status: record.status,
            version,
            ...(body.reason === undefined ? {} : { reason: body.reason }),
          },
          requestId,
        }),
      ],
    });

    return this.toDetail(this.unwrap(outcome, record), actor);
  }

  // -------------------------------------------------------------------------
  // Lifecycle actions
  // -------------------------------------------------------------------------

  /** Every action endpoint funnels through here, so there is exactly one status-change path. */
  async act(
    id: string,
    action: RequestAction,
    input: ActionInput,
    actor: RbacActor,
    expectedVersion: number | null,
    requestId?: string,
    extraAudit: readonly AuditWrite[] = [],
  ): Promise<RequestDetail> {
    await this.requireActiveActor(actor);
    const record = await this.requireVisible(id, actor);

    // Re-checked here, not only at the route: `/transition` carries the action in its body, so no
    // route-level middleware can see which permission the call actually needs.
    if (!can(actor, ACTION_PERMISSION[action])) {
      throw forbidden(`Role '${actor.role}' may not ${action} a request`);
    }

    const targetAssignee = await this.resolveTargetAssignee(action, record, input, actor);
    if (action === 'reopen') this.assertReopenWindow(record);

    const result = this.apply(record, action, actor, expectedVersion, input);
    const assigneeChanged = targetAssignee !== (record.assignee?.id ?? null);

    const write: TransitionWrite = {
      id,
      expectedVersion,
      fromStatus: result.fromStatus,
      toStatus: result.toStatus,
      assigneeId: targetAssignee,
      statusReason: result.reason ?? null,
      resolutionNote: input.resolution_note ?? null,
      timestamps: timestampsFor(action, this.deps.clock.now()),
      clearTimestamps: clearsFor(action),
      incrementReopen: action === 'reopen',
      // The number is allocated on the first step out of `draft` and never re-issued afterwards
      // (docs/database-design.md §5), inside this same transaction.
      allocateNumberYear:
        result.toStatus !== 'draft' && record.requestNumber === null
          ? this.deps.clock.now().getUTCFullYear()
          : null,
      event: {
        eventType: result.eventType,
        detail: eventDetail(input, targetAssignee, record),
      },
      closeOpenAssignment: assigneeChanged,
      // An assignment row is only opened for a real holder; moving to `unassigned` closes the current
      // row without inserting one, which is what `assignments.agent_id NOT NULL` requires.
      assignment:
        assigneeChanged && targetAssignee !== null
          ? { agentId: targetAssignee, reason: assignmentReason(action, record.assignee) }
          : null,
      tracker: await this.trackerFor(action, record),
      actorId: actor.userId,
      actorRole: actor.role,
      audit: [
        ({ entityId, version }) => ({
          actorId: actor.userId,
          actorRole: actor.role,
          action: `request.${action}`,
          entityType: 'request',
          entityId,
          serviceRequestId: entityId,
          before: { status: result.fromStatus, assignee_id: record.assignee?.id ?? null },
          after: {
            status: result.toStatus,
            assignee_id: targetAssignee,
            reason: result.reason,
            version,
          },
          requestId,
        }),
        // Action-specific rows that need a figure the transition itself cannot supply (the assign
        // workload) ride on the same transaction rather than being recorded after it.
        ...extraAudit,
      ],
    };

    return this.toDetail(this.unwrap(await this.deps.repository.transition(write), record), actor);
  }

  // Typed wrappers so each route reads like the story it implements.

  submit(id: string, actor: RbacActor, version: number | null, requestId?: string) {
    return this.act(id, 'submit', {}, actor, version, requestId);
  }

  claim(id: string, actor: RbacActor, version: number | null, requestId?: string) {
    return this.act(id, 'claim', {}, actor, version, requestId);
  }

  async assign(
    id: string,
    body: AssignRequestBody,
    actor: RbacActor,
    version: number | null,
    requestId?: string,
  ): Promise<RequestDetail> {
    // Workload is reported, not capped, at assign time. The hard rule (`ASSIGNEE_HAS_OPEN_TICKETS`)
    // belongs to user deactivation (BR-4), which is a different module. Read before the transition, so
    // the figure is the agent's queue *before* this ticket lands in it — and so the row can be written
    // inside the transition's own transaction instead of patched in afterwards.
    const open = await this.deps.repository.countOpenForAssignee(body.assignee_id);
    return this.act(id, 'assign', body, actor, version, requestId, [
      ({ entityId }) => ({
        actorId: actor.userId,
        actorRole: actor.role,
        action: 'request.assigned',
        entityType: 'request',
        entityId,
        serviceRequestId: entityId,
        after: {
          assignee_id: body.assignee_id,
          assignee_open_tickets_before: open,
          reason: body.reason,
        },
        requestId,
      }),
    ]);
  }

  resolve(
    id: string,
    body: ResolveRequestBody,
    actor: RbacActor,
    version: number | null,
    requestId?: string,
  ) {
    return this.act(id, 'resolve', body, actor, version, requestId);
  }

  close(
    id: string,
    body: CloseRequestBody,
    actor: RbacActor,
    version: number | null,
    requestId?: string,
  ) {
    return this.act(id, 'close_confirm', body, actor, version, requestId);
  }

  reopen(
    id: string,
    body: ReopenRequestBody,
    actor: RbacActor,
    version: number | null,
    requestId?: string,
  ) {
    return this.act(id, 'reopen', body, actor, version, requestId);
  }

  hold(
    id: string,
    body: ReasonRequestBody,
    actor: RbacActor,
    version: number | null,
    requestId?: string,
  ) {
    return this.act(id, 'hold', body, actor, version, requestId);
  }

  resume(id: string, actor: RbacActor, version: number | null, requestId?: string) {
    return this.act(id, 'resume', {}, actor, version, requestId);
  }

  start(id: string, actor: RbacActor, version: number | null, requestId?: string) {
    return this.act(id, 'start', {}, actor, version, requestId);
  }

  cancel(
    id: string,
    body: ReasonRequestBody,
    actor: RbacActor,
    version: number | null,
    requestId?: string,
  ) {
    return this.act(id, 'cancel', body, actor, version, requestId);
  }

  transition(
    id: string,
    body: TransitionRequestBody,
    actor: RbacActor,
    version: number | null,
    requestId?: string,
  ) {
    return this.act(id, body.action, body, actor, version, requestId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Runs the shared transition table and translates every failure into the contract's error code, so
   * no route has to know how the state machine reports a problem.
   */
  private apply(
    record: StoredRequest,
    action: RequestAction,
    actor: RbacActor,
    expectedVersion: number | null,
    input: ActionInput,
  ) {
    try {
      return applyTransition(
        {
          status: record.status,
          version: record.version,
          requesterId: record.requester.id,
          assigneeId: record.assignee?.id ?? null,
        },
        {
          action,
          actorId: actor.userId,
          actorRole: actor.role as UserRole,
          ...(expectedVersion === null ? {} : { expectedVersion }),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      );
    } catch (error) {
      if (error instanceof DomainRuleError) {
        switch (error.kind) {
          case 'NOT_PERMITTED':
            throw forbidden(error.message);
          case 'REASON_REQUIRED':
            throw issue('reason', error.message);
          case 'VERSION_CONFLICT':
            throw conflict(error.message, [
              { path: 'version', message: `current version is ${record.version}` },
            ]);
          case 'INVALID_TRANSITION':
            throw invalidTransition(record.status, action);
        }
      }
      // `transitionFor()` throws the shared package's own error type for an illegal move.
      if (error instanceof Error && error.name === 'InvalidTransitionError') {
        throw invalidTransition(record.status, action);
      }
      throw error;
    }
  }

  /**
   * Who holds the ticket after this action. A claim takes it, an assign moves it, and every other
   * action — including resolve and reopen — leaves the current holder in place.
   */
  private async resolveTargetAssignee(
    action: RequestAction,
    record: StoredRequest,
    input: ActionInput,
    actor: RbacActor,
  ): Promise<string | null> {
    if (action === 'claim') return actor.userId;
    if (action !== 'assign') return record.assignee?.id ?? null;

    const targetId = input.assignee_id;
    if (!targetId) throw issue('assignee_id', 'assignee_id is required to assign a request');

    const target = await this.deps.directory.findById(targetId);
    if (!target?.isActive) {
      throw new AppError('INVALID_ASSIGNEE', `User '${targetId}' is not an assignable account`);
    }
    if (target.role === 'employee') {
      throw new AppError(
        'INVALID_ASSIGNEE',
        `User '${targetId}' has role 'employee' and cannot hold tickets`,
      );
    }
    // Team scoping (ST-301): an agent may only be given work their team owns. A manager without a
    // team is not restricted, because `team_category_id` is NULL for them by design.
    if (target.teamCategoryId !== null && target.teamCategoryId !== record.category.id) {
      throw new AppError(
        'INVALID_ASSIGNEE',
        `User '${targetId}' belongs to a different team than the request category '${record.category.name}'`,
      );
    }
    return targetId;
  }

  private assertReopenWindow(record: StoredRequest): void {
    const closedAt = record.closedAt ?? record.resolvedAt;
    if (!closedAt) return;
    const deadline = new Date(closedAt).getTime() + REOPEN_WINDOW_DAYS * 86_400_000;
    if (this.deps.clock.now().getTime() > deadline) {
      throw new AppError(
        'REOPEN_WINDOW_EXPIRED',
        `A request can be reopened within ${REOPEN_WINDOW_DAYS} days of resolution; raise a new one instead`,
      );
    }
  }

  /** The tracker changes that accompany a transition, written in the very same transaction. */
  private async trackerFor(
    action: RequestAction,
    record: StoredRequest,
  ): Promise<TrackerWrite | null> {
    if (action === 'submit') {
      return this.buildTracker(record.priority, this.deps.clock.now());
    }
    const tracker = record.sla;
    if (!tracker) return null;

    const shape = {
      submittedAt:
        record.submittedAt ?? tracker.firstResponseDueAt ?? this.deps.clock.now().toISOString(),
      firstResponseDueAt: tracker.firstResponseDueAt,
      resolutionDueAt: tracker.resolutionDueAt,
      policySnapshot: tracker.policySnapshot,
    };

    switch (action) {
      // The original clock resumes rather than restarting (FR-12), with the alerts re-armed.
      case 'reopen':
        return { ...shape, resume: true };
      case 'resolve':
        return {
          ...shape,
          markFirstResponse: true,
          completionStatus: isBreached(tracker.resolutionDueAt, this.deps.clock.now())
            ? 'breached'
            : 'met',
        };
      // The first response is any agent touching the ticket; the column is filled once and kept.
      case 'claim':
      case 'assign':
      case 'start':
        return { ...shape, markFirstResponse: true };
      default:
        return null;
    }
  }

  private async buildTracker(priority: RequestPriority, submittedAt: Date): Promise<TrackerWrite> {
    const policy = await this.deps.sla.getPolicy(priority);
    const due = this.deps.sla.computeDueDates(submittedAt, policy);
    return {
      submittedAt: submittedAt.toISOString(),
      firstResponseDueAt: due.first_response_due_at,
      resolutionDueAt: due.resolution_due_at,
      // Frozen in the column's own shape (`*_mins`) so the tracker outlives any later policy edit.
      policySnapshot: {
        priority,
        first_response_mins: policy.first_response_minutes,
        resolution_mins: policy.resolution_minutes,
        business_hours: policy.business_hours,
      },
    };
  }

  private scopeFor(actor: RbacActor): RequestScope {
    if (roleAtLeast(actor, 'manager')) return { kind: 'all', userId: actor.userId };
    if (actor.role === 'agent') {
      return { kind: 'team', userId: actor.userId, teamCategoryId: actor.teamCategoryId ?? null };
    }
    return { kind: 'requester', userId: actor.userId };
  }

  /** The same rule the repository's scope predicate applies, evaluated on one loaded row. */
  private isVisible(record: StoredRequest, scope: RequestScope): boolean {
    switch (scope.kind) {
      case 'all':
        return record.status !== 'draft' || record.requester.id === scope.userId;
      case 'requester':
        return record.requester.id === scope.userId;
      case 'team':
        return (
          record.requester.id === scope.userId ||
          record.assignee?.id === scope.userId ||
          (record.status !== 'draft' &&
            scope.teamCategoryId !== null &&
            record.category.id === scope.teamCategoryId)
        );
    }
  }

  /**
   * Row-level read gate, public because the comment and timeline endpoints are the same object-level
   * rule applied to child rows: if you cannot see the ticket, you cannot see its thread either. An
   * out-of-scope id is a 404, never a 403, so the API cannot be used to enumerate request ids.
   */
  async requireVisible(id: string, actor: RbacActor): Promise<StoredRequest> {
    const record = await this.deps.repository.find(id);
    if (!record || !this.isVisible(record, this.scopeFor(actor))) {
      throw notFound(`Request '${id}'`);
    }
    return record;
  }

  private unwrap(outcome: WriteOutcome, record: StoredRequest): StoredRequest {
    switch (outcome.kind) {
      case 'applied':
        return outcome.request;
      case 'not_found':
        throw notFound(`Request '${record.id}'`);
      case 'version_conflict':
        throw conflict(
          `This request changed while you were working on it (expected version ${record.version}, now ${outcome.currentVersion})`,
          [{ path: 'version', message: `current version is ${outcome.currentVersion}` }],
        );
    }
  }

  /** A taxonomy row must exist and still be offered; either failure is a field-level 400. */
  private requireActive<T extends { id: string; isActive: boolean }>(
    found: T | undefined,
    path: string,
    id: string,
    inactiveMessage: string,
  ): T {
    if (!found) throw issue(path, `Unknown ${path} '${id}'`);
    if (!found.isActive) throw issue(path, inactiveMessage);
    return found;
  }

  /**
   * The JWT gate verifies a token without a user lookup (docs/security-plan.md §3), so a deactivated
   * account can still hold a short-lived token. Every write re-reads the actor here: this is the
   * "caught at the next privileged read" step that design note promises.
   */
  async requireActiveActor(actor: RbacActor) {
    const record = await this.deps.directory.findById(actor.userId);
    if (!record?.isActive) {
      throw forbidden('This account is no longer active');
    }
    return record;
  }

  private actorContext(record: StoredRequest, actor: RbacActor): ActorContext {
    return {
      role: actor.role as UserRole,
      isRequester: record.requester.id === actor.userId,
      isAssignee: record.assignee !== null && record.assignee.id === actor.userId,
    };
  }

  private toListItem(record: StoredRequest, actor: RbacActor): RequestListItem {
    return requestListItemSchema.parse({
      id: record.id,
      request_number: record.requestNumber,
      title: record.title,
      status: record.status,
      priority: record.priority,
      category: { id: record.category.id, name: record.category.name },
      sub_category: record.subCategory
        ? { id: record.subCategory.id, name: record.subCategory.name }
        : null,
      requester: { id: record.requester.id, full_name: record.requester.fullName },
      assignee: record.assignee
        ? { id: record.assignee.id, full_name: record.assignee.fullName }
        : null,
      department: record.department
        ? { id: record.department.id, name: record.department.name }
        : null,
      submitted_at: record.submittedAt,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      resolved_at: record.resolvedAt,
      closed_at: record.closedAt,
      reopen_count: record.reopenCount,
      // The list carries the urgency the database derived from the persisted tracker flags. The exact
      // remaining-business-minutes figure needs per-row time-zone arithmetic and is therefore only
      // computed by the detail endpoint — see docs/api-specification.md §6.
      sla: record.sla
        ? {
            first_response_due_at: record.sla.firstResponseDueAt,
            resolution_due_at: record.sla.resolutionDueAt,
            resolution_business_minutes_remaining: null,
            state: record.sla.state,
          }
        : null,
      version: record.version,
      allowed_actions: allowedActionsFor(record.status, this.actorContext(record, actor)),
    });
  }

  private toDetail(record: StoredRequest, actor: RbacActor): RequestDetail {
    return requestDetailSchema.parse({
      ...this.toListItem(record, actor),
      description: record.description,
      status_reason: record.statusReason,
      resolution_note: record.resolutionNote,
      cancelled_at: record.cancelledAt,
      requester_inactive: record.requesterInactive,
      reopened_from: record.reopenedFrom,
      can_comment: record.requester.id === actor.userId || roleAtLeast(actor, 'agent'),
      sla: this.slaSummary(record),
    });
  }

  /**
   * Business-time view of the tracker, recomputed on every read from the row's frozen snapshot rather
   * than from whatever the policy table says today (ST-404).
   */
  private slaSummary(record: StoredRequest): RequestDetail['sla'] {
    const tracker = record.sla;
    if (!tracker) return null;

    const hours = businessHoursSchema.safeParse(tracker.policySnapshot.business_hours);
    let remaining: number | null = null;
    if (hours.success && tracker.resolutionDueAt) {
      remaining = remainingBusinessMinutes(
        this.deps.clock.now(),
        new Date(tracker.resolutionDueAt),
        toWindow(hours.data),
      );
    }

    return {
      first_response_due_at: tracker.firstResponseDueAt,
      resolution_due_at: tracker.resolutionDueAt,
      resolution_business_minutes_remaining: remaining,
      state: tracker.state,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A 400 `VALIDATION_ERROR` pointing at one field, in the same shape a Zod failure produces. */
function issue(path: string, message: string): AppError {
  return new AppError('VALIDATION_ERROR', 'Invalid request payload', {
    details: [{ path, message }],
  });
}

function assignmentReason(
  action: RequestAction,
  previous: StoredRequest['assignee'],
): 'claim' | 'manager_assign' | 'reassign' | 'reopened' {
  if (action === 'claim') return 'claim';
  if (previous === null) return action === 'reopen' ? 'reopened' : 'manager_assign';
  return 'reassign';
}

function resolveAssigneeFilter(
  filter: ListRequestsQuery['assignee_id'],
  userId: string,
): string | null {
  if (!filter || filter === 'unassigned') return null;
  return filter === 'me' ? userId : filter;
}

function timestampsFor(action: RequestAction, now: Date): TransitionWrite['timestamps'] {
  const at = now.toISOString();
  switch (action) {
    case 'submit':
      return { submittedAt: at };
    case 'resolve':
      return { resolvedAt: at };
    case 'close_confirm':
      return { closedAt: at };
    case 'cancel':
      return { cancelledAt: at };
    default:
      return {};
  }
}

/**
 * A reopen must not leave the row stamped as resolved or closed: `status` says the ticket is being
 * worked on again, so the closure times go back to NULL. The original times survive in
 * `request_events`, which is append-only.
 */
function clearsFor(action: RequestAction): TransitionWrite['clearTimestamps'] {
  return action === 'reopen' ? ['resolvedAt', 'closedAt', 'cancelledAt'] : [];
}

function eventDetail(
  input: ActionInput,
  assigneeId: string | null,
  record: StoredRequest,
): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  if (input.reason) detail.reason = input.reason;
  if (input.resolution_note) detail.resolution_note = input.resolution_note;
  if (assigneeId && assigneeId !== record.assignee?.id) detail.assignee_id = assigneeId;
  return detail;
}

function isBreached(resolutionDueAt: string | null, now: Date): boolean {
  if (!resolutionDueAt) return false;
  return new Date(resolutionDueAt).getTime() < now.getTime();
}
