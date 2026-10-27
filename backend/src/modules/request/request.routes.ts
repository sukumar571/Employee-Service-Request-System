import {
  assignRequestBodySchema,
  closeRequestBodySchema,
  createRequestBodySchema,
  emptyRequestBodySchema,
  listRequestsQuerySchema,
  patchRequestBodySchema,
  reasonRequestBodySchema,
  requestEventsParamsSchema,
  requestEventsQuerySchema,
  requestIdParamsSchema,
  type RequestDetail,
  resolveRequestBodySchema,
  reopenRequestBodySchema,
  transitionRequestBodySchema,
} from '@esrs/shared';
import { Router, type Request, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { can, roleAtLeast, type RbacAction, type RbacActor } from '../../domain/rbac/policy.js';
import { buildMeta, sendCreated, sendList, sendResource } from '../../http/respond.js';
import { parseBody, parseParams, parseQuery } from '../../http/validate.js';
import { badRequest, forbidden, unauthorized } from '../../lib/errors/httpErrors.js';
import { currentRequestId } from '../../middleware/requestContext.js';
import {
  currentActor,
  requirePermission,
  resolveActor,
} from '../../middleware/requirePermission.js';
import type { RequestActivityService } from './request.activity.service.js';
import { createActivityRouter } from './request.activity.routes.js';
import type { RequestService } from './request.service.js';

/**
 * Service-request endpoints (docs/api-specification.md §6).
 *
 * Each route does four things and nothing else: gate on an RBAC action, parse an input schema, call
 * the service, wrap the response. Every rule that could conceivably vary — who may see which rows,
 * whether a transition is legal, which fields are protected — lives in `RequestService`, because the
 * generic `/transition` endpoint carries its action in the body where a route-level middleware cannot
 * inspect it. The routes therefore gate coarsely and the service decides.
 *
 * `sendResource`/`sendList` produce the `{data}` / `{data, meta}` envelopes, and the service has
 * already parsed its own return value through the response schema, so a malformed payload fails at
 * the service boundary rather than being serialised to a client.
 */

/** `ETag` carries the optimistic-concurrency version, so `If-Match` round-trips without a body field. */
function etag(version: number): string {
  return `"${version}"`;
}

/** `Array.isArray()` on its own narrows `unknown` to `any[]`; this keeps the value unknown. */
const isHeaderList = (value: unknown): value is readonly unknown[] => Array.isArray(value);

/**
 * Express types header lookups loosely, so the value is pinned to `unknown` and normalised here. A
 * repeated header contributes its first token rather than a guessed one.
 */
function headerToken(req: Request, name: string): string {
  const value: unknown = req.header(name);
  if (typeof value === 'string') return value;
  const first = isHeaderList(value) ? value[0] : undefined;
  return typeof first === 'string' ? first : '';
}

/**
 * Parses the `If-Match` precondition header. Absent means "last write wins"; a malformed token is a
 * 400 rather than a silently ignored precondition, because ignoring it would let a stale client edit
 * a ticket it never read.
 */
function expectedVersion(req: Request): number | null {
  // `W/"3"`, `"3"` and `3` all name version 3: the notation is normalised, the value never is.
  const token = headerToken(req, 'if-match').replace(/^W\//, '').replaceAll('"', '').trim();
  if (token === '' || token === '*') return null;
  const value = Number(token);
  if (!Number.isInteger(value) || value < 0) {
    throw badRequest('If-Match must be a version number, e.g. If-Match: "3"');
  }
  return value;
}

/**
 * Read gate for the list/detail endpoints. Visibility is a spectrum — an employee reads their own
 * tickets, an agent reads their team's queue, a manager reads everything — and the RBAC matrix already
 * encodes those three tiers as separate actions. Picking the actor's own tier keeps the matrix
 * meaningful (a denied role still gets a 403) instead of gating on the most permissive action and
 * relying solely on the service to narrow the rows.
 */
function requireRead(): RequestHandler {
  return (req, res, next) => {
    const actor = resolveActor(req);
    if (actor.role === 'anonymous') {
      next(unauthorized('Authentication is required for this operation'));
      return;
    }
    const action: RbacAction = roleAtLeast(actor, 'manager')
      ? 'request.read.all'
      : actor.role === 'agent'
        ? 'request.read.team'
        : 'request.read.own';
    if (!can(actor, action)) {
      next(forbidden(`Role '${actor.role}' may not read requests`));
      return;
    }
    res.locals.actor = actor;
    next();
  };
}

/** What every action endpoint has in common, resolved before the body is even looked at. */
interface ActionContext {
  readonly id: string;
  readonly actor: RbacActor;
  readonly requestId: string | undefined;
  readonly version: number | null;
}

/**
 * One action route: `{id}` from the path, `B` from the body schema, the updated resource back out.
 * Typed on the schema so each call site receives a correctly typed body and the service keeps its
 * per-action signature — no casts, and a new endpoint cannot forget to parse its payload.
 */
function actionRoute<B>(
  schema: ZodType<B>,
  run: (ctx: ActionContext, body: B) => Promise<RequestDetail>,
): RequestHandler {
  return async (req, res) => {
    const ctx: ActionContext = {
      id: parseParams(requestIdParamsSchema, req).id,
      actor: currentActor(req, res),
      requestId: currentRequestId(),
      version: expectedVersion(req),
    };
    const result = await run(ctx, parseBody(schema, req));
    res.setHeader('ETag', etag(result.version));
    sendResource(res, result);
  };
}

export function createRequestRouter(
  service: RequestService,
  activity: RequestActivityService,
): Router {
  const router = Router();

  // -- Creation and reads -----------------------------------------------------

  /** `POST /requests` — `draft: true` saves a draft, otherwise the full pipeline runs (201). */
  router.post('/', requirePermission('request.create'), async (req, res) => {
    const body = parseBody(createRequestBodySchema, req);
    const created = await service.create(body, currentActor(req, res), currentRequestId());
    res.setHeader('ETag', etag(created.version));
    sendCreated(res, created);
  });

  /** `GET /requests` — scoped rows with pagination, filtering, sorting and search. */
  router.get('/', requireRead(), async (req, res) => {
    const query = parseQuery(listRequestsQuerySchema, req);
    // The signed sort token (`-submitted_at`) is stripped by the schema, so ordering needs the raw one.
    const { items, total } = await service.list(query, req.query.sort, currentActor(req, res));
    sendList(res, items, buildMeta(query.page, query.page_size, total));
  });

  /** `GET /requests/{id}` — a row outside the caller's scope is a 404, so ids cannot be probed. */
  router.get('/:id', requireRead(), async (req, res) => {
    const detail = await service.get(
      parseParams(requestIdParamsSchema, req).id,
      currentActor(req, res),
    );
    res.setHeader('ETag', etag(detail.version));
    sendResource(res, detail);
  });

  /**
   * `GET /requests/{id}/events` — the append-only trail, readable by anyone who can see the row. The
   * one filtered thing in it is the `comment_added` marker of an internal note, which follows the
   * comment's own visibility rather than the request's (`docs/api-specification.md` §6.4, §7).
   */
  router.get('/:id/events', requirePermission('request.events.read'), async (req, res) => {
    const { id } = parseParams(requestEventsParamsSchema, req);
    const { limit } = parseQuery(requestEventsQuerySchema, req);
    const events = await service.events(id, currentActor(req, res), limit);
    sendList(res, events, buildMeta(1, limit, events.length));
  });

  // -- Editing ----------------------------------------------------------------

  /**
   * `PATCH /requests/{id}` — draft content by the owner, priority by a manager. The body schema is
   * `.strict()`, which is what makes the protected workflow fields (`status`, `assignee_id`,
   * `request_number`, `version`) a 400 that names the offending key.
   */
  router.patch('/:id', requirePermission('request.update'), async (req, res) => {
    const { id } = parseParams(requestIdParamsSchema, req);
    const body = parseBody(patchRequestBodySchema, req);
    const updated = await service.edit(
      id,
      body,
      currentActor(req, res),
      expectedVersion(req),
      currentRequestId(),
    );
    res.setHeader('ETag', etag(updated.version));
    sendResource(res, updated);
  });

  // -- Lifecycle actions ------------------------------------------------------

  // `submit` and the four no-body actions share the shape: `{}` is accepted, anything else is a 400.
  router.post(
    '/:id/submit',
    requirePermission('request.create'),
    actionRoute(emptyRequestBodySchema, ({ id, actor, requestId, version }) =>
      service.submit(id, actor, version, requestId),
    ),
  );
  router.post(
    '/:id/claim',
    requirePermission('request.claim'),
    actionRoute(emptyRequestBodySchema, ({ id, actor, requestId, version }) =>
      service.claim(id, actor, version, requestId),
    ),
  );
  router.post(
    '/:id/start',
    requirePermission('request.transition'),
    actionRoute(emptyRequestBodySchema, ({ id, actor, requestId, version }) =>
      service.start(id, actor, version, requestId),
    ),
  );
  router.post(
    '/:id/resume',
    requirePermission('request.transition'),
    actionRoute(emptyRequestBodySchema, ({ id, actor, requestId, version }) =>
      service.resume(id, actor, version, requestId),
    ),
  );

  router.post(
    '/:id/hold',
    requirePermission('request.transition'),
    actionRoute(reasonRequestBodySchema, ({ id, actor, requestId, version }, body) =>
      service.hold(id, body, actor, version, requestId),
    ),
  );
  router.post(
    '/:id/cancel',
    requirePermission('request.cancel'),
    actionRoute(reasonRequestBodySchema, ({ id, actor, requestId, version }, body) =>
      service.cancel(id, body, actor, version, requestId),
    ),
  );
  router.post(
    '/:id/reopen',
    requirePermission('request.reopen'),
    actionRoute(reopenRequestBodySchema, ({ id, actor, requestId, version }, body) =>
      service.reopen(id, body, actor, version, requestId),
    ),
  );
  router.post(
    '/:id/resolve',
    requirePermission('request.resolve'),
    actionRoute(resolveRequestBodySchema, ({ id, actor, requestId, version }, body) =>
      service.resolve(id, body, actor, version, requestId),
    ),
  );
  router.post(
    '/:id/close',
    requirePermission('request.close'),
    actionRoute(closeRequestBodySchema, ({ id, actor, requestId, version }, body) =>
      service.close(id, body, actor, version, requestId),
    ),
  );

  /** `POST /requests/{id}/assign` — manager+ only (ST-304); the target must be an active agent. */
  router.post(
    '/:id/assign',
    requirePermission('request.assign'),
    actionRoute(assignRequestBodySchema, ({ id, actor, requestId, version }, body) =>
      service.assign(id, body, actor, version, requestId),
    ),
  );

  /**
   * `POST /requests/{id}/transition` — the generic chokepoint. The route can only check that the
   * caller may read requests at all; `RequestService.act()` re-checks the permission for the action
   * the body actually names, so this endpoint cannot be used to bypass `/assign`'s manager gate.
   */
  router.post(
    '/:id/transition',
    requireRead(),
    actionRoute(transitionRequestBodySchema, ({ id, actor, requestId, version }, body) =>
      service.transition(id, body, actor, version, requestId),
    ),
  );

  /**
   * Comments and the activity timeline (docs/api-specification.md §7). Registered last so the
   * routes above keep their exact precedence, and merged on `:id` so a thread inherits the identity
   * gate and the request-scoped path parameter instead of re-declaring both.
   */
  router.use('/:id', createActivityRouter(activity));

  return router;
}
