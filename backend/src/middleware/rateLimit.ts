import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';
import type { AppConfig } from '../config/env.js';
import { AppError } from '../lib/errors/appError.js';
import { currentRequestId } from './requestContext.js';

/**
 * Login throttle (docs/security-plan.md §4.1, NFR). A per-IP fixed window limits credential
 * stuffing independently of the per-account lockout, so one attacker cycling many emails is slowed
 * even though each individual account keeps its own counter. On the limit we emit the standard
 * error envelope with `RATE_LIMITED` (429) rather than express-rate-limit's plain-text default.
 *
 * Keyed on `req.ip`, which respects `trust proxy` (0 hops locally → never spoofable via
 * X-Forwarded-For). Successful logins are not skipped: an endpoint that only counts failures still
 * lets an attacker probe unlimited valid/invalid combos within the window.
 */
export function loginRateLimiter(config: AppConfig): RequestHandler {
  return rateLimit({
    windowMs: config.rateLimit.windowMs,
    limit: config.rateLimit.loginMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => {
      const error = new AppError(
        'RATE_LIMITED',
        'Too many login attempts. Please try again later.',
      );
      res.status(error.status).json(error.toBody(currentRequestId()));
    },
  });
}
