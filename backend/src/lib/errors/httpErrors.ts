import type { z } from 'zod';
import { AppError } from './appError.js';

/** Factory helpers so call sites stay one-liners and codes/statuses stay consistent. */

export const badRequest = (message = 'Malformed request'): AppError =>
  new AppError('BAD_REQUEST', message);

/** Element type of `ZodError.issues`; zod 4 does not export a standalone alias for it. */
type ZodIssue = z.ZodError['issues'][number];

/**
 * A `.strict()` object reports an unrecognized key at the root, so the offending name would only
 * survive inside the prose of `issue.message`. Clients that highlight fields need the path, and a
 * rejected protected workflow field (`status`, `assignee_id`, …) is exactly the case where naming the
 * key in `path` is the whole point of the response.
 */
const issuePath = (issue: ZodIssue): string => {
  const joined = issue.path.join('.');
  if (joined) return joined;
  if (issue.code === 'unrecognized_keys' && issue.keys.length > 0) return issue.keys.join('.');
  return '(root)';
};

export const validationError = (
  issues: readonly ZodIssue[],
  message = 'Invalid request payload',
): AppError =>
  new AppError('VALIDATION_ERROR', message, {
    details: issues.map((issue) => ({
      path: issuePath(issue),
      message: issue.message,
    })),
  });

export const unauthorized = (message = 'Authentication required'): AppError =>
  new AppError('UNAUTHENTICATED', message);

export const forbidden = (message = 'You do not have access to this resource'): AppError =>
  new AppError('FORBIDDEN', message);

export const notFound = (resource = 'Resource'): AppError =>
  new AppError('NOT_FOUND', `${resource} not found`);

export const conflict = (message: string, details?: AppError['details']): AppError =>
  new AppError('CONFLICT', message, { details });

export const invalidTransition = (from: string, action: string): AppError =>
  new AppError('INVALID_TRANSITION', `Cannot ${action} a request in status '${from}'`);

export const serviceUnavailable = (message = 'Dependency unavailable'): AppError =>
  new AppError('SERVICE_UNAVAILABLE', message);

export const internal = (cause: unknown): AppError => AppError.fromUnknown(cause);
