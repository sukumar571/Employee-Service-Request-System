import type { RequestHandler } from 'express';
import { notFound as notFoundError } from '../lib/errors/httpErrors.js';

/** 404 for unmatched routes — uses the standard error envelope, no HTML error pages. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(notFoundError(`Route ${req.method} ${req.baseUrl ?? ''}${req.path}`));
};
