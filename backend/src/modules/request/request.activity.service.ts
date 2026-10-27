import {
  commentSchema,
  isTerminalStatus,
  requestTimelineEntrySchema,
  type CommentDto,
  type CreateCommentBody,
  type ListCommentsQuery,
  type RequestTimelineEntry,
} from '@esrs/shared';
import { can, canSeeInternalNotes, type RbacActor } from '../../domain/rbac/policy.js';
import type { Clock } from '../../domain/ports/clock.js';
import { forbidden } from '../../lib/errors/httpErrors.js';
import type {
  CommentListCriteria,
  RequestRepository,
  StoredComment,
  TimelineRecord,
} from './request.repository.js';
import type { RequestService } from './request.service.js';

/**
 * Comments and the request activity timeline (docs/api-specification.md §7).
 *
 * Three rules shape this service, and all three exist because a comment is *content* while the audit
 * trail is *evidence*:
 *
 *  1. **The parent request is always read through `RequestService.requireVisible()`** — the same
 *     row-scope rule as the ticket itself. A thread therefore inherits the request's permissions
 *     exactly: an out-of-scope id is a 404, never a 403, and no role can list comments on a ticket it
 *     cannot open.
 *  2. **`internal` is filtered by role on every read path** (`canSeeInternalNotes()`), and the write
 *     path additionally requires the `comment.internal` action. The repository pushes the predicate
 *     into SQL, so a note is never fetched and then dropped in JavaScript on the way out.
 *  3. **Neither the audit row nor the activity marker repeats the comment body.** The trail records
 *     that a comment was left, by whom, with what visibility and how long it was; the text lives only
 *     in `comments`. That is what keeps "audit history" and "user-visible comments" two different
 *     things rather than two copies of one thing.
 *
 * Author and timestamp are never taken from the payload: the acting identity and the clock are stamped
 * here, so a client cannot attribute a comment to somebody else or back-date it.
 */

/** Statuses whose workflow has reached an end point: a comment after one is flagged (BR-8). */
const POST_CLOSURE_STATUSES: readonly string[] = ['resolved', 'closed', 'cancelled'];

export interface ActivityServiceDependencies {
  readonly repository: RequestRepository;
  readonly requests: RequestService;
  readonly clock: Clock;
}

export interface CommentListResult {
  readonly items: CommentDto[];
  readonly total: number;
}

export class RequestActivityService {
  constructor(private readonly deps: ActivityServiceDependencies) {}

  /**
   * `POST /requests/{id}/comments`. The comment, its `comment_added` activity marker and its audit row
   * are one repository write, hence one database transaction.
   */
  async addComment(
    requestId: string,
    body: CreateCommentBody,
    actor: RbacActor,
    httpRequestId?: string,
  ): Promise<CommentDto> {
    await this.deps.requests.requireActiveActor(actor);
    if (!can(actor, 'comment.create')) {
      throw forbidden(`Role '${actor.role}' may not comment on a request`);
    }
    if (body.visibility === 'internal' && !can(actor, 'comment.internal')) {
      throw forbidden(`Role '${actor.role}' may not write an internal note`);
    }
    const record = await this.deps.requests.requireVisible(requestId, actor);

    // Derived, never supplied: BR-8 marks a note left once the workflow had already ended.
    const postClosure =
      POST_CLOSURE_STATUSES.includes(record.status) || isTerminalStatus(record.status);
    const comment = await this.deps.repository.addComment({
      requestId: record.id,
      authorId: actor.userId,
      authorRole: actor.role,
      body: body.body,
      visibility: body.visibility,
      isPostClosure: postClosure,
      at: this.deps.clock.now().toISOString(),
      event: {
        eventType: 'comment_added',
        // A summary, not the text. The adapter adds the comment id, which only exists after the insert.
        detail: {
          visibility: body.visibility,
          characters: body.body.length,
          is_post_closure: postClosure,
        },
      },
      audit: [
        ({ entityId }) => ({
          actorId: actor.userId,
          actorRole: actor.role,
          action: 'comment.added',
          entityType: 'comment',
          entityId,
          serviceRequestId: record.id,
          // Character count rather than content: an audit trail that copies user text turns into a
          // second, unfiltered copy of the conversation.
          after: {
            request_id: record.id,
            request_number: record.requestNumber,
            author_id: actor.userId,
            visibility: body.visibility,
            characters: body.body.length,
            is_post_closure: postClosure,
          },
          requestId: httpRequestId,
        }),
      ],
    });

    return toCommentDto(comment);
  }

  /** `GET /requests/{id}/comments` — oldest first, internal notes only for agent+ (AC-5). */
  async listComments(
    requestId: string,
    query: ListCommentsQuery,
    actor: RbacActor,
  ): Promise<CommentListResult> {
    const record = await this.deps.requests.requireVisible(requestId, actor);
    const criteria: CommentListCriteria = {
      requestId: record.id,
      includeInternal: canSeeInternalNotes(actor),
      limit: query.page_size,
      offset: (query.page - 1) * query.page_size,
    };
    const page = await this.deps.repository.listComments(criteria);
    return { items: page.items.map(toCommentDto), total: page.total };
  }

  /**
   * `GET /requests/{id}/timeline` — lifecycle events and comments in one chronological feed.
   *
   * The feed is the *user-visible* history. It is not the audit trail: `audit_logs` additionally holds
   * administrative and security events with before/after images, and has no read endpoint at all, so
   * even an actor with `audit.read` gets the timeline here and nothing more.
   */
  async timeline(
    requestId: string,
    limit: number,
    actor: RbacActor,
  ): Promise<RequestTimelineEntry[]> {
    const record = await this.deps.requests.requireVisible(requestId, actor);
    const rows = await this.deps.repository.timeline({
      requestId: record.id,
      includeInternal: canSeeInternalNotes(actor),
      limit,
    });
    return rows.map(toTimelineEntry);
  }
}

function toCommentDto(comment: StoredComment): CommentDto {
  return commentSchema.parse({
    id: comment.id,
    request_id: comment.requestId,
    author: { id: comment.author.id, full_name: comment.author.fullName },
    body: comment.body,
    visibility: comment.visibility,
    is_post_closure: comment.isPostClosure,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  });
}

/**
 * Parsed at the service boundary, so a malformed feed fails here rather than being serialised to a
 * client: the same convention every other read in this codebase follows.
 */
function toTimelineEntry(row: TimelineRecord): RequestTimelineEntry {
  return requestTimelineEntrySchema.parse({
    id: row.id,
    kind: row.kind,
    event_type: row.eventType,
    actor: row.actor ? { id: row.actor.id, full_name: row.actor.fullName } : null,
    actor_role: row.actorRole,
    from_status: row.fromStatus,
    to_status: row.toStatus,
    detail: row.detail,
    created_at: row.createdAt,
  });
}
