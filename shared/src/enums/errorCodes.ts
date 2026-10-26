import { z } from 'zod';

/**
 * Append-only API error codes (docs/api-specification.md §1.1, §14).
 * Removing or renaming a code is a breaking change; add new ones instead.
 * HTTP status mapping lives in the backend (`lib/errors/statusForCode.ts`) so this file
 * stays usable from the browser.
 */
export const ERROR_CODES = [
  // 400
  'VALIDATION_ERROR',
  'BAD_REQUEST',
  // 401
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'REFRESH_REUSE',
  'INVALID_CREDENTIALS',
  // 403
  'FORBIDDEN',
  'OUT_OF_TEAM_SCOPE',
  'PASSWORD_CHANGE_REQUIRED',
  // 404
  'NOT_FOUND',
  // 409
  'INVALID_TRANSITION',
  'CONFLICT',
  'LAST_ADMIN_GUARD',
  'ASSIGNEE_HAS_OPEN_TICKETS',
  'REOPEN_WINDOW_EXPIRED',
  // 413 / 415
  'FILE_TOO_LARGE',
  'UNSUPPORTED_FILE_TYPE',
  // 422
  'INVALID_ASSIGNEE',
  // 423
  'ACCOUNT_LOCKED',
  // 429
  'RATE_LIMITED',
  // 5xx
  'INTERNAL',
  'SERVICE_UNAVAILABLE',
] as const;

export const apiErrorCodeSchema = z.enum(ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
