import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AccessClaims } from '../modules/auth/auth.tokens.js';
import type { AuthService } from '../modules/auth/auth.service.js';
import { AppError } from '../lib/errors/appError.js';
import { unauthorized } from '../lib/errors/httpErrors.js';
import { getRequestContext } from './requestContext.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Full verified claim set; `req.auth` is the RBAC projection of this. */
    authClaims?: AccessClaims;
  }
}

/**
 * Authentication gate (docs/security-plan.md §3). Reads the `Authorization: Bearer <jwt>` header,
 * verifies it through the auth service and records the trusted identity on the request. It NEVER
 * reads a role from the query/body/cookie — the role comes only from the signed token, so a client
 * cannot escalate itself (docs/security-plan.md §4 "never trust a client-supplied role").
 *
 * Verification is pure (no user lookup), so a revoked/deactivated user's still-valid short-lived
 * token is caught at the next privileged read (service re-checks `is_active`) and at refresh.
 */
export function authenticate(service: AuthService): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.header('authorization');
    const scheme = 'Bearer ';
    if (!header?.startsWith(scheme)) {
      next(unauthorized('Authentication is required for this operation'));
      return;
    }
    const token = header.slice(scheme.length).trim();
    if (!token) {
      next(unauthorized('Authentication is required for this operation'));
      return;
    }

    try {
      const claims = service.verifyAccessToken(token);
      req.authClaims = claims;
      req.auth = {
        userId: claims.userId,
        role: claims.role,
        teamCategoryId: claims.teamCategoryId,
      };
      req.authMustChangePassword = claims.mustChangePassword;
      // Correlate subsequent log/audit rows with the authenticated subject.
      const ctx = getRequestContext();
      if (ctx) ctx.userId = claims.userId;
      next();
    } catch (error) {
      // verifyAccessToken throws a typed AppError (TOKEN_EXPIRED / UNAUTHENTICATED); forward it so
      // the centralized handler renders the standard envelope with the right status code.
      next(error instanceof AppError ? error : AppError.fromUnknown(error));
    }
  };
}

/**
 * Forced-password-change gate (ST-104). Once a user is authenticated but still flagged
 * `must_change_password`, every non-auth endpoint is blocked until they change it. The change
 * endpoint itself is deliberately mounted without this gate so the user can always escape the state.
 */
export function passwordChangeGate(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.auth && req.authClaims?.mustChangePassword) {
      next(
        new AppError(
          'PASSWORD_CHANGE_REQUIRED',
          'You must change your temporary password before using this endpoint',
        ),
      );
      return;
    }
    next();
  };
}
