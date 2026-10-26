import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface RequestContext {
  readonly requestId: string;
  readonly startedAtMs: number;
  /** Filled in by the authentication middleware (Phase 5). */
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

const SAFE_INCOMING_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Establishes a per-request context and echoes `x-request-id` so logs, errors and the client
 * can be correlated (docs/system-architecture.md §9). A client-supplied id is accepted only when
 * it is safely shaped, otherwise a fresh UUID is generated (log-injection defence).
 */
export function requestContext(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const supplied = req.header('x-request-id');
    const requestId = supplied && SAFE_INCOMING_ID.test(supplied) ? supplied : randomUUID();
    res.setHeader('x-request-id', requestId);
    storage.run({ requestId, startedAtMs: Date.now() }, () => next());
  };
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}
