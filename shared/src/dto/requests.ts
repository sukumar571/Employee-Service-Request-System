import { z } from 'zod';
import { REQUEST_ACTIONS } from '../domain/requestTransitions.js';
import { requestPrioritySchema, requestStatusSchema, slaStateSchema } from '../enums/index.js';
import { listResponseSchema } from './envelope.js';

/**
 * Service-request contract (docs/api-specification.md §6).
 *
 * Every field the API reads is validated here, so the route layer has no bespoke checks and the
 * frontend forms enforce exactly the same rules. Length limits mirror the database CHECK
 * constraints in `database/migrations/007_requests.sql` — a payload that passes Zod can never be
 * rejected by the table, and vice versa.
 *
 * Wire format is snake_case; identifiers travel as decimal strings so a 64-bit `BIGINT` key never
 * loses precision in `JSON.parse`.
 */

/** A numeric database identifier, accepted as a string or a number and normalised to a string. */
export const idSchema = z
  .union([z.string().trim(), z.number().int().positive()])
  .transform((value) => String(value));

/** Optional identifier that additionally accepts an explicit JSON `null` to clear a link. */
export const nullableIdSchema = z.optional(z.nullable(idSchema));

/**
 * `BIGINT` keys are at most 19 digits; rejecting anything longer keeps the value safe to pass back
 * into a parameterised query and stops a crafted id from reaching the database as garbage.
 */
const NUMERIC_ID = /^\d{1,19}$/;
/** Exported so the comment/timeline schemas validate identifiers with exactly the same rule. */
export const idField = (label: string) =>
  idSchema.refine((value) => NUMERIC_ID.test(value), {
    message: `${label} must be a numeric identifier`,
  });
const optionalIdField = (label: string) => z.optional(z.nullable(idField(label)));

/** Title and description limits are the exact table CHECKs (BR-2 / ST-201). */
export const REQUEST_TITLE_MIN = 5;
export const REQUEST_TITLE_MAX = 140;
export const REQUEST_DESCRIPTION_MIN = 20;
/** A transition reason is mandatory (BR-5) and must be substantive. */
export const REQUEST_REASON_MIN = 10;
/** A resolution note must explain the fix, not just say "done" (ST-303). */
export const RESOLUTION_NOTE_MIN = 20;
/** Free-text search ceiling: longer queries are truncated rather than rejected. */
export const REQUEST_SEARCH_MAX = 200;

export const requestReasonSchema = z
  .string()
  .trim()
  .min(REQUEST_REASON_MIN, `A reason of at least ${REQUEST_REASON_MIN} characters is required`);

export const requestActionSchema = z.enum(REQUEST_ACTIONS);
export type RequestActionWire = z.infer<typeof requestActionSchema>;

/** Person reference embedded in a request payload. */
export const requestPersonRefSchema = z.object({
  id: z.string(),
  full_name: z.string(),
});
export type RequestPersonRef = z.infer<typeof requestPersonRefSchema>;

/** Taxonomy reference embedded in a request payload. */
export const requestTaxonomyRefSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type RequestTaxonomyRef = z.infer<typeof requestTaxonomyRefSchema>;

/**
 * SLA view of a request. `resolution_business_minutes_remaining` is computed on the detail
 * endpoint only (business arithmetic per row); list items send `null` and rely on `state`, which
 * the database derives from the persisted tracker flags in the same query.
 */
export const requestSlaSchema = z.object({
  first_response_due_at: z.string().nullable(),
  resolution_due_at: z.string().nullable(),
  resolution_business_minutes_remaining: z.number().int().nullable(),
  state: slaStateSchema,
});
export type RequestSla = z.infer<typeof requestSlaSchema>;

// ---------------------------------------------------------------------------
// POST /requests
// ---------------------------------------------------------------------------

/**
 * Creating a request. `draft: true` stores the ticket without allocating a number or starting the
 * SLA clock; `draft: false` (the default) runs the full submit pipeline in one transaction.
 *
 * A draft is validated exactly like a submission: the `requests` table CHECKs apply to draft rows
 * too, so relaxing validation here would only move the failure into a 500.
 */
export const createRequestBodySchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(REQUEST_TITLE_MIN, `Title must be at least ${REQUEST_TITLE_MIN} characters`)
      .max(REQUEST_TITLE_MAX, `Title must be at most ${REQUEST_TITLE_MAX} characters`),
    description: z
      .string()
      .trim()
      .min(
        REQUEST_DESCRIPTION_MIN,
        `Description must be at least ${REQUEST_DESCRIPTION_MIN} characters`,
      ),
    category_id: idField('category_id'),
    sub_category_id: optionalIdField('sub_category_id'),
    department_id: optionalIdField('department_id'),
    priority: requestPrioritySchema.default('medium'),
    draft: z.boolean().default(false),
  })
  .strict();
export type CreateRequestBody = z.infer<typeof createRequestBodySchema>;

// ---------------------------------------------------------------------------
// PATCH /requests/{id}
// ---------------------------------------------------------------------------

/**
 * Editable content fields. Anything else — `status`, `assignee_id`, `request_number`, `version`,
 * `resolution_note`, `reopen_count` — is a **protected workflow field**: `.strict()` rejects it with
 * a `VALIDATION_ERROR` naming the key, so an employee cannot smuggle a status or assignee change
 * through the edit endpoint. Status and assignment have their own endpoints and gates.
 *
 * `priority` is accepted by the schema but additionally gated on manager+ in the service.
 */
export const patchRequestBodySchema = z
  .object({
    title: z.string().trim().min(REQUEST_TITLE_MIN).max(REQUEST_TITLE_MAX).optional(),
    description: z.string().trim().min(REQUEST_DESCRIPTION_MIN).optional(),
    category_id: z.optional(idField('category_id')),
    sub_category_id: optionalIdField('sub_category_id'),
    priority: requestPrioritySchema.optional(),
    reason: requestReasonSchema.optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.title !== undefined ||
      body.description !== undefined ||
      body.category_id !== undefined ||
      body.sub_category_id !== undefined ||
      body.priority !== undefined,
    { message: 'Provide at least one field to change', path: [] },
  );
export type PatchRequestBody = z.infer<typeof patchRequestBodySchema>;

// ---------------------------------------------------------------------------
// Action endpoints
// ---------------------------------------------------------------------------

/** `POST /requests/{id}/assign` — manager/admin only (ST-304). */
export const assignRequestBodySchema = z
  .object({
    assignee_id: idField('assignee_id'),
    reason: requestReasonSchema.optional(),
  })
  .strict();
export type AssignRequestBody = z.infer<typeof assignRequestBodySchema>;

/** `POST /requests/{id}/resolve` — the note is the answer the requester reads (ST-303). */
export const resolveRequestBodySchema = z
  .object({
    resolution_note: z
      .string()
      .trim()
      .min(
        RESOLUTION_NOTE_MIN,
        `Resolution note must be at least ${RESOLUTION_NOTE_MIN} characters`,
      ),
    reason: requestReasonSchema.optional(),
  })
  .strict();
export type ResolveRequestBody = z.infer<typeof resolveRequestBodySchema>;

/** `POST /requests/{id}/close` — requester confirms the resolution (ST-305). */
export const closeRequestBodySchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
    resolution_note: z.string().trim().min(RESOLUTION_NOTE_MIN).optional(),
  })
  .strict();
export type CloseRequestBody = z.infer<typeof closeRequestBodySchema>;

/** `POST /requests/{id}/reopen` — always justified (BR-5). */
export const reopenRequestBodySchema = z
  .object({
    reason: requestReasonSchema,
  })
  .strict();
export type ReopenRequestBody = z.infer<typeof reopenRequestBodySchema>;

/** `POST /requests/{id}/hold` and `/cancel` — both require a reason in the lifecycle table. */
export const reasonRequestBodySchema = z.object({ reason: requestReasonSchema }).strict();
export type ReasonRequestBody = z.infer<typeof reasonRequestBodySchema>;

/** No-body actions: submit, claim, start, resume. Unknown keys are rejected, not ignored. */
export const emptyRequestBodySchema = z.object({}).strict();

/**
 * `POST /requests/{id}/transition` — the generic chokepoint that accepts any legal action, so the
 * CLI/integration caller does not need one URL per verb. The dedicated endpoints above are thin,
 * better-documented aliases of it.
 */
export const transitionRequestBodySchema = z
  .object({
    action: requestActionSchema,
    reason: requestReasonSchema.optional(),
    resolution_note: z.string().trim().min(RESOLUTION_NOTE_MIN).optional(),
    assignee_id: z.optional(idField('assignee_id')),
  })
  .strict();
export type TransitionRequestBody = z.infer<typeof transitionRequestBodySchema>;

// ---------------------------------------------------------------------------
// GET /requests/{id} — path params
// ---------------------------------------------------------------------------

export const requestIdParamsSchema = z.object({ id: idField('id') });
export type RequestIdParams = z.infer<typeof requestIdParamsSchema>;

/** `GET /requests/{id}/events` uses the same path parameter shape. */
export const requestEventsParamsSchema = requestIdParamsSchema;

/**
 * The history feed is bounded by the contract, not by the caller's generosity: an append-only log is
 * the one surface where an unbounded `LIMIT` would turn a detail page into a full table scan.
 */
export const REQUEST_EVENTS_LIMIT_MAX = 200;
export const requestEventsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(REQUEST_EVENTS_LIMIT_MAX).default(100),
  })
  .strict();
export type RequestEventsQuery = z.infer<typeof requestEventsQuerySchema>;

// ---------------------------------------------------------------------------
// GET /requests — pagination, filtering, sorting, search
// ---------------------------------------------------------------------------

/** Query values are strings on the wire; anything else arrived through a bracketed object key. */
function isStringList(value: readonly unknown[]): value is string[] {
  return value.every((entry) => typeof entry === 'string');
}

/**
 * Query strings arrive as `string | string[]`. A filter accepts a repeated key (`?status=a&status=b`)
 * or a CSV (`?status=a,b`); either way every token is validated against its enum, so an unknown
 * value is a 400 rather than a silently ignored filter.
 */
function normalizeCsv(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  const entries = Array.isArray(value) ? value : [value];
  // `?status[a]=b` reaches the server as an object. It can never name an enum value, and stringifying
  // it would compare `[object Object]` against the enum, so the whole filter is rejected as empty.
  if (!isStringList(entries)) return [];
  return entries
    .flatMap((entry) => entry.split(','))
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function csvEnum<T extends z.ZodType>(item: T) {
  return z.optional(z.preprocess(normalizeCsv, z.array(item).min(1, 'Provide at least one value')));
}

/** `assignee_id` accepts the two queue sentinels as well as a concrete user id. */
export const assigneeFilterSchema = z.union([
  z.literal('me'),
  z.literal('unassigned'),
  idSchema.pipe(
    z.string().regex(/^\d{1,19}$/, 'assignee_id must be "me", "unassigned" or a numeric id'),
  ),
]);
export type AssigneeFilter = z.infer<typeof assigneeFilterSchema>;

/**
 * Whitelisted sort keys. The repository maps each key to a fixed SQL fragment — the client string
 * never reaches the query text, which is what keeps `ORDER BY` injection-proof.
 */
export const REQUEST_SORT_KEYS = [
  'created_at',
  'updated_at',
  'submitted_at',
  'resolved_at',
  'priority',
  'status',
  'title',
  'request_number',
  'sla_remaining',
  'id',
] as const;
export const requestSortKeySchema = z.enum(REQUEST_SORT_KEYS);

export const listRequestsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    // Clamped rather than rejected: an oversized page size is a UI accident, not an attack.
    page_size: z.coerce
      .number()
      .int()
      .min(1)
      .transform((value) => Math.min(value, 100))
      .default(20),
    status: csvEnum(requestStatusSchema),
    priority: csvEnum(requestPrioritySchema),
    category_id: z.optional(idField('category_id')),
    sub_category_id: z.optional(idField('sub_category_id')),
    department_id: z.optional(idField('department_id')),
    requester_id: z.optional(idField('requester_id')),
    assignee_id: assigneeFilterSchema.optional(),
    sla: z.optional(z.enum(['safe', 'warning', 'breached'])),
    q: z
      .string()
      .trim()
      .transform((value) => value.slice(0, REQUEST_SEARCH_MAX))
      .optional(),
    /** Leading `-` means descending; the route resolves it against `direction` (see `resolveSort`). */
    sort: z
      .string()
      .trim()
      .transform((value) => value.replace(/^[-+]/, ''))
      .pipe(requestSortKeySchema)
      .default('submitted_at'),
    direction: z.enum(['asc', 'desc']).optional(),
  })
  .strict();
export type ListRequestsQuery = z.infer<typeof listRequestsQuerySchema>;
export type RequestSortKey = z.infer<typeof requestSortKeySchema>;

/**
 * Effective ordering for a list query. A signed `sort` token is the shorthand clients actually type
 * (`-submitted_at`), so it wins when `direction` was not supplied explicitly; `submitted_at`,
 * `created_at`, `resolved_at` and `updated_at` default to newest-first, everything else to ascending.
 */
export function resolveSort(
  query: Pick<ListRequestsQuery, 'sort' | 'direction'>,
  rawSortToken?: unknown,
): { readonly key: RequestSortKey; readonly descending: boolean } {
  const explicit = query.direction !== undefined;
  const sign =
    typeof rawSortToken === 'string' && rawSortToken.startsWith('-') ? 'desc' : undefined;
  if (explicit) return { key: query.sort, descending: query.direction === 'desc' };
  if (sign) return { key: query.sort, descending: true };
  return { key: query.sort, descending: DESCENDING_BY_DEFAULT.has(query.sort) };
}

const DESCENDING_BY_DEFAULT: ReadonlySet<RequestSortKey> = new Set([
  'created_at',
  'updated_at',
  'submitted_at',
  'resolved_at',
]);

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** Queue row — everything a list or search result needs, nothing a detail view adds. */
export const requestListItemSchema = z.object({
  id: z.string(),
  request_number: z.string().nullable(),
  title: z.string(),
  status: requestStatusSchema,
  priority: requestPrioritySchema,
  category: requestTaxonomyRefSchema,
  sub_category: z.nullable(requestTaxonomyRefSchema),
  requester: requestPersonRefSchema,
  assignee: z.nullable(requestPersonRefSchema),
  department: z.nullable(requestTaxonomyRefSchema),
  submitted_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  resolved_at: z.string().nullable(),
  closed_at: z.string().nullable(),
  reopen_count: z.number().int().nonnegative(),
  sla: z.nullable(requestSlaSchema),
  version: z.number().int().nonnegative(),
  /** Actions this caller may perform right now — drives UI buttons and never leaks other users' scope. */
  allowed_actions: z.array(requestActionSchema),
});
export type RequestListItem = z.infer<typeof requestListItemSchema>;

/** `GET /requests/{id}` — the list row plus full text, workflow detail and history. */
export const requestDetailSchema = requestListItemSchema.extend({
  description: z.string(),
  status_reason: z.nullable(z.string()),
  resolution_note: z.nullable(z.string()),
  cancelled_at: z.string().nullable(),
  requester_inactive: z.boolean(),
  reopened_from: z.string().nullable(),
  /** The requester/assignee-scoped visibility flag for internal commentary (AC-5). */
  can_comment: z.boolean(),
});
export type RequestDetail = z.infer<typeof requestDetailSchema>;

export const requestListResponseSchema = listResponseSchema(requestListItemSchema);

/** One append-only lifecycle event (ST-203). */
export const requestEventSchema = z.object({
  id: z.string(),
  event_type: z.string(),
  actor: z.nullable(requestPersonRefSchema),
  actor_role: z.string(),
  from_status: z.nullable(requestStatusSchema),
  to_status: z.nullable(requestStatusSchema),
  detail: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});
export type RequestEvent = z.infer<typeof requestEventSchema>;

export const requestEventListResponseSchema = listResponseSchema(requestEventSchema);

/** Draft-or-submitted creation result and every action result share this envelope shape. */
export const requestDetailResponseSchema = z.object({ data: requestDetailSchema });
