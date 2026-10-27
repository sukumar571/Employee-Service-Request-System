import {
  createCommentBodySchema,
  listCommentsQuerySchema,
  requestCommentParamsSchema,
  requestTimelineQuerySchema,
} from '@esrs/shared';
import { Router } from 'express';
import { buildMeta, sendCreated, sendList } from '../../http/respond.js';
import { parseBody, parseParams, parseQuery } from '../../http/validate.js';
import { currentRequestId } from '../../middleware/requestContext.js';
import { currentActor, requirePermission } from '../../middleware/requirePermission.js';
import type { RequestActivityService } from './request.activity.service.js';

/**
 * Comment and activity-timeline endpoints (docs/api-specification.md §7).
 *
 * Mounted as a sub-router of `/requests/:id` (`Router({ mergeParams: true })`), so it inherits the
 * business identity gate and the path parameter without a second `api.use('/requests', …)` chain that
 * would authenticate the same request twice.
 *
 * The gates here are coarse on purpose — "may this role ever read or write a comment" — because the
 * object-level question ("may this actor see *this* request") needs the row, and `RequestActivityService`
 * answers it with the request module's own scope rule before it touches the thread. Reading is gated
 * twice on the timeline: it merges the activity trail and the comment bodies, so a caller needs both
 * permissions, and internal notes are then filtered out of the result set for anyone below agent.
 */
export function createActivityRouter(service: RequestActivityService): Router {
  const router = Router({ mergeParams: true });

  /**
   * `GET /requests/{id}/comments` — the thread, oldest first. An actor below agent gets the `public`
   * rows only, and the filter is applied in the query rather than after it, so the page size, the total
   * and the payload all describe the same, already-authorised set.
   */
  router.get('/comments', requirePermission('comment.read'), async (req, res) => {
    const { id } = parseParams(requestCommentParamsSchema, req);
    const query = parseQuery(listCommentsQuerySchema, req);
    const { items, total } = await service.listComments(id, query, currentActor(req, res));
    sendList(res, items, buildMeta(query.page, query.page_size, total));
  });

  /**
   * `POST /requests/{id}/comments` — 201 with the stored comment. `body` is validated by
   * `createCommentBodySchema`: trimmed, 1–5000 characters, and `.strict()`, so an author or a timestamp
   * cannot be smuggled in as an extra key.
   */
  router.post('/comments', requirePermission('comment.create'), async (req, res) => {
    const { id } = parseParams(requestCommentParamsSchema, req);
    const body = parseBody(createCommentBodySchema, req);
    const comment = await service.addComment(id, body, currentActor(req, res), currentRequestId());
    sendCreated(res, comment);
  });

  /**
   * `GET /requests/{id}/timeline` — lifecycle events and comments in one chronological feed, bounded by
   * `limit` (default 100, max 200) so a long-running ticket cannot turn its detail page into an
   * unbounded read of two append-only tables.
   */
  router.get(
    '/timeline',
    requirePermission('request.events.read'),
    requirePermission('comment.read'),
    async (req, res) => {
      const { id } = parseParams(requestCommentParamsSchema, req);
      const { limit } = parseQuery(requestTimelineQuerySchema, req);
      const entries = await service.timeline(id, limit, currentActor(req, res));
      sendList(res, entries, buildMeta(1, limit, entries.length));
    },
  );

  return router;
}
