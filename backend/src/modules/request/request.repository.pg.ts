import type { CommentVisibility, RequestPriority, RequestStatus, SlaState } from '@esrs/shared';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { insertAuditWrites } from '../../db/audit.sql.js';
import type { Database } from '../../db/pool.js';
import { AppError } from '../../lib/errors/appError.js';
import type { WrittenRow } from '../../ports/audit.js';
import type {
  CommentListCriteria,
  CommentPage,
  EventListCriteria,
  LifecycleEventWrite,
  NewCommentWrite,
  NewRequestWrite,
  RequestEditWrite,
  RequestEventRecord,
  RequestListCriteria,
  RequestPage,
  RequestRepository,
  StoredComment,
  StoredRequest,
  StoredSla,
  TaxonomyRecord,
  TimelineCriteria,
  TimelineRecord,
  TrackerWrite,
  TransitionWrite,
  WriteOutcome,
} from './request.repository.js';

/**
 * Postgres adapter for the request aggregate (docs/database-design.md §2.3–§2.8).
 *
 * Two rules govern this file, both security-critical:
 *
 * 1. **Every value is a bound parameter.** No user input is ever concatenated into SQL text. The
 *    only interpolated strings are constants defined in this module (`SELECT_COLUMNS`, the
 *    `SORT_COLUMNS` values, the direction keyword), which is what makes `ORDER BY` dynamic and
 *    still injection-proof (docs/security-plan.md §5).
 * 2. **Every multi-row write is one transaction**, opened with `SELECT … FOR UPDATE` on the parent
 *    row so concurrent transitions on the same ticket serialise instead of interleaving. The
 *    `audit_logs` row describing the change is written on that same client, so a failed audit insert
 *    rolls the business change back and a committed change is never missing from the trail.
 *
 * `BIGINT` columns arrive as JavaScript strings through `pg`, which is exactly the wire format the
 * contract uses for identifiers, so ids are never round-tripped through `Number`.
 */

/**
 * Derived, never stored: the persisted tracker flags are the source of truth (`warned_at` is set by
 * the 75 % sweep, `breached`/`breached_at` by the breach sweep), so the same expression works as a
 * projection in `SELECT` and as a predicate in `WHERE` and can never disagree with the queue filter.
 * It is a constant of this module — no caller can widen it.
 */
const SLA_STATE_EXPR = `CASE
  WHEN t.id IS NULL THEN NULL
  WHEN t.breached
    OR (t.resolution_due_at IS NOT NULL AND t.resolution_due_at < now()
        AND r.status NOT IN ('resolved', 'closed', 'cancelled')) THEN 'breached'
  WHEN t.warned_at IS NOT NULL THEN 'warning'
  ELSE 'safe'
END`;

const SELECT_COLUMNS = `
  r.id, r.request_number, r.title, r.description, r.status, r.priority,
  r.status_reason, r.resolution_note, r.submitted_at, r.resolved_at, r.closed_at,
  r.cancelled_at, r.reopened_from, r.reopen_count, r.requester_inactive, r.version,
  r.created_at, r.updated_at,
  requester.id AS requester_id, requester.full_name AS requester_name,
  assignee.id AS assignee_id, assignee.full_name AS assignee_name,
  cat.id AS category_id, cat.name AS category_name,
  sub.id AS sub_category_id, sub.name AS sub_category_name,
  dep.id AS department_id, dep.name AS department_name,
  t.id AS tracker_id, t.first_response_due_at, t.resolution_due_at, t.policy_snapshot,
  ${SLA_STATE_EXPR} AS sla_state`;

const FROM_CLAUSE = `
  FROM requests r
  JOIN users requester ON requester.id = r.requester_id
  LEFT JOIN users assignee ON assignee.id = r.assignee_id
  JOIN categories cat ON cat.id = r.category_id
  LEFT JOIN sub_categories sub ON sub.id = r.sub_category_id
  LEFT JOIN departments dep ON dep.id = r.department_id
  LEFT JOIN sla_trackers t ON t.request_id = r.id`;

/**
 * Whitelist of sortable columns. The client supplies a key into this map; the mapped value is a
 * literal defined right here, so an unknown key falls back to `r.id` rather than reaching the SQL.
 */
const SORT_COLUMNS: Record<string, string> = {
  created_at: 'r.created_at',
  updated_at: 'r.updated_at',
  submitted_at: 'r.submitted_at',
  resolved_at: 'r.resolved_at',
  status: 'r.status',
  title: 'r.title',
  request_number: 'r.request_number',
  id: 'r.id',
  sla_remaining: 't.resolution_due_at',
  // Business importance, not alphabetical order: critical first when ascending.
  priority: `CASE r.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END`,
};

/** Patch field name → column. Only keys present in the write are added to the SET list. */
const EDIT_COLUMNS: Record<string, string> = {
  title: 'title',
  description: 'description',
  categoryId: 'category_id',
  subCategoryId: 'sub_category_id',
  priority: 'priority',
};

const TRANSITION_COLUMNS: Record<string, string> = {
  submittedAt: 'submitted_at',
  resolvedAt: 'resolved_at',
  closedAt: 'closed_at',
  cancelledAt: 'cancelled_at',
};

const COMMENT_COLUMNS = `
  c.id, c.request_id, c.body, c.visibility, c.is_post_closure, c.created_at, c.updated_at,
  author.id AS author_id, author.full_name AS author_name`;

const COMMENT_FROM = `
  FROM comments c
  JOIN users author ON author.id = c.author_id`;

interface RequestRow extends QueryResultRow {
  readonly id: string;
  readonly request_number: string | null;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly priority: string;
  readonly status_reason: string | null;
  readonly resolution_note: string | null;
  readonly submitted_at: Date | null;
  readonly resolved_at: Date | null;
  readonly closed_at: Date | null;
  readonly cancelled_at: Date | null;
  readonly reopened_from: string | null;
  readonly reopen_count: number;
  readonly requester_inactive: boolean;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly requester_id: string;
  readonly requester_name: string;
  readonly assignee_id: string | null;
  readonly assignee_name: string | null;
  readonly category_id: string;
  readonly category_name: string;
  readonly sub_category_id: string | null;
  readonly sub_category_name: string | null;
  readonly department_id: string | null;
  readonly department_name: string | null;
  readonly tracker_id: string | null;
  readonly first_response_due_at: Date | null;
  readonly resolution_due_at: Date | null;
  readonly policy_snapshot: unknown;
  readonly sla_state: string | null;
  readonly total_count?: string;
}

export class PostgresRequestRepository implements RequestRepository {
  constructor(private readonly database: Database) {}

  async list(criteria: RequestListCriteria): Promise<RequestPage> {
    const params: unknown[] = [];
    const param = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    const where: string[] = [scopeSql(criteria.scope, param)];

    if (criteria.statuses.length > 0) {
      where.push(`r.status = ANY (${param(criteria.statuses)}::request_status[])`);
    }
    if (criteria.priorities.length > 0) {
      where.push(`r.priority = ANY (${param(criteria.priorities)}::request_priority[])`);
    }
    if (criteria.categoryId) where.push(`r.category_id = ${param(criteria.categoryId)}`);
    if (criteria.subCategoryId) where.push(`r.sub_category_id = ${param(criteria.subCategoryId)}`);
    if (criteria.departmentId) where.push(`r.department_id = ${param(criteria.departmentId)}`);
    if (criteria.requesterId) where.push(`r.requester_id = ${param(criteria.requesterId)}`);
    if (criteria.unassigned) where.push('r.assignee_id IS NULL');
    else if (criteria.assigneeId) where.push(`r.assignee_id = ${param(criteria.assigneeId)}`);
    if (criteria.sla) where.push(`${oneline(SLA_STATE_EXPR)} = ${param(criteria.sla)}`);
    if (criteria.search) {
      const fullText = param(criteria.search);
      const pattern = param(likePattern(criteria.search));
      where.push(
        `(r.search_text @@ plainto_tsquery('simple', ${fullText})
          OR r.title ILIKE ${pattern}
          OR COALESCE(r.request_number, '') ILIKE ${pattern})`,
      );
    }

    const sortColumn = SORT_COLUMNS[criteria.sortKey] ?? 'r.id';
    const direction = criteria.sortDescending ? 'DESC' : 'ASC';
    // `NULLS LAST`/`NULLS FIRST` keeps drafts (no submitted_at) and tracker-less rows at the end of
    // a newest-first queue instead of masquerading as the oldest work.
    const nulls = criteria.sortDescending ? 'NULLS LAST' : 'NULLS FIRST';

    const result = await this.query<RequestRow>(
      `SELECT ${SELECT_COLUMNS}, count(*) OVER () AS total_count
       ${FROM_CLAUSE}
       WHERE ${where.join(' AND ')}
       ORDER BY ${sortColumn} ${direction} ${nulls}, r.id DESC
       LIMIT ${param(criteria.pageSize)} OFFSET ${param((criteria.page - 1) * criteria.pageSize)}`,
      params,
    );

    return {
      items: result.rows.map(toStoredRequest),
      total: Number(result.rows[0]?.total_count ?? 0),
    };
  }

  async find(id: string): Promise<StoredRequest | undefined> {
    const result = await this.query<RequestRow>(
      `SELECT ${SELECT_COLUMNS} ${FROM_CLAUSE} WHERE r.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toStoredRequest(row) : undefined;
  }

  /**
   * Creation. A direct submit writes four things atomically: the row, its gapless number, the
   * `created` (+`submitted`) events and the SLA tracker frozen against the policy in force.
   */
  async create(write: NewRequestWrite): Promise<StoredRequest> {
    return this.transaction<StoredRequest>((client) =>
      this.guard(async () => {
        const requestNumber =
          write.status === 'submitted'
            ? await allocateNumber(client, new Date(write.at).getUTCFullYear())
            : null;

        const inserted = await client.query<{ id: string }>(
          `INSERT INTO requests
             (request_number, requester_id, category_id, sub_category_id, department_id,
              title, description, status, priority, submitted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            requestNumber,
            write.requesterId,
            write.categoryId,
            write.subCategoryId,
            write.departmentId,
            write.title,
            write.description,
            write.status,
            write.priority,
            write.status === 'submitted' ? write.at : null,
          ],
        );
        const id = single(inserted).id;

        await insertEvent(client, id, write.actorId, write.actorRole, 'created', write.at, {
          priority: write.priority,
          draft: write.status === 'draft',
        });
        if (write.status === 'submitted') {
          await insertEvent(client, id, write.actorId, write.actorRole, 'submitted', write.at, {
            request_number: requestNumber,
          });
        }
        if (write.tracker) await upsertTracker(client, id, write.tracker);

        // The audit rows are written *after* the aggregate is complete but *inside* the same
        // transaction, so they can describe the real id, number and version rather than a guess.
        const stored = toStoredRequest(await fetchRow(client, id));
        await insertAuditWrites(client, write.audit, {
          entityId: stored.id,
          requestNumber: stored.requestNumber,
          version: stored.version,
          at: write.at,
        });
        return stored;
      }),
    );
  }

  /** Draft content edit under a row lock, with the same version discipline as a transition. */
  async edit(write: RequestEditWrite): Promise<WriteOutcome> {
    return this.transaction<WriteOutcome>((client) =>
      this.guard(async () => {
        const locked = await lockRow(client, write.id);
        if (!locked) return { kind: 'not_found' };
        const conflict = versionConflict(locked.version, write.expectedVersion);
        if (conflict) return conflict;

        // One instant for the whole write: the event, the audit row and the version bump are stamped
        // together, so nothing in the trail can appear to have happened out of order.
        const at = new Date().toISOString();

        const params: unknown[] = [];
        const set: string[] = [];
        for (const [field, column] of Object.entries(EDIT_COLUMNS)) {
          const value = write.patch[field as keyof typeof write.patch];
          if (value === undefined) continue;
          params.push(value);
          set.push(`${column} = $${params.length}`);
        }
        // A patch that names no field changes nothing, so it records nothing: no version bump, no
        // event and deliberately no audit row. An audit trail full of no-ops hides the real history.
        if (set.length === 0) return { kind: 'applied', request: toStoredRequest(locked) };

        params.push(write.id, write.expectedVersion ?? locked.version);
        const idParam = `$${params.length - 1}`;
        const versionParam = `$${params.length}`;

        const updated = await client.query<{ id: string }>(
          `UPDATE requests SET ${set.join(', ')}, version = version + 1, updated_at = now()
           WHERE id = ${idParam} AND version = ${versionParam} RETURNING id`,
          params,
        );
        if (updated.rowCount === 0) {
          return { kind: 'version_conflict', currentVersion: locked.version };
        }

        if (write.event) {
          await insertEvent(
            client,
            write.id,
            write.actorId,
            write.actorRole,
            write.event.eventType,
            at,
            write.event.detail,
          );
        }
        const stored = await toStoredRequestById(client, write.id);
        await insertAuditWrites(client, write.audit, writtenRow(stored, at));
        return { kind: 'applied', request: stored };
      }),
    );
  }

  /**
   * The only write path that changes a status. Everything it touches — parent row, assignment
   * history, activity event, SLA tracker, and for a submit the request number — commits or rolls
   * back together, so a failure can never leave a ticket `assigned` with no assignment row.
   */
  async transition(write: TransitionWrite): Promise<WriteOutcome> {
    return this.transaction<WriteOutcome>((client) =>
      this.guard(async () => {
        const locked = await lockRow(client, write.id);
        if (!locked) return { kind: 'not_found' };
        const conflict = versionConflict(locked.version, write.expectedVersion);
        if (conflict) return conflict;

        // Same rule as `edit()`: one instant per write, shared by the event and the audit row.
        const at = new Date().toISOString();

        const params: unknown[] = [];
        const push = (value: unknown): string => {
          params.push(value);
          return `$${params.length}`;
        };

        const set = [
          `status = ${push(write.toStatus)}`,
          `assignee_id = ${push(write.assigneeId)}`,
          `status_reason = ${push(write.statusReason)}`,
          `version = version + 1`,
          'updated_at = now()',
        ];
        if (write.resolutionNote !== null) {
          set.push(`resolution_note = ${push(write.resolutionNote)}`);
        }
        if (write.incrementReopen) set.push('reopen_count = reopen_count + 1');
        for (const [field, column] of Object.entries(TRANSITION_COLUMNS)) {
          const value = write.timestamps[field as keyof typeof write.timestamps];
          if (value !== undefined) set.push(`${column} = ${push(value)}`);
        }
        for (const field of write.clearTimestamps) {
          set.push(`${TRANSITION_COLUMNS[field]} = NULL`);
        }
        if (write.allocateNumberYear !== null) {
          const year = write.allocateNumberYear;
          const seq = await nextSequence(client, year);
          const number = `REQ-${year}-${String(seq).padStart(6, '0')}`;
          set.push(`request_number = COALESCE(request_number, ${push(number)})`);
        }

        params.push(write.id, locked.version);
        const idParam = `$${params.length - 1}`;
        const versionParam = `$${params.length}`;

        const updated = await client.query(
          `UPDATE requests SET ${set.join(', ')}
           WHERE id = ${idParam} AND version = ${versionParam} RETURNING id`,
          params,
        );
        if (updated.rowCount === 0) {
          return { kind: 'version_conflict', currentVersion: locked.version };
        }

        // Assignment history is append-only: the previous holder is closed, a new row opens. This is
        // what lets `assignments` answer "who had this ticket on <date>" without a separate audit.
        const assigneeChanged = (locked.assignee_id ?? null) !== (write.assigneeId ?? null);
        if (write.closeOpenAssignment || write.assignment !== null) {
          await client.query(
            'UPDATE assignments SET unassigned_at = now() WHERE request_id = $1 AND unassigned_at IS NULL',
            [write.id],
          );
        }
        if (write.assignment?.agentId) {
          await client.query(
            `INSERT INTO assignments (request_id, agent_id, assigned_by, assigned_at, reason)
             VALUES ($1, $2, $3, $4, $5)`,
            [write.id, write.assignment.agentId, write.actorId, at, write.assignment.reason],
          );
        }

        await insertEvent(
          client,
          write.id,
          write.actorId,
          write.actorRole,
          write.event.eventType,
          at,
          write.event.detail,
          // The status pair belongs in the columns the contract exposes as `from_status`/`to_status`,
          // not duplicated inside the free-form `detail` payload.
          { from: write.fromStatus, to: write.toStatus },
        );

        if (write.tracker) await upsertTracker(client, write.id, write.tracker);
        if (assigneeChanged && write.assigneeId === null) {
          await insertEvent(client, write.id, write.actorId, write.actorRole, 'unassigned', at, {});
        }

        const stored = await toStoredRequestById(client, write.id);
        // `at` is the instant the activity event was stamped with, so the visible trail and the audit
        // row can never disagree about when the change happened.
        await insertAuditWrites(client, write.audit, writtenRow(stored, at));
        return { kind: 'applied', request: stored };
      }),
    );
  }

  /**
   * The lifecycle trail, with one visibility rule applied: a `comment_added` marker whose comment was
   * internal is hidden from a caller who may not read the comment. The predicate is NULL-safe — a
   * marker always carries `detail.visibility`, but an event that does not have the key must not be
   * dropped by three-valued logic — and it runs before `LIMIT`, so the returned page is the caller's
   * own slice of history (`docs/api-specification.md` §6.4).
   */
  async events(criteria: EventListCriteria): Promise<RequestEventRecord[]> {
    const result = await this.query<QueryResultRow>(
      `SELECT e.id, e.event_type, e.actor_role, e.from_status, e.to_status, e.detail, e.created_at,
              u.id AS actor_id, u.full_name AS actor_name
       FROM request_events e
       LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.request_id = $1
         AND ($2 OR e.event_type <> 'comment_added'
              OR COALESCE(e.detail ->> 'visibility', 'public') <> 'internal')
       ORDER BY e.created_at ASC, e.id ASC
       LIMIT $3`,
      [criteria.requestId, criteria.includeInternal, criteria.limit],
    );
    return result.rows.map(toEventRecord);
  }

  /**
   * A comment is a three-row write: the comment, the `comment_added` marker in the visible activity
   * trail, and the audit row — all on one client. The parent request is locked first, which both
   * serialises a comment against a concurrent transition and proves the request exists (the FK would
   * also reject an orphan, but a lock gives the audit row its request number and version).
   */
  async addComment(write: NewCommentWrite): Promise<StoredComment> {
    return this.transaction<StoredComment>((client) =>
      this.guard(async () => {
        const parent = await lockRow(client, write.requestId);
        if (!parent) {
          throw new AppError('INTERNAL', 'Comment target vanished inside its own transaction');
        }

        const inserted = await client.query<{ id: string }>(
          `INSERT INTO comments
             (request_id, author_id, body, visibility, is_post_closure, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6)
           RETURNING id`,
          [
            write.requestId,
            write.authorId,
            write.body,
            write.visibility,
            write.isPostClosure,
            write.at,
          ],
        );
        const commentId = single(inserted).id;

        // The marker carries a summary, never the text: the body lives in `comments` alone, which is
        // what keeps the audit/activity trail distinct from the conversation itself. The id is stamped
        // here because it only exists once the row above has been inserted.
        await insertEvent(
          client,
          write.requestId,
          write.authorId,
          write.authorRole,
          write.event.eventType,
          write.at,
          { comment_id: commentId, ...write.event.detail },
        );

        const row = await client.query<CommentRow>(
          `SELECT ${COMMENT_COLUMNS} ${COMMENT_FROM} WHERE c.id = $1`,
          [commentId],
        );
        const comment = toStoredComment(single(row));
        await insertAuditWrites(client, write.audit, {
          entityId: comment.id,
          serviceRequestId: write.requestId,
          requestNumber: parent.request_number,
          version: parent.version,
          at: write.at,
        });
        return comment;
      }),
    );
  }

  /**
   * `internal` notes are filtered here, in SQL, so an employee's page fetch cannot pull a note it has
   * no right to read even if a upper layer forgets to check (docs/security-plan.md §4).
   */
  async listComments(criteria: CommentListCriteria): Promise<CommentPage> {
    const result = await this.query<CommentRow>(
      `SELECT ${COMMENT_COLUMNS}, count(*) OVER () AS total_count
       ${COMMENT_FROM}
       WHERE c.request_id = $1 AND ($2::boolean OR c.visibility = 'public')
       ORDER BY c.created_at ASC, c.id ASC
       LIMIT $3 OFFSET $4`,
      [criteria.requestId, criteria.includeInternal, criteria.limit, criteria.offset],
    );
    return {
      items: result.rows.map(toStoredComment),
      total: Number(result.rows[0]?.total_count ?? 0),
    };
  }

  /**
   * Lifecycle events and comments merged into one feed. The `comment_added` markers inside
   * `request_events` are dropped in favour of the real comment rows, so a comment is never listed
   * twice and an employee reading the feed still has the text filtered by visibility in SQL.
   *
   * Ties on `created_at` are broken by source and then by id, because a clock that returns the same
   * instant for a whole test (or two writes in the same millisecond in production) would otherwise
   * leave the order undefined by SQL.
   */
  async timeline(criteria: TimelineCriteria): Promise<TimelineRecord[]> {
    const result = await this.query<QueryResultRow>(
      `SELECT feed.source_rank, feed.id, feed.event_type, feed.actor_role, feed.from_status,
              feed.to_status, feed.detail, feed.created_at, feed.actor_id, feed.actor_name
       FROM (
         SELECT 0::smallint AS source_rank, e.id, e.event_type::text AS event_type,
                e.actor_role::text AS actor_role, e.from_status, e.to_status, e.detail, e.created_at,
                u.id AS actor_id, u.full_name AS actor_name
         FROM request_events e
         LEFT JOIN users u ON u.id = e.actor_id
         WHERE e.request_id = $1 AND e.event_type <> 'comment_added'
         UNION ALL
         SELECT 1::smallint AS source_rank, c.id, 'comment_added' AS event_type,
                author.role::text AS actor_role, NULL::request_status AS from_status,
                NULL::request_status AS to_status,
                jsonb_build_object('comment_id', c.id::text, 'visibility', c.visibility::text,
                                   'is_post_closure', c.is_post_closure, 'body', c.body) AS detail,
                c.created_at, author.id AS actor_id, author.full_name AS actor_name
         FROM comments c
         JOIN users author ON author.id = c.author_id
         WHERE c.request_id = $1 AND ($2::boolean OR c.visibility = 'public')
       ) feed
       ORDER BY feed.created_at ASC, feed.source_rank ASC, feed.id ASC
       LIMIT $3`,
      [criteria.requestId, criteria.includeInternal, criteria.limit],
    );
    return result.rows.map((row) => ({
      kind: Number(row.source_rank) === 1 ? 'comment' : 'event',
      ...toEventRecord(row),
    }));
  }

  async findCategory(id: string): Promise<TaxonomyRecord | undefined> {
    return this.findTaxonomy('categories', id);
  }

  async findSubCategory(
    id: string,
  ): Promise<(TaxonomyRecord & { readonly categoryId: string }) | undefined> {
    const result = await this.query<QueryResultRow>(
      'SELECT id, name, is_active, category_id FROM sub_categories WHERE id = $1',
      [id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: String(row.id),
      name: String(row.name),
      isActive: Boolean(row.is_active),
      categoryId: String(row.category_id),
    };
  }

  async findDepartment(id: string): Promise<TaxonomyRecord | undefined> {
    return this.findTaxonomy('departments', id);
  }

  async countOpenForAssignee(agentId: string): Promise<number> {
    const result = await this.query<{ open: number }>(
      `SELECT count(*)::int AS open FROM requests
       WHERE assignee_id = $1 AND status IN ('submitted', 'assigned', 'in_progress', 'on_hold')`,
      [agentId],
    );
    return result.rows[0]?.open ?? 0;
  }

  private async findTaxonomy(
    table: 'categories' | 'departments',
    id: string,
  ): Promise<TaxonomyRecord | undefined> {
    // `table` is a union of two literals in this file, never caller input.
    const result = await this.query<QueryResultRow>(
      `SELECT id, name, is_active FROM ${table} WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row
      ? { id: String(row.id), name: String(row.name), isActive: Boolean(row.is_active) }
      : undefined;
  }

  /**
   * Reads get the same SQLSTATE translation as writes: a dropped connection or a statement timeout
   * has to reach the client as 503 SERVICE_UNAVAILABLE, not as a raw driver error inside a 500.
   */
  private async query<T extends QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    try {
      return await this.database.query<T>(sql, params);
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }

  /**
   * Translates the driver's SQLSTATE into the contract's error codes. Without this a foreign-key
   * miss or a serialization deadlock would surface as a generic 500 and leak driver wording.
   */
  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }

  /**
   * A transaction is opened by the pool, not by this adapter, so the outage cases have to be mapped
   * around the call as well: `guard` alone would miss a BEGIN that fails on a dead connection.
   */
  private transaction<R>(work: (client: PoolClient) => Promise<R>): Promise<R> {
    return this.guard(() => this.database.transaction<R>(work));
  }
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

/** Row-visibility predicate (docs/system-architecture.md §4). Constants + bound ids only. */
function scopeSql(scope: RequestListCriteria['scope'], param: (value: unknown) => string): string {
  switch (scope.kind) {
    case 'all': {
      // Managers and admins see every team's queue; drafts still stay private to their author.
      const own = param(scope.userId);
      return `(r.status <> 'draft' OR r.requester_id = ${own})`;
    }
    case 'requester':
      return `r.requester_id = ${param(scope.userId)}`;
    case 'team': {
      const own = param(scope.userId);
      if (!scope.teamCategoryId) return `(r.requester_id = ${own} OR r.assignee_id = ${own})`;
      const team = param(scope.teamCategoryId);
      return `(r.requester_id = ${own} OR r.assignee_id = ${own}
               OR (cat.id = ${team} AND r.status <> 'draft'))`;
    }
  }
}

/** Keeps a reused SQL expression on one line so the composed WHERE clause stays readable in logs. */
function oneline(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function likePattern(search: string): string {
  // Escape the LIKE metacharacters so a search for "100%" is a literal, not a wildcard.
  const escaped = search.replace(/[\\%_]/g, (character) => `\\${character}`);
  return `%${escaped}%`;
}

async function fetchRow(client: PoolClient, id: string): Promise<RequestRow> {
  const result = await client.query<RequestRow>(
    `SELECT ${SELECT_COLUMNS} ${FROM_CLAUSE} WHERE r.id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new AppError('INTERNAL', 'Request row vanished inside its own transaction');
  return row;
}

async function toStoredRequestById(client: PoolClient, id: string): Promise<StoredRequest> {
  return toStoredRequest(await fetchRow(client, id));
}

/** Locks the aggregate root so concurrent transitions on one ticket are serialised. */
async function lockRow(client: PoolClient, id: string): Promise<RequestRow | null> {
  const result = await client.query<RequestRow>(
    `SELECT ${SELECT_COLUMNS} ${FROM_CLAUSE} WHERE r.id = $1 FOR UPDATE OF r`,
    [id],
  );
  return result.rows[0] ?? null;
}

function versionConflict(current: number, expected: number | null): WriteOutcome | null {
  return expected !== null && expected !== current
    ? { kind: 'version_conflict', currentVersion: current }
    : null;
}

/**
 * Gapless number allocation inside the caller's transaction (docs/database-design.md §5): the
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING` is one atomic upsert, and because it participates in
 * the surrounding transaction a rolled-back submit returns the number to the pool instead of
 * burning it.
 *
 * The row is seeded with `last_seq = 1` rather than left to the column default of 0: `last_seq` means
 * "the sequence already handed out", so the first ticket of a fresh year must be `…000001`, matching
 * what the in-memory adapter produces. Relying on the default made the two adapters disagree.
 */
async function nextSequence(client: PoolClient, year: number): Promise<number> {
  const result = await client.query<{ last_seq: string }>(
    `INSERT INTO request_numbers (year, last_seq) VALUES ($1, 1)
     ON CONFLICT (year) DO UPDATE SET last_seq = request_numbers.last_seq + 1
     RETURNING last_seq`,
    [year],
  );
  const row = result.rows[0];
  if (!row) throw new AppError('INTERNAL', 'Request-number allocator returned no row');
  return Number(row.last_seq);
}

async function allocateNumber(client: PoolClient, year: number): Promise<string> {
  const sequence = await nextSequence(client, year);
  return `REQ-${year}-${String(sequence).padStart(6, '0')}`;
}

async function insertEvent(
  client: PoolClient,
  requestId: string,
  actorId: string,
  actorRole: string,
  eventType: LifecycleEventWrite['eventType'],
  at: string,
  detail: Record<string, unknown>,
  status?: { readonly from: RequestStatus | null; readonly to: RequestStatus | null },
): Promise<void> {
  await client.query(
    `INSERT INTO request_events
       (request_id, actor_id, actor_role, event_type, detail, from_status, to_status, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
    [
      requestId,
      actorId,
      actorRole,
      eventType,
      JSON.stringify(detail ?? {}),
      status?.from ?? null,
      status?.to ?? null,
      at,
    ],
  );
}

/**
 * Creates the tracker on submit and re-stamps it on the transitions that affect the clock.
 * `policy_snapshot` is written verbatim so an outstanding ticket never follows a later policy edit;
 * `resume` wipes the warning/breach stamps so a reopened ticket can alert again; `markFirstResponse`
 * only ever fills a gap, because the first response is a one-time measurement.
 */
async function upsertTracker(
  client: PoolClient,
  requestId: string,
  tracker: TrackerWrite,
): Promise<void> {
  await client.query(
    `INSERT INTO sla_trackers
       (request_id, policy_snapshot, submitted_at, first_response_due_at, resolution_due_at,
        first_response_met_at, completion_status, updated_at)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, now())
     ON CONFLICT (request_id) DO UPDATE
       SET policy_snapshot = EXCLUDED.policy_snapshot,
           submitted_at = EXCLUDED.submitted_at,
           first_response_due_at = EXCLUDED.first_response_due_at,
           resolution_due_at = EXCLUDED.resolution_due_at,
           first_response_met_at = COALESCE(sla_trackers.first_response_met_at, EXCLUDED.first_response_met_at),
           completion_status = COALESCE(EXCLUDED.completion_status, sla_trackers.completion_status),
           warned_at = CASE WHEN $8::boolean THEN NULL ELSE sla_trackers.warned_at END,
           breached = CASE WHEN $8::boolean THEN FALSE ELSE sla_trackers.breached END,
           breached_at = CASE WHEN $8::boolean THEN NULL ELSE sla_trackers.breached_at END,
           updated_at = now()`,
    [
      requestId,
      JSON.stringify(tracker.policySnapshot),
      tracker.submittedAt,
      tracker.firstResponseDueAt,
      tracker.resolutionDueAt,
      tracker.markFirstResponse === true ? tracker.submittedAt : null,
      tracker.completionStatus ?? null,
      tracker.resume === true,
    ],
  );
}

function single<T extends QueryResultRow>(result: { rows: T[] }): T {
  const row = result.rows[0];
  if (!row) throw new AppError('INTERNAL', 'Write returned no row');
  return row;
}

/**
 * The facts a written request row supplies to its own audit entries: the id, number and resulting
 * version, plus the instant the change is recorded at. Both adapters build this identically.
 */
function writtenRow(stored: StoredRequest, at: string): WrittenRow {
  return {
    entityId: stored.id,
    requestNumber: stored.requestNumber,
    version: stored.version,
    at,
  };
}

/** Shared projection for `request_events` rows and for the event half of the timeline union. */
function toEventRecord(row: QueryResultRow): Omit<TimelineRecord, 'kind'> {
  return {
    id: String(row.id),
    eventType: String(row.event_type),
    actor: row.actor_id ? { id: String(row.actor_id), fullName: String(row.actor_name) } : null,
    actorRole: String(row.actor_role),
    fromStatus: (row.from_status as RequestStatus | null) ?? null,
    toStatus: (row.to_status as RequestStatus | null) ?? null,
    detail: (row.detail ?? {}) as Record<string, unknown>,
    createdAt: iso(row.created_at as Date),
  };
}

function toStoredComment(row: CommentRow): StoredComment {
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    author: { id: String(row.author_id), fullName: String(row.author_name) },
    body: row.body,
    visibility: row.visibility as CommentVisibility,
    isPostClosure: row.is_post_closure,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function iso(value: Date): string {
  return value.toISOString();
}

function nullableIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * `status`/`priority` are read straight from PostgreSQL enums. The values are trusted because
 * `database/test/enumParity.test.ts` fails the build if the TypeScript enums and the
 * `CREATE TYPE … AS ENUM` lists ever diverge — a per-row Zod re-parse would re-assert a guarantee
 * the contract test already makes.
 */
function toStoredRequest(row: RequestRow): StoredRequest {
  const sla: StoredSla | null = row.tracker_id
    ? {
        firstResponseDueAt: nullableIso(row.first_response_due_at),
        resolutionDueAt: nullableIso(row.resolution_due_at),
        state: (row.sla_state as SlaState | null) ?? 'safe',
        policySnapshot: (row.policy_snapshot as Record<string, unknown> | null) ?? {},
      }
    : null;

  return {
    id: row.id,
    requestNumber: row.request_number,
    requester: { id: row.requester_id, fullName: row.requester_name },
    assignee: row.assignee_id ? { id: row.assignee_id, fullName: String(row.assignee_name) } : null,
    category: { id: row.category_id, name: row.category_name },
    subCategory: row.sub_category_id
      ? { id: row.sub_category_id, name: String(row.sub_category_name) }
      : null,
    department: row.department_id
      ? { id: row.department_id, name: String(row.department_name) }
      : null,
    title: row.title,
    description: row.description,
    status: row.status as RequestStatus,
    priority: row.priority as RequestPriority,
    statusReason: row.status_reason,
    resolutionNote: row.resolution_note,
    submittedAt: nullableIso(row.submitted_at),
    resolvedAt: nullableIso(row.resolved_at),
    closedAt: nullableIso(row.closed_at),
    cancelledAt: nullableIso(row.cancelled_at),
    reopenedFrom: row.reopened_from,
    reopenCount: row.reopen_count,
    requesterInactive: row.requester_inactive,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    sla,
  };
}

interface CommentRow extends QueryResultRow {
  readonly id: string | number;
  readonly request_id: string | number;
  readonly body: string;
  readonly visibility: string;
  readonly is_post_closure: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly author_id: string | number;
  readonly author_name: string;
  readonly total_count?: string;
}

export function mapDatabaseError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const code = (error as { code?: string } | null)?.code;
  const detail = error as { constraint?: string; table?: string };

  switch (code) {
    case '23505':
      return new AppError('CONFLICT', 'A conflicting record already exists', { cause: error });
    case '23503':
      return new AppError(
        'VALIDATION_ERROR',
        `Unknown or unavailable reference: ${detail.constraint ?? 'foreign key'}`,
        {
          cause: error,
        },
      );
    case '23514':
      return new AppError(
        'VALIDATION_ERROR',
        `Value rejected by a data rule: ${detail.constraint ?? 'check'}`,
        {
          cause: error,
        },
      );
    case '23502':
      return new AppError('VALIDATION_ERROR', 'A required field is missing', { cause: error });
    case '40001':
      // Serialization failure: the transaction was rolled back; retrying with a fresh version works.
      return new AppError('CONFLICT', 'A concurrent update interrupted this write; retry it', {
        cause: error,
      });
    case '53300':
      return new AppError('SERVICE_UNAVAILABLE', 'The service is at its connection limit', {
        cause: error,
      });
    case '57014':
      return new AppError('SERVICE_UNAVAILABLE', 'The query exceeded its statement timeout', {
        cause: error,
      });
    case '53200':
    case '57P01':
    case '57P02':
    case '57P03':
    case '08001':
    case '08003':
    case '08006':
      return new AppError('SERVICE_UNAVAILABLE', 'The database is unavailable', { cause: error });
    default:
      return new AppError('INTERNAL', 'An unexpected error occurred', { cause: error });
  }
}
