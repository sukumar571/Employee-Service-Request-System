import { z } from 'zod';
import { commentVisibilitySchema } from '../enums/index.js';
import { listResponseSchema, paginationQuerySchema } from './envelope.js';
import { requestEventSchema, requestPersonRefSchema, requestIdParamsSchema } from './requests.js';

/**
 * Request comments and the request activity timeline (docs/api-specification.md §7).
 *
 * Two separate surfaces, deliberately:
 *
 *  - **comments** are user-visible content written by a person. They belong to the request aggregate,
 *    carry an author and a timestamp, and are filtered by `visibility` on every read path.
 *  - **the timeline** is the request's activity feed: lifecycle transitions plus the fact that a
 *    comment was added. It is derived from `request_events` and `comments` and is *never* the audit
 *    trail — `audit_logs` is an administrative/security record and has no HTTP read route at all.
 *
 * The body limits are the exact `comments_body_check` CHECK in
 * `database/migrations/009_comments_request_events.sql`, so a payload Zod accepts can never be
 * rejected by the table.
 */

/** Mirrors `CHECK (char_length(body) BETWEEN 1 AND 5000)`. */
export const COMMENT_BODY_MIN = 1;
export const COMMENT_BODY_MAX = 5000;

/**
 * `body` must not be empty or whitespace-only: `.trim()` runs before `.min(1)`, so `'   '` fails the
 * length check rather than being stored as content (AC-5 edge case, requirements.md §16).
 */
export const commentBodySchema = z
  .string()
  .trim()
  .min(COMMENT_BODY_MIN, `A comment needs at least ${COMMENT_BODY_MIN} non-space character`)
  .max(COMMENT_BODY_MAX, `A comment must be at most ${COMMENT_BODY_MAX} characters`);

/**
 * `POST /requests/{id}/comments`. `visibility` defaults to `public`; `internal` is additionally
 * gated on the `comment.internal` RBAC action (agent+), and `.strict()` rejects anything else.
 */
export const createCommentBodySchema = z
  .object({
    body: commentBodySchema,
    visibility: commentVisibilitySchema.default('public'),
  })
  .strict();
export type CreateCommentBody = z.infer<typeof createCommentBodySchema>;

/** Both comment endpoints are addressed by their parent request, so the path shape is shared. */
export const requestCommentParamsSchema = requestIdParamsSchema;

/** `GET /requests/{id}/comments` — a threaded conversation is read oldest-first, page by page. */
export const listCommentsQuerySchema = paginationQuerySchema.strict();
export type ListCommentsQuery = z.infer<typeof listCommentsQuerySchema>;

export const commentSchema = z.object({
  id: z.string(),
  request_id: z.string(),
  author: requestPersonRefSchema,
  body: z.string(),
  visibility: commentVisibilitySchema,
  /** BR-8: the request was already resolved/closed when this comment was written. */
  is_post_closure: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type CommentDto = z.infer<typeof commentSchema>;

export const commentListResponseSchema = listResponseSchema(commentSchema);
export const commentResponseSchema = z.object({ data: commentSchema });

// ---------------------------------------------------------------------------
// Activity timeline
// ---------------------------------------------------------------------------

/**
 * The feed is bounded by the contract, exactly like `GET /requests/{id}/events`: a request that has
 * been open for a year must not turn its detail page into an unbounded read of two append-only tables.
 */
export const REQUEST_TIMELINE_LIMIT_MAX = 200;
export const requestTimelineQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(REQUEST_TIMELINE_LIMIT_MAX).default(100),
  })
  .strict();
export type RequestTimelineQuery = z.infer<typeof requestTimelineQuerySchema>;

/**
 * One entry in the merged activity feed. `kind` names the source row:
 *  - `event`   — a lifecycle entry from `request_events` (comment markers are folded into `comment`);
 *  - `comment` — a comment, whose text travels in `detail.body` and which is visibility-filtered.
 *
 * The `detail` record is therefore the one place where the two sources differ in shape, which is
 * exactly why it is a free-form JSONB column in the schema.
 */
export const requestTimelineEntrySchema = requestEventSchema.extend({
  kind: z.enum(['event', 'comment']),
});
export type RequestTimelineEntry = z.infer<typeof requestTimelineEntrySchema>;

export const requestTimelineListResponseSchema = listResponseSchema(requestTimelineEntrySchema);
