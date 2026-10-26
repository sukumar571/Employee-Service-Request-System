import {
  changePasswordBodySchema,
  loginBodySchema,
  loginResultSchema,
  meResultSchema,
  safeUserSchema,
} from '@esrs/shared';
import { Router, type Request, type Response } from 'express';
import { API_BASE_PATH } from '../../config/version.js';
import type { AppConfig } from '../../config/env.js';
import { parseBody } from '../../http/validate.js';
import { sendNoContent, sendResource } from '../../http/respond.js';
import { authenticate, passwordChangeGate } from '../../middleware/authenticate.js';
import { loginRateLimiter } from '../../middleware/rateLimit.js';
import type { AuthService } from './auth.service.js';

/** Name of the httpOnly cookie carrying the opaque refresh token. */
export const REFRESH_COOKIE = 'esrs_refresh';

const DAY_MS = 86_400_000;

/**
 * Authentication endpoints (docs/api-specification.md §3).
 *
 * Token transport trade-off (docs/security-plan.md §3): the short-lived access token is returned in
 * the JSON body for the SPA to keep **in memory only** (never localStorage — XSS-Readable). The
 * long-lived refresh token is delivered as an `HttpOnly` (+`Secure` in prod, `SameSite=Lax`) cookie
 * the script cannot read, and is rotated on every use with family reuse-detection. Because the
 * cookie is sent automatically, the mutating refresh/logout routes are additionally protected by an
 * `Origin`-aware CORS policy (credentials are only enabled for the allowlisted web origin), which is
 * our CSRF posture for a same-site SPA. A request may also supply the refresh token in the body
 * (`{ refresh_token }`) — used by non-browser clients and the test suite; the cookie always wins.
 */
export function createAuthRouter(service: AuthService, config: AppConfig): Router {
  const router = Router();
  const cookiePath = API_BASE_PATH ? `${API_BASE_PATH}/auth` : '/auth';
  const maxAgeMs = config.auth.refreshTokenTtlDays * DAY_MS;

  const setRefreshCookie = (res: Response, token: string): void => {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
      path: cookiePath,
      maxAge: maxAgeMs,
    });
  };
  const clearRefreshCookie = (res: Response): void => {
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
      path: cookiePath,
    });
  };
  const readRefresh = (req: Request): string | undefined => {
    const fromCookie: unknown = req.cookies?.[REFRESH_COOKIE];
    if (typeof fromCookie === 'string' && fromCookie) return fromCookie;
    const fromBody = (req.body as { refresh_token?: unknown } | undefined)?.refresh_token;
    return typeof fromBody === 'string' && fromBody ? fromBody : undefined;
  };

  // --- public ---
  router.post('/login', loginRateLimiter(config), async (req, res) => {
    const body = parseBody(loginBodySchema, req);
    const session = await service.login(body);
    setRefreshCookie(res, session.refreshToken);
    // Contract assertion: what we send must satisfy the published login schema (never a hash).
    sendResource(res, loginResultSchema.parse(session.result));
  });

  router.post('/refresh', async (req, res) => {
    const session = await service.refresh(readRefresh(req));
    setRefreshCookie(res, session.refreshToken);
    sendResource(res, loginResultSchema.parse(session.result));
  });

  // Logout is safe to call anonymously/unauthenticated: it just burns the presented family.
  router.post('/logout', async (req, res) => {
    await service.logout(readRefresh(req));
    clearRefreshCookie(res);
    sendNoContent(res);
  });

  // --- authenticated ---
  router.get(
    '/me',
    authenticate(service),
    passwordChangeGate(),
    async (req, res) => {
      // No :id — always the caller's own record (IDOR-safe by construction).
      const claims = req.authClaims;
      if (!claims) throw new Error('authenticate did not populate claims');
      sendResource(res, meResultSchema.parse(await service.me(claims.userId)));
    },
  );

  // change-password is authenticated but NOT behind passwordChangeGate — it is how the user escapes
  // the forced-change state.
  router.post('/change-password', authenticate(service), async (req, res) => {
    const claims = req.authClaims;
    if (!claims) throw new Error('authenticate did not populate claims');
    const body = parseBody(changePasswordBodySchema, req);
    const user = await service.changePassword(claims, body);
    // Every session is invalidated by a password change; drop the refresh cookie so the client must
    // re-authenticate (safe client-side session cleanup, docs/security-plan.md §2).
    clearRefreshCookie(res);
    sendResource(res, safeUserSchema.parse(user));
  });

  return router;
}
