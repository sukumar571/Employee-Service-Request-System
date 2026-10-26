import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { forbidden, unauthorized } from '../lib/errors/httpErrors.js';
import type { RbacAction, RbacActor } from '../domain/rbac/policy.js';
import { ANONYMOUS_ACTOR, can } from '../domain/rbac/policy.js';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: RbacActor;
    /** Set by the authenticate middleware from the verified token's `mcp` claim. */
    authMustChangePassword?: boolean;
  }
  interface Locals {
    actor?: RbacActor;
  }
}

/** Identity recorded by the authentication middleware, or the anonymous actor. */
export function resolveActor(req: Request): RbacActor {
  return req.auth ?? ANONYMOUS_ACTOR;
}

/** Actor recorded by `requirePermission`, falling back to the request's identity. */
export function currentActor(req: Request, res: Response): RbacActor {
  return res.locals.actor ?? resolveActor(req);
}

/**
 * Authorization gate (docs/security-plan.md §4). `req.auth` is populated by the `authenticate`
 * middleware from a verified JWT; when it is absent the actor is anonymous and the request fails
 * closed (401). The resolver never reads a client-controlled header or body for the role, so a
 * frontend cannot escalate itself by asserting a different role (security-plan §4).
 */
export function requirePermission(action: RbacAction): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const actor = resolveActor(req);
    if (actor.role === 'anonymous') {
      next(unauthorized('Authentication is required for this operation'));
      return;
    }
    if (!can(actor, action)) {
      next(forbidden(`Role '${actor.role}' may not perform '${action}'`));
      return;
    }
    res.locals.actor = actor;
    next();
  };
}
