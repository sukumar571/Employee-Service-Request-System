import type { Request } from 'express';
import type { z, ZodType } from 'zod';
import { validationError } from '../lib/errors/httpErrors.js';

/**
 * Zod parsing at the HTTP boundary (docs/system-architecture.md §2: same schemas as the frontend).
 * Unknown keys are stripped by object() defaults; `.strict()` input schemas reject them outright.
 * `z.infer<T>` keeps the parsed value typed at the call site, so routes never cast `req.body`.
 */
function parse<T extends ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw validationError(result.error.issues);
  }
  return result.data;
}

export const parseParams = <T extends ZodType>(schema: T, req: Request): z.infer<T> =>
  parse(schema, req.params);

export const parseQuery = <T extends ZodType>(schema: T, req: Request): z.infer<T> =>
  parse(schema, req.query);

export const parseBody = <T extends ZodType>(schema: T, req: Request): z.infer<T> =>
  parse(schema, req.body);
