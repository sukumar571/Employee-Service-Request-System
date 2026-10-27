import type { RequestPriority, RequestStatus, SlaState } from '@esrs/shared';
import { REQUEST_PRIORITIES } from '@esrs/shared';
import type { Clock } from '../../domain/ports/clock.js';
import { AppError } from '../../lib/errors/appError.js';
import {
  resolveAuditWrite,
  type AuditSink,
  type AuditWrite,
  type WrittenRow,
} from '../../ports/audit.js';
import type { UserDirectory } from './request.directory.js';
import type {
  CommentListCriteria,
  CommentPage,
  EventListCriteria,
  NewCommentWrite,
  NewRequestWrite,
  RequestEditWrite,
  RequestEventRecord,
  RequestListCriteria,
  RequestPage,
  RequestRepository,
  RequestScope,
  StoredComment,
  StoredRequest,
  TaxonomyRecord,
  TimelineCriteria,
  TimelineRecord,
  TrackerWrite,
  TransitionWrite,
  WriteOutcome,
} from './request.repository.js';

/**
 * In-memory adapter used when `DATABASE_URL` is absent and by the HTTP test suite.
 *
 * It is a faithful stand-in rather than a toy: it applies the same row-visibility scope, the same
 * filter/sort/search semantics, the same optimistic-version rule and the same multi-record write
 * (parent row + assignment + event + tracker + comment + gapless number) as the Postgres adapter, so a
 * test that passes here describes real database behaviour. The two things it cannot model are two
 * writers racing, which is why the Postgres path additionally takes a `FOR UPDATE` row lock, and a
 * partial failure: a Map assignment does not roll back, so the atomicity of a write (audit row
 * included) is only ever proven against the SQL adapter.
 *
 * Audit entries go to the same `AuditSink` the services use, resolved through `resolveAuditWrite` —
 * the identical helper the Postgres adapter applies — so both modes report the same trail.
 */
export class InMemoryRequestRepository implements RequestRepository {
  private readonly rows = new Map<string, StoredRequest>();
  private readonly history = new Map<string, RequestEventRecord[]>();
  private readonly comments = new Map<string, StoredComment[]>();
  private readonly numbers = new Map<number, number>();
  private readonly categories = new Map<string, TaxonomyRecord>();
  private readonly subCategories = new Map<string, TaxonomyRecord & { categoryId: string }>();
  private readonly departments = new Map<string, TaxonomyRecord>();
  private sequence = 0;
  private commentSequence = 0;

  constructor(
    private readonly deps: {
      readonly clock: Clock;
      readonly directory?: UserDirectory;
      readonly taxonomy?: TaxonomySeed;
      readonly audit?: AuditSink;
    },
  ) {
    for (const record of deps.taxonomy?.categories ?? defaultTaxonomy().categories) {
      this.categories.set(record.id, record);
    }
    for (const record of deps.taxonomy?.subCategories ?? defaultTaxonomy().subCategories) {
      this.subCategories.set(record.id, record);
    }
    for (const record of deps.taxonomy?.departments ?? defaultTaxonomy().departments) {
      this.departments.set(record.id, record);
    }
  }

  // Only `create` and `transition` await (they resolve display names through the directory port).
  // The rest return settled promises, so `@typescript-eslint/require-await` does not have to be
  // satisfied by an `await Promise.resolve()` that would change nothing.
  list(criteria: RequestListCriteria): Promise<RequestPage> {
    const visible = [...this.rows.values()]
      .filter((row) => matchesScope(row, criteria.scope))
      .filter((row) => criteria.statuses.length === 0 || criteria.statuses.includes(row.status))
      .filter(
        (row) => criteria.priorities.length === 0 || criteria.priorities.includes(row.priority),
      )
      .filter((row) => equalsOrUnset(criteria.categoryId, row.category.id))
      .filter((row) => equalsOrUnset(criteria.subCategoryId, row.subCategory?.id ?? null))
      .filter((row) => equalsOrUnset(criteria.departmentId, row.department?.id ?? null))
      .filter((row) => equalsOrUnset(criteria.requesterId, row.requester.id))
      .filter((row) => (criteria.unassigned ? row.assignee === null : true))
      .filter(
        (row) =>
          !criteria.assigneeId ||
          (row.assignee !== null && row.assignee.id === criteria.assigneeId),
      )
      .filter((row) => !criteria.sla || row.sla?.state === criteria.sla)
      .filter((row) => matchesSearch(row, criteria.search));

    const sorted = [...visible].sort((left, right) =>
      compare(left, right, criteria.sortKey, criteria.sortDescending),
    );
    const offset = (criteria.page - 1) * criteria.pageSize;
    return Promise.resolve({
      items: sorted.slice(offset, offset + criteria.pageSize),
      total: sorted.length,
    });
  }

  find(id: string): Promise<StoredRequest | undefined> {
    return Promise.resolve(this.rows.get(id));
  }

  async create(write: NewRequestWrite): Promise<StoredRequest> {
    const at = write.at;
    const submitted = write.status === 'submitted';
    const id = String(++this.sequence);
    const record: StoredRequest = {
      id,
      requestNumber: submitted ? this.nextNumber(at) : null,
      requester: await this.party(write.requesterId),
      assignee: null,
      category: taxonomy(this.categories, write.categoryId, 'category'),
      subCategory: write.subCategoryId
        ? taxonomy(this.subCategories, write.subCategoryId, 'sub_category')
        : null,
      department: write.departmentId
        ? taxonomy(this.departments, write.departmentId, 'department')
        : null,
      title: write.title,
      description: write.description,
      status: write.status,
      priority: write.priority,
      statusReason: null,
      resolutionNote: null,
      submittedAt: submitted ? at : null,
      resolvedAt: null,
      closedAt: null,
      cancelledAt: null,
      reopenedFrom: null,
      reopenCount: 0,
      requesterInactive: false,
      // A submitted request is written once by the pipeline and then transitions, so it starts at 1:
      // the number, tracker and event arrived with the row, and a later `If-Match` must reflect that.
      version: submitted ? 1 : 0,
      createdAt: at,
      updatedAt: at,
      sla: submitted && write.tracker ? toStoredSla(write.tracker, 'safe') : null,
    };
    this.rows.set(id, record);
    await this.pushEvent(id, write.actorId, write.actorRole, 'created', at, {
      priority: write.priority,
      draft: !submitted,
    });
    if (submitted) {
      await this.pushEvent(id, write.actorId, write.actorRole, 'submitted', at, {
        request_number: record.requestNumber,
      });
    }
    await this.recordAudit(write.audit, {
      entityId: record.id,
      requestNumber: record.requestNumber,
      version: record.version,
      at,
    });
    return record;
  }

  async edit(write: RequestEditWrite): Promise<WriteOutcome> {
    const current = this.rows.get(write.id);
    if (!current) return { kind: 'not_found' };
    const conflict = checkVersion(current.version, write.expectedVersion);
    if (conflict) return conflict;

    // Same rule as the SQL adapter: a patch that names no field changes nothing, so it neither bumps
    // the version nor writes an event or an audit row.
    if (Object.keys(write.patch).length === 0) return { kind: 'applied', request: current };

    const patch = write.patch;
    const updated: StoredRequest = {
      ...current,
      title: patch.title ?? current.title,
      description: patch.description ?? current.description,
      category: patch.categoryId
        ? taxonomy(this.categories, patch.categoryId, 'category')
        : current.category,
      subCategory:
        patch.subCategoryId === undefined
          ? current.subCategory
          : patch.subCategoryId === null
            ? null
            : taxonomy(this.subCategories, patch.subCategoryId, 'sub_category'),
      priority: patch.priority ?? current.priority,
      version: current.version + 1,
      updatedAt: this.deps.clock.now().toISOString(),
    };
    this.rows.set(write.id, updated);
    if (write.event) {
      await this.pushEvent(
        write.id,
        write.actorId,
        write.actorRole,
        write.event.eventType,
        updated.updatedAt,
        write.event.detail,
      );
    }
    await this.recordAudit(write.audit, auditRow(updated, updated.updatedAt));
    return { kind: 'applied', request: updated };
  }

  async transition(write: TransitionWrite): Promise<WriteOutcome> {
    const current = this.rows.get(write.id);
    if (!current) return { kind: 'not_found' };
    const conflict = checkVersion(current.version, write.expectedVersion);
    if (conflict) return conflict;

    const at = this.deps.clock.now().toISOString();
    const assignee =
      write.assigneeId === null
        ? null
        : write.assigneeId === current.assignee?.id
          ? current.assignee
          : await this.party(write.assigneeId);
    const requestNumber =
      current.requestNumber ?? (write.allocateNumberYear !== null ? this.nextNumber(at) : null);
    const cleared = (field: string): boolean =>
      (write.clearTimestamps as readonly string[]).includes(field);

    const next: StoredRequest = {
      ...current,
      status: write.toStatus,
      assignee,
      statusReason: write.statusReason,
      resolutionNote: write.resolutionNote ?? current.resolutionNote,
      submittedAt:
        write.timestamps.submittedAt ?? (cleared('submittedAt') ? null : current.submittedAt),
      resolvedAt:
        write.timestamps.resolvedAt ?? (cleared('resolvedAt') ? null : current.resolvedAt),
      closedAt: write.timestamps.closedAt ?? (cleared('closedAt') ? null : current.closedAt),
      cancelledAt:
        write.timestamps.cancelledAt ?? (cleared('cancelledAt') ? null : current.cancelledAt),
      requestNumber,
      reopenCount: write.incrementReopen ? current.reopenCount + 1 : current.reopenCount,
      version: current.version + 1,
      updatedAt: at,
      sla: write.tracker
        ? toStoredSla(write.tracker, write.tracker.resume ? 'safe' : (current.sla?.state ?? 'safe'))
        : recomputeState(current.sla, write.toStatus, at),
    };

    if (next.requestNumber === null && next.status !== 'draft') {
      // Mirrors `number_or_draft`: a non-draft row without a number is a data defect, not a state.
      throw new AppError('INTERNAL', 'Transition left the request without a number');
    }

    this.rows.set(write.id, next);

    // The assignment history lives in the event log here; Postgres keeps the parallel
    // `assignments` rows, which is what makes "who held this ticket on <date>" answerable in SQL.
    // The order matches the SQL adapter: the transition event first, then the `unassigned` marker,
    // so both adapters replay the same trail for the same sequence of calls.
    await this.pushEvent(
      write.id,
      write.actorId,
      write.actorRole,
      write.event.eventType,
      at,
      write.event.detail,
      { from: write.fromStatus, to: write.toStatus },
    );

    const assigneeChanged = (current.assignee?.id ?? null) !== (next.assignee?.id ?? null);
    if (assigneeChanged && next.assignee === null) {
      await this.pushEvent(write.id, write.actorId, write.actorRole, 'unassigned', at, {});
    }

    await this.recordAudit(write.audit, auditRow(next, at));
    return { kind: 'applied', request: next };
  }

  async addComment(write: NewCommentWrite): Promise<StoredComment> {
    const parent = this.rows.get(write.requestId);
    if (!parent) {
      throw new AppError('VALIDATION_ERROR', `Unknown request id '${write.requestId}'`);
    }
    const comment: StoredComment = {
      id: String(++this.commentSequence),
      requestId: write.requestId,
      author: await this.party(write.authorId),
      body: write.body,
      visibility: write.visibility,
      isPostClosure: write.isPostClosure,
      createdAt: write.at,
      updatedAt: write.at,
    };
    const thread = this.comments.get(write.requestId) ?? [];
    thread.push(comment);
    this.comments.set(write.requestId, thread);

    // The marker describes the comment without repeating it, exactly as the SQL adapter's event does:
    // the body lives in the thread only, so the activity trail never becomes a second copy of it.
    await this.pushEvent(
      write.requestId,
      write.authorId,
      write.authorRole,
      write.event.eventType,
      write.at,
      { comment_id: comment.id, ...write.event.detail },
    );
    await this.recordAudit(write.audit, {
      entityId: comment.id,
      serviceRequestId: write.requestId,
      requestNumber: parent.requestNumber,
      version: parent.version,
      at: write.at,
    });
    return comment;
  }

  listComments(criteria: CommentListCriteria): Promise<CommentPage> {
    const thread = (this.comments.get(criteria.requestId) ?? []).filter(
      (row) => criteria.includeInternal || row.visibility === 'public',
    );
    return Promise.resolve({
      items: thread.slice(criteria.offset, criteria.offset + criteria.limit),
      total: thread.length,
    });
  }

  /**
   * The same merged feed the SQL `UNION ALL` builds, with the same ordering rule: instant first, then
   * source (events before comments), then id. `comment_added` markers are dropped in favour of the
   * comment rows themselves, so nothing appears twice.
   */
  timeline(criteria: TimelineCriteria): Promise<TimelineRecord[]> {
    const events: TimelineRecord[] = (this.history.get(criteria.requestId) ?? [])
      .filter((row) => row.eventType !== 'comment_added')
      .map((row) => ({ kind: 'event' as const, ...row }));
    return Promise.all(
      (this.comments.get(criteria.requestId) ?? [])
        .filter((row) => criteria.includeInternal || row.visibility === 'public')
        .map(async (row): Promise<TimelineRecord> => ({
          kind: 'comment',
          id: row.id,
          eventType: 'comment_added',
          actor: row.author,
          // The SQL adapter reads `author.role` from the users table, i.e. the role the author holds
          // now — `comments` stores no role snapshot. Resolved the same way here, and the limitation
          // is documented in docs/database-design.md §2.6.
          actorRole: (await this.deps.directory?.findById(row.author.id))?.role ?? 'employee',
          fromStatus: null,
          toStatus: null,
          detail: {
            comment_id: row.id,
            visibility: row.visibility,
            is_post_closure: row.isPostClosure,
            body: row.body,
          },
          createdAt: row.createdAt,
        })),
    ).then((comments) => [...events, ...comments].sort(compareTimeline).slice(0, criteria.limit));
  }

  /**
   * The same rule the SQL predicate applies: lifecycle rows always survive, the marker of an internal
   * note does not reach a caller who may not read the note itself.
   */
  events(criteria: EventListCriteria): Promise<RequestEventRecord[]> {
    const trail = (this.history.get(criteria.requestId) ?? []).filter(
      (row) => criteria.includeInternal || !isInternalCommentMarker(row),
    );
    return Promise.resolve(trail.slice(0, criteria.limit));
  }

  findCategory(id: string): Promise<TaxonomyRecord | undefined> {
    return Promise.resolve(this.categories.get(id));
  }

  findSubCategory(id: string): Promise<(TaxonomyRecord & { categoryId: string }) | undefined> {
    return Promise.resolve(this.subCategories.get(id));
  }

  findDepartment(id: string): Promise<TaxonomyRecord | undefined> {
    return Promise.resolve(this.departments.get(id));
  }

  countOpenForAssignee(agentId: string): Promise<number> {
    const open: RequestStatus[] = ['submitted', 'assigned', 'in_progress', 'on_hold'];
    return Promise.resolve(
      [...this.rows.values()].filter(
        (row) => open.includes(row.status) && row.assignee?.id === agentId,
      ).length,
    );
  }

  /** Registers a taxonomy row (tests and the seed path) without touching the database. */
  addTaxonomy(
    kind: 'category' | 'sub_category' | 'department',
    record: TaxonomyRecord & { categoryId?: string },
  ): void {
    if (kind === 'category') this.categories.set(record.id, record);
    if (kind === 'department') this.departments.set(record.id, record);
    if (kind === 'sub_category') {
      this.subCategories.set(record.id, { ...record, categoryId: record.categoryId ?? '' });
    }
  }

  private async party(id: string): Promise<{ id: string; fullName: string }> {
    const user = await this.deps.directory?.findById(id);
    return { id, fullName: user?.fullName ?? `User ${id}` };
  }

  /**
   * Mirrors `insertAuditWrites()` on the SQL path: the adapter resolves each described entry against
   * the row it just wrote and hands it to the sink. In Postgres this happens on the transaction's own
   * client; here there is no transaction to join, which is the one audit guarantee memory mode cannot
   * reproduce (see the rollback test, which drives the SQL adapter with a failing fake pool).
   */
  private async recordAudit(writes: readonly AuditWrite[], row: WrittenRow): Promise<void> {
    for (const write of writes) {
      await this.deps.audit?.record(resolveAuditWrite(write, row));
    }
  }

  private nextNumber(at: string): string {
    const year = new Date(at).getUTCFullYear();
    const sequence = (this.numbers.get(year) ?? 0) + 1;
    this.numbers.set(year, sequence);
    return `REQ-${year}-${String(sequence).padStart(6, '0')}`;
  }

  /**
   * Actor names are resolved through the same directory port as the requester/assignee, so a history
   * row shows "Priya Sharma" rather than an id — matching the `LEFT JOIN users` the SQL adapter does.
   */
  private async pushEvent(
    requestId: string,
    actorId: string,
    actorRole: string,
    eventType: string,
    at: string,
    detail: Record<string, unknown>,
    status?: { readonly from: RequestStatus | null; readonly to: RequestStatus | null },
  ): Promise<void> {
    const list = this.history.get(requestId) ?? [];
    list.push({
      id: String(list.length + 1),
      eventType,
      actor: await this.party(actorId),
      actorRole,
      // Written as an explicit pair, exactly like the SQL adapter's `from_status`/`to_status` columns:
      // only a transition has a pair, so creation and note events leave both null.
      fromStatus: status?.from ?? null,
      toStatus: status?.to ?? null,
      detail,
      createdAt: at,
    });
    this.history.set(requestId, list);
  }
}

// ---------------------------------------------------------------------------
// Query semantics shared with the SQL adapter
// ---------------------------------------------------------------------------

function matchesScope(row: StoredRequest, scope: RequestScope): boolean {
  switch (scope.kind) {
    case 'all':
      return row.status !== 'draft' || row.requester.id === scope.userId;
    case 'requester':
      return row.requester.id === scope.userId;
    case 'team': {
      if (row.requester.id === scope.userId || row.assignee?.id === scope.userId) return true;
      return (
        row.status !== 'draft' &&
        scope.teamCategoryId !== null &&
        row.category.id === scope.teamCategoryId
      );
    }
  }
}

function equalsOrUnset(expected: string | null, actual: string | null): boolean {
  return expected === null || expected === actual;
}

function matchesSearch(row: StoredRequest, search: string | null): boolean {
  if (!search) return true;
  const needle = search.toLowerCase();
  return (
    row.title.toLowerCase().includes(needle) ||
    row.description.toLowerCase().includes(needle) ||
    (row.requestNumber ?? '').toLowerCase().includes(needle)
  );
}

const PRIORITY_RANK: Record<RequestPriority, number> = Object.fromEntries(
  [...REQUEST_PRIORITIES].reverse().map((priority, index) => [priority, index]),
) as Record<RequestPriority, number>;

function compare(
  left: StoredRequest,
  right: StoredRequest,
  key: string,
  descending: boolean,
): number {
  const factor = descending ? -1 : 1;
  switch (key) {
    case 'priority':
      return factor * (PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority]);
    case 'status':
      return factor * left.status.localeCompare(right.status);
    case 'title':
      return factor * left.title.localeCompare(right.title);
    case 'request_number':
      return factor * (left.requestNumber ?? '').localeCompare(right.requestNumber ?? '');
    case 'sla_remaining':
      return (
        factor * (timestamp(left.sla?.resolutionDueAt) - timestamp(right.sla?.resolutionDueAt))
      );
    case 'created_at':
      return (
        factor *
        (timestamp(left.createdAt) - timestamp(right.createdAt) || left.id.localeCompare(right.id))
      );
    case 'updated_at':
      return (
        factor *
        (timestamp(left.updatedAt) - timestamp(right.updatedAt) || left.id.localeCompare(right.id))
      );
    case 'resolved_at':
      return (
        factor *
        (timestamp(left.resolvedAt) - timestamp(right.resolvedAt) ||
          left.id.localeCompare(right.id))
      );
    case 'submitted_at':
    default:
      return (
        factor *
        (timestamp(left.submittedAt) - timestamp(right.submittedAt) ||
          left.id.localeCompare(right.id))
      );
  }
}

/** Missing values sort last in both directions, matching `NULLS LAST`/`NULLS FIRST`. */
function timestamp(value: string | null | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function checkVersion(current: number, expected: number | null): WriteOutcome | null {
  return expected !== null && expected !== current
    ? { kind: 'version_conflict', currentVersion: current }
    : null;
}

/** The written row an audit entry is stamped against (identical to the SQL adapter's helper). */
function auditRow(stored: StoredRequest, at: string): WrittenRow {
  return {
    entityId: stored.id,
    requestNumber: stored.requestNumber,
    version: stored.version,
    at,
  };
}

/**
 * A `comment_added` row is the one event whose visibility is borrowed from something else: it exists to
 * announce a comment, so an internal note's marker is filtered for exactly the audience the note is.
 */
function isInternalCommentMarker(row: RequestEventRecord): boolean {
  return row.eventType === 'comment_added' && row.detail.visibility === 'internal';
}

/**
 * Instant, then source (events before comments), then id — the same tiebreak order the `UNION ALL`
 * timeline uses in SQL, so a fixed clock that stamps several rows with one instant produces the same
 * feed in both adapters.
 */
function compareTimeline(left: TimelineRecord, right: TimelineRecord): number {
  return (
    timestamp(left.createdAt) - timestamp(right.createdAt) ||
    (left.kind === right.kind ? 0 : left.kind === 'event' ? -1 : 1) ||
    Number(left.id) - Number(right.id)
  );
}

function toStoredSla(tracker: TrackerWrite, state: SlaState): StoredRequest['sla'] {
  return {
    firstResponseDueAt: tracker.firstResponseDueAt,
    resolutionDueAt: tracker.resolutionDueAt,
    state,
    policySnapshot: tracker.policySnapshot,
  };
}

/**
 * A transition can end the SLA clock: resolving freezes the tracker and closing/cancelling removes
 * it from the open queue, exactly as the SQL `CASE` excludes those statuses.
 */
function recomputeState(
  sla: StoredRequest['sla'],
  status: RequestStatus,
  at: string,
): StoredRequest['sla'] {
  if (!sla) return null;
  if (status === 'resolved' || status === 'closed' || status === 'cancelled') {
    return { ...sla, state: sla.state };
  }
  const due = sla.resolutionDueAt
    ? new Date(sla.resolutionDueAt).getTime()
    : Number.POSITIVE_INFINITY;
  const breached = due < new Date(at).getTime();
  return { ...sla, state: breached ? 'breached' : sla.state };
}

export interface TaxonomySeed {
  readonly categories: readonly TaxonomyRecord[];
  readonly subCategories: readonly (TaxonomyRecord & { categoryId: string })[];
  readonly departments: readonly TaxonomyRecord[];
}

/** Mirrors `database/seeds/001_reference_data.sql` so memory mode and Postgres agree (ST-501). */
export function defaultTaxonomy(): TaxonomySeed {
  return {
    categories: [
      { id: '1', name: 'IT', isActive: true },
      { id: '2', name: 'Human Resources', isActive: true },
      { id: '3', name: 'Facilities', isActive: true },
    ],
    subCategories: [
      { id: '11', name: 'Network & VPN', categoryId: '1', isActive: true },
      { id: '12', name: 'Hardware', categoryId: '1', isActive: true },
      { id: '21', name: 'Payroll', categoryId: '2', isActive: true },
      { id: '31', name: 'Office Access', categoryId: '3', isActive: true },
    ],
    departments: [
      { id: '1', name: 'Engineering', isActive: true },
      { id: '2', name: 'People Ops', isActive: true },
      { id: '3', name: 'Operations', isActive: true },
    ],
  };
}

function taxonomy<T extends TaxonomyRecord>(source: Map<string, T>, id: string, label: string): T {
  const record = source.get(id);
  if (!record) throw new AppError('VALIDATION_ERROR', `Unknown ${label} id '${id}'`);
  return record;
}
