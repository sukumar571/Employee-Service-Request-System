import {
  apiErrorBodySchema,
  listResponseSchema,
  resourceSchema,
  type ErrorIssue,
  type ApiErrorCode,
  type PaginationMeta,
} from '@esrs/shared';
import type { ZodType } from 'zod';
import { API_BASE_URL } from './config';

/**
 * The single HTTP boundary of the SPA (docs/system-architecture.md §2).
 *
 * Responsibilities:
 *  - build URLs against the versioned base path;
 *  - send `x-request-id` so a support ticket can be matched to backend logs;
 *  - parse the success envelope AND validate it against the shared Zod schema, so a contract
 *    change fails loudly in development instead of producing `undefined` in a component;
 *  - translate every error envelope into a typed `ApiError` with the code, and never leak
 *    a 5xx body into the UI beyond the safe message.
 */

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status: number,
    readonly requestId?: string,
    readonly details?: ErrorIssue[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
  /** Optimistic concurrency: sends `If-Match: "<version>"` (docs/api-specification.md §1.2). */
  readonly expectedVersion?: number | string;
}

function headersFor(options: RequestOptions, hasBody: boolean): HeadersInit {
  return {
    Accept: 'application/json',
    'x-request-id': newRequestId(),
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...(options.expectedVersion === undefined
      ? {}
      : { 'If-Match': String(options.expectedVersion) }),
  };
}

/** Falls back to a random id where `crypto.randomUUID` is unavailable (older browsers). */
function newRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `web-${Date.now()}-${Math.random()}`;
}

async function toApiError(response: Response): Promise<ApiError> {
  const requestId = response.headers.get('x-request-id') ?? undefined;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return new ApiError(
      'INTERNAL',
      `Unexpected empty response (${response.status})`,
      response.status,
      requestId,
    );
  }

  const parsed = apiErrorBodySchema.safeParse(payload);
  if (!parsed.success) {
    // A 4xx/5xx without our envelope means a proxy or framework produced it: hide the internals.
    return new ApiError(
      response.status >= 500 ? 'INTERNAL' : 'BAD_REQUEST',
      response.statusText || 'Request failed',
      response.status,
      requestId,
    );
  }
  const error = parsed.data.error;
  return new ApiError(error.code, error.message, response.status, requestId, error.details);
}

async function request<T>(
  path: string,
  init: RequestInit,
  schema: ZodType<T>,
  options: RequestOptions,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: headersFor(options, init.body !== undefined),
      credentials: 'include', // refresh cookie arrives in Phase 5; harmless before that
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('SERVICE_UNAVAILABLE', 'Cannot reach the server. Check your connection.', 0);
  }

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return schema.parse(undefined);

  const body: unknown = await response.json();
  return schema.parse(body);
}

/** `GET` a single `{ data }` resource. */
export function getResource<T>(
  path: string,
  schema: ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  return request(
    path,
    { method: 'GET' },
    resourceSchema(schema).transform((envelope) => envelope.data),
    options,
  );
}

/** `GET` a paginated `{ data, meta }` list, returning both. */
export function getList<T>(
  path: string,
  itemSchema: ZodType<T>,
  options: RequestOptions = {},
): Promise<{ data: T[]; meta: PaginationMeta }> {
  return request(path, { method: 'GET' }, listResponseSchema(itemSchema), options);
}

/** `POST`/`PUT` with a JSON body, reading the response as a single resource. */
export function sendResource<TBody, TResponse>(
  method: 'POST' | 'PUT' | 'PATCH',
  path: string,
  body: TBody,
  schema: ZodType<TResponse>,
  options: RequestOptions = {},
): Promise<TResponse> {
  return request(
    path,
    { method, body: JSON.stringify(body) },
    resourceSchema(schema).transform((envelope) => envelope.data),
    options,
  );
}

/** Query string builder that drops empty values so URLs stay readable and stable. */
export function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

/**
 * User-safe message for any thrown value. Unexpected errors must not leak internals
 * (docs/security-plan.md §5), so only `ApiError` messages are shown verbatim.
 */
export function toUserMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status >= 500) return 'The service could not complete the request.';
    return error.message;
  }
  if (error instanceof Error && error.name === 'AbortError') return 'Request cancelled.';
  return 'Something went wrong while loading this page.';
}
