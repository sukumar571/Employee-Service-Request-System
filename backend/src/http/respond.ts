import type { PaginationMeta, Resource, ListResponse } from '@esrs/shared';
import type { Response } from 'express';

/**
 * API response conventions (docs/api-specification.md §1). Every success body is wrapped, so the
 * client never has to guess whether it received a resource, a list or an error.
 */

export function sendResource<T>(res: Response, data: T, status = 200): Response {
  const body: Resource<T> = { data };
  return res.status(status).json(body);
}

export function sendList<T>(
  res: Response,
  data: T[],
  meta: PaginationMeta,
  status = 200,
): Response {
  const body: ListResponse<T> = { data, meta };
  return res.status(status).json(body);
}

export function sendCreated<T>(res: Response, data: T): Response {
  return sendResource(res, data, 201);
}

export function sendNoContent(res: Response): Response {
  return res.status(204).send();
}

/** Convenience for building the `meta` block from a repository total. */
export function buildMeta(page: number, pageSize: number, total: number): PaginationMeta {
  return { page, page_size: pageSize, total };
}
