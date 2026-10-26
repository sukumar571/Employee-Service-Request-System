import type { ApiErrorCode } from '@esrs/shared';

/**
 * Single mapping from API error code to HTTP status (docs/api-specification.md §1.1).
 * Kept next to the code list's backend counterpart so a new code cannot ship without a status.
 */
export const STATUS_FOR_ERROR_CODE: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  REFRESH_REUSE: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  OUT_OF_TEAM_SCOPE: 403,
  PASSWORD_CHANGE_REQUIRED: 403,
  NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  CONFLICT: 409,
  LAST_ADMIN_GUARD: 409,
  ASSIGNEE_HAS_OPEN_TICKETS: 409,
  REOPEN_WINDOW_EXPIRED: 409,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_FILE_TYPE: 415,
  INVALID_ASSIGNEE: 422,
  ACCOUNT_LOCKED: 423,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  SERVICE_UNAVAILABLE: 503,
};
