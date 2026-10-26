import { z } from 'zod';
import {
  COMMENT_VISIBILITIES,
  NOTIFICATION_TYPES,
  REQUEST_EVENT_TYPES,
  REQUEST_PRIORITIES,
  REQUEST_STATUSES,
  SLA_STATES,
  USER_ROLES,
  requestPrioritySchema,
  requestStatusSchema,
} from '../enums/index.js';
import { REQUEST_ACTIONS } from '../domain/requestTransitions.js';
import { businessHoursSchema } from './slaPolicy.js';

/** One flattened lifecycle rule as served by `GET /meta`. */
export const lifecycleRuleSchema = z.object({
  from: requestStatusSchema,
  action: z.enum(REQUEST_ACTIONS),
  to: requestStatusSchema,
  roles: z.array(z.enum(USER_ROLES)),
  requester_only: z.boolean(),
  assignee_only: z.boolean(),
  managers_bypass: z.boolean(),
  reason_required: z.boolean(),
});
export type LifecycleRuleWire = z.infer<typeof lifecycleRuleSchema>;

/** `GET /health/ready` and `GET /health/live` payloads (docs/api-specification.md §13.1). */
export const databaseHealthSchema = z.object({
  state: z.enum(['up', 'down', 'not_configured']),
  latency_ms: z.number().nonnegative().optional(),
});
export type DatabaseHealth = z.infer<typeof databaseHealthSchema>;

export const systemStatusSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.string(),
  version: z.string(),
  environment: z.string(),
  uptime_seconds: z.number().nonnegative(),
  timestamp: z.string(),
  database: databaseHealthSchema,
});
export type SystemStatus = z.infer<typeof systemStatusSchema>;

/** `GET /health/live` — process is up; deliberately performs no dependency checks. */
export const livenessSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  environment: z.string(),
  timestamp: z.string(),
});
export type Liveness = z.infer<typeof livenessSchema>;

/**
 * `GET /meta` — exposes the frozen enumerations so the frontend renders selects/badges from the
 * contract instead of duplicating string literals.
 */
export const catalogOptionsSchema = z.object({
  roles: z.array(z.enum(USER_ROLES)),
  statuses: z.array(z.enum(REQUEST_STATUSES)),
  priorities: z.array(z.enum(REQUEST_PRIORITIES)),
  actions: z.array(z.enum(REQUEST_ACTIONS)),
  sla_states: z.array(z.enum(SLA_STATES)),
  comment_visibilities: z.array(z.enum(COMMENT_VISIBILITIES)),
  event_types: z.array(z.enum(REQUEST_EVENT_TYPES)),
  notification_types: z.array(z.enum(NOTIFICATION_TYPES)),
});
export type CatalogOptions = z.infer<typeof catalogOptionsSchema>;

export const apiInfoSchema = z.object({
  service: z.string(),
  api_version: z.string(),
  documentation: z.string(),
});
export type ApiInfo = z.infer<typeof apiInfoSchema>;

/**
 * `GET /meta` body — everything the SPA needs to render selects, badges and the lifecycle
 * diagram from the shared contract instead of duplicating literals (docs/system-architecture.md §2).
 */
export const apiCatalogSchema = z.object({
  contract_version: z.string(),
  api: apiInfoSchema,
  catalog: catalogOptionsSchema,
  transitions: z.array(lifecycleRuleSchema),
  sla: z.object({
    business_hours: businessHoursSchema,
    warning_ratio: z.number().min(0).max(1),
    default_policies: z.record(
      requestPrioritySchema,
      z.object({ first_response_minutes: z.number().int(), resolution_minutes: z.number().int() }),
    ),
  }),
});
export type ApiCatalog = z.infer<typeof apiCatalogSchema>;
