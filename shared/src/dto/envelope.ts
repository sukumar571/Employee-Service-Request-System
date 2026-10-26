import { z } from 'zod';
import { apiErrorCodeSchema } from '../enums/errorCodes.js';

/**
 * HTTP response conventions (docs/api-specification.md §1).
 * Success: `{ data, meta? }` — Error: `{ error: { code, message, details?, request_id? } }`
 * Wire format is snake_case everywhere; camelCase exists only inside TypeScript code.
 */

export const errorIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type ErrorIssue = z.infer<typeof errorIssueSchema>;

export const apiErrorBodySchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    details: z.array(errorIssueSchema).optional(),
    request_id: z.string().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

export const paginationMetaSchema = z.object({
  page: z.number().int().min(1),
  page_size: z.number().int().min(1).max(100),
  total: z.number().int().nonnegative(),
});
export type PaginationMeta = z.infer<typeof paginationMetaSchema>;

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Clamped rather than rejected: oversized requests are a UI accident, not an attack
  // (docs/test-plan.md §2 "pagination clamp").
  page_size: z.coerce
    .number()
    .int()
    .min(1)
    .transform((value) => Math.min(value, 100))
    .default(20),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** `{ data, meta }` list envelope builder (used by every paginated endpoint). */
export function listResponseSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({ data: z.array(itemSchema), meta: paginationMetaSchema });
}

/** `{ data }` single-resource envelope builder. */
export function resourceSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({ data: itemSchema });
}

export interface ListResponse<T> {
  data: T[];
  meta: PaginationMeta;
}
export interface Resource<T> {
  data: T;
}
