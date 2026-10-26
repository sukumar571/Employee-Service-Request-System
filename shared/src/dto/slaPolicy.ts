import { z } from 'zod';
import { requestPrioritySchema, slaStateSchema } from '../enums/index.js';
import type { RequestPriority } from '../enums/index.js';

/** Business-hours window definition stored on each SLA policy (docs/requirements.md §8). */
export const businessHoursSchema = z.object({
  /** ISO day numbers: 1 = Monday … 7 = Sunday. */
  days: z.array(z.number().int().min(1).max(7)).min(1),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM in 24h format'),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM in 24h format'),
  timezone: z.string().min(1),
});
export type BusinessHours = z.infer<typeof businessHoursSchema>;

export const slaPolicyDtoSchema = z.object({
  priority: requestPrioritySchema,
  first_response_minutes: z.number().int().positive(),
  resolution_minutes: z.number().int().positive(),
  business_hours: businessHoursSchema,
  updated_at: z.string().optional(),
  updated_by: z.string().optional(),
});
export type SlaPolicyDto = z.infer<typeof slaPolicyDtoSchema>;

/** `GET /sla/policies` body: the full set is small and never paginated, so it is a plain array. */
export const slaPolicyListSchema = z.array(slaPolicyDtoSchema);

/** `PUT /sla/policies/:priority` — manager+ only (docs/api-specification.md §9). */
export const updateSlaPolicyParamsSchema = z.object({ priority: requestPrioritySchema });
export const updateSlaPolicyBodySchema = z
  .object({
    first_response_minutes: z.number().int().min(5).max(10080),
    resolution_minutes: z.number().int().min(15).max(43200),
    reason: z.string().trim().min(10, 'A reason of at least 10 characters is required'),
  })
  .strict();
export type UpdateSlaPolicyBody = z.infer<typeof updateSlaPolicyBodySchema>;

/** SLA state carried on request list/detail payloads. */
export const slaSummarySchema = z.object({
  first_response_due_at: z.string().nullable(),
  resolution_due_at: z.string().nullable(),
  resolution_business_minutes_remaining: z.number().int().nullable(),
  state: slaStateSchema,
});
export type SlaSummary = z.infer<typeof slaSummarySchema>;

export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  days: [1, 2, 3, 4, 5],
  start: '09:00',
  end: '18:00',
  timezone: 'Asia/Kolkata',
};

/**
 * Initial policy table (docs/requirements.md §8) expressed in BUSINESS minutes.
 * Used by the database seed and by the provisional in-memory repository, so demo data and code
 * can never disagree about the targets.
 */
export const DEFAULT_SLA_POLICIES: Readonly<
  Record<
    RequestPriority,
    {
      first_response_minutes: number;
      resolution_minutes: number;
    }
  >
> = {
  critical: { first_response_minutes: 30, resolution_minutes: 240 }, // 4 business-h
  high: { first_response_minutes: 120, resolution_minutes: 1440 }, // 24 business-h
  medium: { first_response_minutes: 240, resolution_minutes: 1620 }, // 3 business days
  low: { first_response_minutes: 480, resolution_minutes: 2700 }, // 5 business days
};

/** Warning threshold — SLA alert fires at 75 % of elapsed business time (FR-16). */
export const SLA_WARNING_RATIO = 0.75;
