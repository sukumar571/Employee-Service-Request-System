import type { ApiErrorCode, ErrorIssue } from '@esrs/shared';
import { STATUS_FOR_ERROR_CODE } from './statusForCode.js';

/**
 * The only error type allowed to reach the HTTP layer (docs/system-architecture.md §4).
 * Services throw `AppError`; the error handler serialises it into the standard envelope.
 */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: ErrorIssue[];

  constructor(
    code: ApiErrorCode,
    message: string,
    options: { status?: number; details?: ErrorIssue[]; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? STATUS_FOR_ERROR_CODE[code];
    this.details = options.details;
  }

  /** Error envelope body (docs/api-specification.md §1.1). Never contains stack traces. */
  toBody(requestId?: string): { error: Record<string, unknown> } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details && this.details.length > 0 ? { details: this.details } : {}),
        ...(requestId ? { request_id: requestId } : {}),
      },
    };
  }

  /** Safety net: anything unexpected becomes a generic 500 with no internal detail leaked. */
  static fromUnknown(error: unknown): AppError {
    if (error instanceof AppError) return error;
    return new AppError('INTERNAL', 'An unexpected error occurred', { cause: error });
  }
}
