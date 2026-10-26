import type { ApiErrorCode } from '@esrs/shared';
import { ZodError } from 'zod';
import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors/appError.js';
import { validationError } from '../lib/errors/httpErrors.js';
import type { Logger } from '../lib/logger.js';
import { currentRequestId } from './requestContext.js';

/**
 * Central error handler — the single place where errors become HTTP responses
 * (docs/system-architecture.md §4, docs/api-specification.md §1.1).
 * Express 5 forwards rejected async handlers here automatically, so routes need no try/catch.
 */

interface BodyParserError extends Error {
  status?: number;
  statusCode?: number;
  type?: string;
  errno?: string;
  limit?: number;
}

/** Translate framework/dependency errors into the AppError contract. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof ZodError) {
    return validationError(error.issues);
  }

  const asBodyError = error as BodyParserError | undefined;
  const status = asBodyError?.status ?? asBodyError?.statusCode;

  if (asBodyError?.type === 'entity.parse.failed') {
    return new AppError('BAD_REQUEST', 'Request body is not valid JSON', { cause: error });
  }
  if (status === 413 || asBodyError?.type === 'entity.too.large') {
    return new AppError('FILE_TOO_LARGE', 'Payload too large', { cause: error });
  }
  if (status === 404 && asBodyError?.type === 'route.parse') {
    return new AppError('NOT_FOUND', 'Route not found');
  }
  // Body-parser/express errors with a 4xx status keep their meaning but lose their internals.
  if (typeof status === 'number' && status >= 400 && status < 600) {
    const code: ApiErrorCode = status === 400 ? 'BAD_REQUEST' : 'INTERNAL';
    return new AppError(code, status === 400 ? 'Malformed request' : 'Request failed', {
      status,
      cause: error,
    });
  }

  return new AppError('INTERNAL', 'An unexpected error occurred', { cause: error });
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    const appError = toAppError(error);
    const requestId = currentRequestId();

    const payload = {
      request_id: requestId,
      method: req.method,
      path: req.path,
      status: appError.status,
      code: appError.code,
    };

    if (appError.status >= 500) {
      logger.error({ ...payload, err: appError.cause ?? appError }, appError.message);
    } else {
      logger.warn(payload, appError.message);
    }

    if (res.headersSent) {
      next(error);
      return;
    }

    res.status(appError.status).json(appError.toBody(requestId));
  };
}
