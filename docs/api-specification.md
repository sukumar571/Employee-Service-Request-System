# ESRS — API Specification (v1)

Base URL: `/api/v1` · Format: JSON (UTF-8) · AuthN: `Authorization: Bearer <access JWT>` (except
`/auth/login|refresh|*` noted) · All list endpoints: cursor-free **page-based pagination**
(`?page=1&page_size=20`, max 100) returning `{ data, meta: { page, page_size, total } }`.

Schemas live in code as Zod (`shared/`, published as `@esrs/shared`) — this document is the contract
narrative; OpenAPI is generated from those schemas (`zod-to-openapi`) at build time and will be
published at `GET /api/v1/openapi.json` (planned — the endpoint is not implemented yet, see §13.1).
Until then `GET /api/v1/meta` is the machine-readable contract surface: enums, the lifecycle
transition table, SLA defaults and the business-hours window.

---

## 1. Conventions

### 1.1 Errors — single envelope
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [
  { "path": "title", "message": "min 5 characters" } ] } }
```
| HTTP | code examples |
|---|---|
| 400 | `VALIDATION_ERROR`, `BAD_REQUEST` (malformed JSON, unusable `If-Match`) |
| 401 | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `REFRESH_REUSE`, `INVALID_CREDENTIALS` |
| 403 | `FORBIDDEN`, `OUT_OF_TEAM_SCOPE`, `PASSWORD_CHANGE_REQUIRED` |
| 404 | `NOT_FOUND` — also returned for a row that exists but is outside the caller's scope, so ids cannot be probed |
| 409 | `INVALID_TRANSITION`, `CONFLICT` (version/claim), `LAST_ADMIN_GUARD`, `ASSIGNEE_HAS_OPEN_TICKETS`, `REOPEN_WINDOW_EXPIRED` |
| 413 / 415 | `FILE_TOO_LARGE` / `UNSUPPORTED_FILE_TYPE` |
| 422 | `INVALID_ASSIGNEE` (a well-formed id that cannot hold the work: unknown, deactivated, wrong role or wrong team) |
| 423 | `ACCOUNT_LOCKED` |
| 429 | `RATE_LIMITED` (+`Retry-After`) |
| 500 | `INTERNAL` (request_id only; never stack traces) |
| 503 | `SERVICE_UNAVAILABLE` (database outage, connection limit, statement timeout) |

`details[].path` names the offending field (`title`, `category_id`, `status.0` for the first element of
a list filter). A key the schema does not define — a rejected protected field, an unknown query
parameter — is reported with the key as `path` and `Unrecognized key: "…"` as the message, because a
`.strict()` object records the problem at the object and the server lifts the key name back out so
clients can still highlight the field. A constraint that failed on `refine()` (e.g. an empty PATCH)
reports `path: "(root)"`.

### 1.2 Idempotency & concurrency
State-changing single-resource calls accept `If-Match: "<version>"` (optimistic lock) → mismatch 409.
Every request-resource response carries `ETag: "<version>"`, so a client can read the version once and
round-trip it without parsing the body; `W/"3"`, `"3"` and `3` are all accepted, and anything else is a
400 rather than a silently ignored precondition (ignoring it would let a stale client overwrite an edit
it never read). Omitting `If-Match` means last-write-wins. Rows touched inside a write are locked
(`SELECT … FOR UPDATE`), so two concurrent claims cannot both succeed.
Jobs/system paths are idempotent by design (notification dedupe key).

### 1.3 Datetimes
UTC ISO-8601 with `Z`. Business-time fields are precomputed server-side and named
`*_business_minutes_remaining` — clients format, never compute (architecture §3).

### 1.4 Enumerations (authoritative values — mirror DB enums)
- role: `employee | agent | manager | admin`
- priority: `low | medium | high | critical`
- status: `draft | submitted | assigned | in_progress | on_hold | resolved | closed | cancelled`
- event_type / notification_type: as `database-design.md` §2.7/§2.10.

## 2. Endpoint index

| # | Method & path | Roles | Story |
|---|---|---|---|
| 3.1 | `POST /auth/login` | public | ST-101 |
| 3.2 | `POST /auth/refresh` | cookie | ST-102 |
| 3.3 | `POST /auth/logout` | any | ST-102 |
| 3.4 | `POST /auth/change-password` | any | ST-104 |
| 3.5 | `GET /auth/me` | any | ST-101 |
| 4.1 | `GET /users` · `POST /users` | admin | ST-105 |
| 4.2 | `PATCH /users/{id}` · `POST /users/{id}/deactivate` | admin | ST-105 |
| 5.1 | `GET/POST /departments`, `PATCH /departments/{id}` | admin (GET any auth) | ST-501 |
| 5.2 | `GET/POST /categories`, `PATCH /categories/{id}` · sub-categories nested | admin / GET any | ST-501 |
| 6.1 | `GET /requests` | scoped | ST-203/301 |
| 6.2 | `POST /requests` (draft or direct submit) | any authenticated role | ST-201/202 |
| 6.3 | `GET /requests/{id}` | scoped | ST-203 |
| 6.4 | `PATCH /requests/{id}` (draft content: owner · priority: manager+) | see left | ST-202/404 |
| 6.5 | `POST /requests/{id}/submit` | owner | ST-201 |
| 6.6 | `POST /requests/{id}/transition` | per action named in the body | ST-204/303/304/206 |
| 6.7 | `POST /requests/{id}/claim` | agent team | ST-302 |
| 6.8 | `POST /requests/{id}/assign` | manager/admin | ST-304 |
| 6.9 | `GET /requests/{id}/events` | scoped | FR-13 |
| 6.10 | `POST /requests/{id}/{start,resume}` | assignee (manager+ may act) | ST-303/306 |
| 6.11 | `POST /requests/{id}/hold` | assignee (manager+ may act) | ST-306 |
| 6.12 | `POST /requests/{id}/resolve` | assignee (manager+ may act) | ST-303 |
| 6.13 | `POST /requests/{id}/close` | requester | ST-305 |
| 6.14 | `POST /requests/{id}/reopen` | requester, 7-day window | ST-307/FR-12 |
| 6.15 | `POST /requests/{id}/cancel` | requester | ST-204/edge §16.3 |
| 7.1 | `GET /requests/{id}/comments` | scoped (visibility-filtered) | ST-205 |
| 7.2 | `POST /requests/{id}/comments` | scoped; `internal` needs agent+ | ST-205 |
| 7.3 | `GET /requests/{id}/timeline` | scoped (needs events **and** comment read) | FR-13/ST-205 |
| 8.1 | `POST /files` · `GET /files/{id}/download` · `DELETE /requests/{id}/attachments/{aid}` | scoped | ST-201 |
| 9.1 | `GET /sla/trackers/{requestId}` · `GET/PUT /sla/policies` | scoped / manager+ | ST-401/403 |
| 10.1 | `GET /notifications` · `POST /notifications/{id}/read` · `POST /notifications/read-all` | self | ST-601 |
| 11.1 | `GET /analytics/summary` · `/trends` · `/breaches` · `/workload` · `GET /analytics/export` | manager/admin | ST-602/603 |
| 12.1 | `GET /audit-logs` | admin | ST-502 — **not exposed**; the write path exists, the read route does not (§12) |
| 13.1 | `GET /health/live` · `/health/ready` | public | ST-702 |
| 13.2 | `GET /meta` · `GET /` (endpoint index) | public | ST-702 |
| 13.3 | `GET /openapi.json` | public | ST-702 |

**Served today:** `GET /` (endpoint index), `GET /health/live`, `GET /health/ready`, `GET /meta`,
all of §3 auth (`/auth/login|refresh|logout|change-password|me`), §4's `GET|POST /users` and
`PATCH /users/{id}` (deactivating is a `PATCH {"is_active": false}`; the dedicated
`POST /users/{id}/deactivate` is not built yet), every request endpoint indexed above as 6.1–6.15
(written up in §6) including the comment thread, the comment post and the activity timeline of §7,
`GET /sla/policies`, `PUT /sla/policies/{priority}`. Nothing in §8–§12 is served: attachments,
notifications, analytics and the `GET /audit-logs` read are still design, and an unknown route under
`/api/v1` returns the standard `404 NOT_FOUND` envelope — which is how §12 is demonstrated rather
than asserted. The business routers sit behind the JWT gate plus the forced-password-change gate,
which is a deliberate **fail-closed** ordering: an anonymous call returns the standard
`401 UNAUTHENTICATED` envelope and a path outside every mounted prefix stays a `404` (verified in
`backend/src/app.test.ts` and `backend/src/request.http.test.ts`). `GET /openapi.json` will be generated from the Zod contract and
complements (not replaces) `GET /meta`, which the SPA reads at runtime.

## 3. Auth

### POST /auth/login
```jsonc
// req
{ "email": "rita@corp.in", "password": "…" }
// 200 res                                 // sets Cookie: esrs_rt=<rotated>; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age=7d
{ "access_token": "eyJ…", "expires_in": 900,
  "user": { "id": "881", "full_name": "Rita", "role": "agent", "team": "IT", "must_change_password": false } }
// 401 INVALID_CREDENTIALS (generic) · 423 ACCOUNT_LOCKED · 403 inactive message
```
Rate limit: 10 req/min/IP + lockout per email (ST-103). Dummy bcrypt verify on unknown email
(equalizes timing; security-plan §4.2).

### POST /auth/refresh
Reads cookie; validates family chain; **rotates** (old token marked replaced). Reuse of a replaced
token ⇒ revoke whole family → `401 REFRESH_REUSE` (edge §16.12). 10 s grace for in-flight races.

### POST /auth/logout — revokes active family; clears cookie. Idempotent.
### POST /auth/change-password — `{ current_password?, new_password }`; strength per Zod rules; sets `must_change_password=false`; all other refresh families revoked.
### GET /auth/me — current user snapshot (FE bootstrap; also endpoint for `PASSWORD_CHANGE_REQUIRED` gate test).

## 4. Users (admin)

`GET /users?role=&team=&is_active=` → `{ id, email, full_name, role, department_id, team_category_id, is_active, last_login_at }` (no search term, no pagination — the roster is small and the filter set is closed)
`POST /users` → `{ email, full_name, role, department_id, team_category_id?, initial_password }` — 201;
`must_change_password=true`. `PATCH /users/{id}` (role/team/dept/name; role change audit-logged).
`POST /users/{id}/deactivate` *(planned)* → 409 `ASSIGNEE_HAS_OPEN_TICKETS` when applicable (BR-4); 409 `LAST_ADMIN_GUARD`. Today an administrator deactivates with `PATCH /users/{id} {"is_active": false}`, which enforces `LAST_ADMIN_GUARD` (and audits the change) but does not yet check for open tickets.

## 5. Taxonomy

`GET /categories` (public to any authenticated; returns active + `deactivatable` flag for admin UI).
`POST /categories {code,name,team_label}`; `PATCH /categories/{id} {name?,is_active?}` — setting
`is_active=false` blocked if open requests exist? **No** — deactivation allowed; open requests keep
working (edge §16.14); new-request form excludes it (query filter). Sub-categories:
`GET/POST /categories/{id}/sub-categories`, `PATCH /sub-categories/{id}`. Departments analogous.

## 6. Requests — the implemented surface

Every endpoint in this section is live. `backend/src/request.http.test.ts` (149 integration tests) covers
the rules, and `evidence/api-responses/req-*.json` holds responses captured from a real server running
against PostgreSQL — the payloads quoted below are those captures, not illustrations. `req-index.json`
lists all 76 calls of the walk with their status codes. Re-produce them with `npm run e2e:requests`
(`scripts/e2e-requests.mjs`), which asserts an expected status for every call and exits non-zero otherwise.

The driver removes the tickets it made and realigns the identity counters before it starts, so a re-run
lands on the same surrogate ids and writes the same history: the `id`s below are stable, not incidental.
The two things that legitimately differ per call are the timestamps and `request_id`, the correlation id
the error envelope mints fresh for every response.

Layering: `request.routes.ts` (gate → parse → wrap) → `request.service.ts` (scope, business rules,
transactions, audit) → the `RequestRepository` port with `PostgresRequestRepository` and
`InMemoryRequestRepository` adapters. Both adapters implement identical scoping, filter, ordering,
version and multi-record-write semantics, so a rule proven on one holds on the other. Schemas live in
`shared/src/dto/requests.ts`; `shared/src/domain/requestTransitions.ts` is the single source of truth
for the lifecycle, serving both `allowed_actions` in responses and rejection of illegal moves.

Two rules account for most of the status codes below:

- **Out of scope is a 404, never a 403.** An employee reading someone else's ticket, an agent reading
  another team's queue, or a manager reading another author's *draft* all get `NOT_FOUND`. Whether a
  ticket exists at all is itself information (`docs/security-plan.md` §4).
- **Protected workflow fields cannot be smuggled.** `status`, `assignee_id`, `request_number`,
  `version`, `resolution_note`, `reopen_count` and the timestamp columns are deliberately absent from
  the create and patch schemas, so a `.strict()` parse rejects them with a 400 naming the key. Status
  and assignment have their own endpoints, each with its own permission.

### 6.1 `POST /requests` — save a draft or submit

| Field | Rule |
|---|---|
| `title` | required, trimmed, 5–140 characters |
| `description` | required, trimmed, ≥ 20 characters |
| `category_id` | required, numeric id of an **active** category |
| `sub_category_id` | optional; must belong to `category_id` and be active |
| `department_id` | optional; defaults to the requester's own department, must be active |
| `priority` | `low \| medium \| high \| critical`, defaults to `medium` |
| `draft` | `true` stores a draft; `false` (default) runs the full submit pipeline |

A draft is validated exactly like a submission, because the `requests` table CHECKs apply to draft rows
too — relaxing validation here would only move the failure into a 500. A draft gets no number and no
SLA clock; `REQ-YYYY-NNNNNN` is allocated by a gapless per-year counter **inside** the submit
transaction, so a rolled-back submit returns its number to the pool instead of burning it.

```jsonc
// POST /api/v1/requests          Authorization: Bearer <employee access token>
{ "title": "Laptop will not boot after Tuesday patch",
  "description": "My laptop loops at the vendor logo after the patch. I need it working before the client demo on Friday.",
  "category_id": "1", "sub_category_id": "1", "priority": "high" }
```

```jsonc
// 201 Created     ETag: "0"
{ "data": {
    "id": "4", "request_number": "REQ-2026-000001",
    "title": "Laptop will not boot after Tuesday patch",
    "status": "submitted", "priority": "high",
    "category": { "id": "1", "name": "Information Technology" },
    "sub_category": { "id": "1", "name": "Hardware" },
    "requester": { "id": "1", "full_name": "Demo Employee" },
    "assignee": null,
    "department": { "id": "1", "name": "Information Technology" },
    "submitted_at": "2026-10-27T18:37:35.587Z", "created_at": "2026-10-27T18:37:35.659Z",
    "updated_at": "2026-10-27T18:37:35.659Z", "resolved_at": null, "closed_at": null,
    "reopen_count": 0,
    "sla": { "first_response_due_at": "2026-10-28T05:30:00.000Z",
             "resolution_due_at": "2026-10-30T09:30:00.000Z",
             "resolution_business_minutes_remaining": 1440, "state": "safe" },
    "version": 0, "allowed_actions": ["cancel"],
    "description": "My laptop loops at the vendor logo after the patch. I need it working before the client demo on Friday.",
    "status_reason": null, "resolution_note": null, "cancelled_at": null,
    "requester_inactive": false, "reopened_from": null, "can_comment": true } }
```

`allowed_actions` is computed for the **calling user** in the **current row state**, so the same ticket
answers `["cancel"]` to its requester, `["claim"]` to a teammate who neither raised nor holds it and
`["start", "hold", "resolve"]` to the agent holding it — a manager on the same ticket additionally sees
`assign`, because `assign` is a role rule, not a status rule. The field is a convenience for the UI and
the server re-checks every one of those actions; it is never an authorization.

Validation failures use the standard envelope and always name the field:

```jsonc
// 400 — a title below the minimum
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid request payload", "details": [
    { "path": "title", "message": "Title must be at least 5 characters" } ],
  "request_id": "0e3baec9-b961-4bb1-a63b-729db3c45163" } }

// 400 — an employee trying to set a protected field at creation
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid request payload", "details": [
    { "path": "status", "message": "Unrecognized key: \"status\"" } ],
  "request_id": "c103ae6a-dfd6-448e-ba29-913980f41c8a" } }
```

An unknown or deactivated `category_id`/`sub_category_id`/`department_id` is also a 400 on that field:
the id is validated against the taxonomy in the database before the row is written, so no foreign-key
error can reach the client.

### 6.2 `GET /requests` — pagination, filtering, sorting and search

| Parameter | Accepts | Notes |
|---|---|---|
| `page` | integer ≥ 1 | default 1 |
| `page_size` | integer 1–100 | default 20; **clamped** to 100 rather than rejected |
| `status` | enum, CSV (`?status=draft,submitted`) or repeated key | an unknown value is a 400 at `status.0`, never an ignored filter |
| `priority` | enum, CSV or repeated key | as above |
| `category_id` `sub_category_id` `department_id` `requester_id` | numeric id | |
| `assignee_id` | `me` \| `unassigned` \| numeric id | `me` resolves to the caller, so a queue URL is shareable |
| `sla` | `safe` \| `warning` \| `breached` | derived from the persisted tracker flags in the same query |
| `q` | free text, truncated at 200 characters | matches title, request number and description; treated as a **literal**, so `%` and `_` are not wildcards |
| `sort` | `created_at` `updated_at` `submitted_at` `resolved_at` `priority` `status` `title` `request_number` `sla_remaining` `id` | leading `-` is descending (`?sort=-priority`); any other key is a 400 |
| `direction` | `asc` \| `desc` | overrides the `-` shorthand; date keys default to newest-first |

Row scope: `employee` → their own tickets plus their own drafts; `agent` → the same plus their team's
queue (`team_category_id = request.category_id`); `manager`/`admin` → every ticket. The scope is applied
in SQL, so `meta.total` counts the rows the caller may see and pagination can never leak a hidden row.

```jsonc
// GET /api/v1/requests?page=1&page_size=5&sort=-submitted_at      (as the requester)
{ "data": [
    { "id": "5", "request_number": "REQ-2026-000002",
      "title": "Needs a second monitor for the finance reconciliation",
      "status": "submitted", "priority": "medium",
      "category": { "id": "1", "name": "Information Technology" },
      "sub_category": { "id": "5", "name": "Peripherals" },
      "requester": { "id": "1", "full_name": "Demo Employee" }, "assignee": null,
      "department": { "id": "1", "name": "Information Technology" },
      "submitted_at": "2026-10-27T18:37:36.079Z", "created_at": "2026-10-27T18:37:35.892Z",
      "updated_at": "2026-10-27T18:37:36.084Z", "resolved_at": null, "closed_at": null,
      "reopen_count": 0,
      "sla": { "first_response_due_at": "2026-10-28T07:30:00.000Z",
               "resolution_due_at": "2026-10-30T12:30:00.000Z",
               "resolution_business_minutes_remaining": null, "state": "safe" },
      "version": 2, "allowed_actions": ["cancel"] } /* …4 more rows… */
  ],
  "meta": { "page": 1, "page_size": 5, "total": 5 } }
```

The queue projection carries no `description`: a list is not a way to read full text, and the detail
endpoint is where `resolution_business_minutes_remaining` is computed (business arithmetic per row).

### 6.3 `GET /requests/{id}` — the detail view

Same object as a list row plus `description`, `status_reason`, `resolution_note`, `cancelled_at`,
`requester_inactive`, `reopened_from` and `can_comment`. The response sets `ETag`, which is the value to
send back as `If-Match`. `{id}` must be a numeric identifier of at most 19 digits: `GET /requests/abc`
is a 400 (malformed input), `GET /requests/999999` is a 404, and a row the caller may not see is
indistinguishable from a missing one.

### 6.4 `GET /requests/{id}/events` — the append-only trail

`?limit=1..200`, default 100 — an unbounded `LIMIT` on an append-only log would turn a detail page into
a table scan. Anyone who can see the row can read its history, with one exception that belongs to §7: the
`comment_added` **marker** of an internal note is hidden from a caller below `agent`, because a marker
carries that note's visibility and length. Lifecycle rows are never filtered by role — what happened to
the ticket is not comment content.

```jsonc
// GET /api/v1/requests/4/events?limit=50        (as the requester)   req-events.json
{ "data": [
    { "id": "7", "event_type": "created", "actor": { "id": "1", "full_name": "Demo Employee" },
      "actor_role": "employee", "from_status": null, "to_status": null,
      "detail": { "draft": false, "priority": "high" }, "created_at": "2026-10-27T18:37:35.587Z" },
    { "id": "11", "event_type": "assigned",
      "actor": { "id": "3", "full_name": "Demo Manager" }, "actor_role": "manager",
      "from_status": "submitted", "to_status": "assigned",
      "detail": { "reason": "Hardware queue owner this week", "assignee_id": "2" },
      "created_at": "2026-10-27T18:37:36.580Z" },
    { "id": "12", "event_type": "comment_added",
      "actor": { "id": "1", "full_name": "Demo Employee" }, "actor_role": "employee",
      "detail": { "comment_id": "1", "visibility": "public", "characters": 61,
                  "is_post_closure": false },
      "created_at": "2026-10-27T18:37:36.917Z" }
    /* …priority_changed, started, placed_on_hold, resumed, resolved, closed, reopened, resolved,
       closed, and the post-closure marker… */
  ],
  "meta": { "page": 1, "page_size": 50, "total": 14 } }
```

The identical call as a manager returns 15 rows (`req-events-staff.json`); the extra one is id 13, the
internal note's marker. Look at what entry 12 does **not** contain: the comment's text. The trail says a
61-character comment was left, which is the split §7 depends on.

`from_status`/`to_status` are populated only by rows that changed status; a priority change puts its
pair in `detail` instead, because the status did not move. Actor names are resolved through the user
table (`LEFT JOIN users`), so the trail reads "Demo Agent", not an id.

### 6.5 `PATCH /requests/{id}` — draft content and priority

Draft content is the owner's: `title`, `description`, `category_id`, `sub_category_id`. Editing a row
that is no longer a draft is a **409 `CONFLICT`**, not a silent no-op. `priority` is accepted by the
schema and gated by the service on `manager`+ — an employee or agent changing it gets a 403, and a
manager must supply a `reason` of at least 10 characters (400 without one). An empty patch is a 400
(`path: "(root)"`, "Provide at least one field to change") rather than a version bump for nothing.

A draft is invisible to everyone but its owner, so `PATCH /requests/{draft id}` by a manager is a 404
even though managers hold `request.read.all` — the scoping rule runs before the field check, and the
response is the same one a nonexistent id gets (`Request '5' not found`).

Reprioritising does **not** re-stamp the SLA clock: the tracker keeps the due dates frozen at submission
(`docs/requirements.md` ST-404), and a ticket in `closed` or `cancelled` can no longer be reprioritised
(409).

### 6.6 Lifecycle actions — one endpoint per verb

| Endpoint | Body | Permission | Legal from | Notes |
|---|---|---|---|---|
| `POST /requests/{id}/submit` | `{}` | `request.create` (owner) | `draft` | allocates the number, creates the tracker |
| `POST /requests/{id}/claim` | `{}` | `request.claim` (agent+) | `submitted` | atomic self-assign; the loser of a race gets 409 |
| `POST /requests/{id}/assign` | `{ assignee_id, reason? }` | `request.assign` (manager+) | `submitted`, `assigned`, `in_progress`, `on_hold` | see 422 below |
| `POST /requests/{id}/start` | `{}` | `request.transition` (assignee, manager+ may act) | `assigned` | |
| `POST /requests/{id}/hold` | `{ reason }` ≥10 | `request.transition` | `assigned`, `in_progress` | |
| `POST /requests/{id}/resume` | `{}` | `request.transition` | `on_hold` | |
| `POST /requests/{id}/resolve` | `{ resolution_note }` ≥20, optional `reason` | `request.resolve` | `assigned`, `in_progress` | stamps `resolved_at` and the tracker's completion status |
| `POST /requests/{id}/close` | `{ reason?, resolution_note? }` | `request.close` (requester) | `resolved` | stamps `closed_at`; the record becomes immutable |
| `POST /requests/{id}/reopen` | `{ reason }` ≥10 | `request.reopen` (requester) | `resolved`, `closed` | returns the ticket to its previous assignee and resumes the original due date; **7-day window** (`REOPEN_WINDOW_EXPIRED`, 409) |
| `POST /requests/{id}/cancel` | `{ reason }` ≥10 | `request.cancel` (requester) | `draft`, `submitted`, `assigned` | |

Every action endpoint answers 200 with the full resource and a fresh `ETag`, so a client can chain
`If-Match` straight from the previous response. An action that the row's status does not permit is a
409 `INVALID_TRANSITION`; one the caller's role may never perform is a 403; a ticket the caller cannot
see is a 404.

```jsonc
// 403 — an employee trying to route their own ticket
{ "error": { "code": "FORBIDDEN",
             "message": "Role 'employee' may not perform 'request.assign'",
  "request_id": "43e01c71-1354-4d07-a198-bf4b682e6fd6" } }

// 422 — a well-formed id that cannot hold the work (three distinct causes, one code)
{ "error": { "code": "INVALID_ASSIGNEE", "message": "User '999999' is not an assignable account" } }
{ "error": { "code": "INVALID_ASSIGNEE", "message": "User '1' has role 'employee' and cannot hold tickets" } }
{ "error": { "code": "INVALID_ASSIGNEE", "message": "User '5' belongs to a different team than the request category 'Information Technology'" } }
```

`INVALID_ASSIGNEE` is 422 rather than 400 because the payload is syntactically valid — the server
understands the id and refuses it on semantics, exactly as a deactivated account is refused.

```jsonc
// 409 — `If-Match: "0"` after the assign moved the row to version 1
{ "error": { "code": "CONFLICT", "message": "Expected version 0 but the request is at version 1",
    "details": [ { "path": "version", "message": "current version is 1" } ],
  "request_id": "0040bd00-48be-4809-a71d-41060b1ba97e" } }

// 400 — a precondition header the server refuses to guess at
{ "error": { "code": "BAD_REQUEST",
             "message": "If-Match must be a version number, e.g. If-Match: \"3\"" } }
```

### 6.7 `POST /requests/{id}/transition` — the generic chokepoint

`{ action, reason?, resolution_note?, assignee_id? }` where `action` is one of `submit`, `cancel`,
`claim`, `assign`, `start`, `hold`, `resume`, `resolve`, `close_confirm`, `reopen`. Integration clients
that would otherwise need one URL per verb can use this; the dedicated endpoints above are thin
aliases with the same service behind them, so the two cannot drift apart.

The route can only require that the caller may read requests at all — the action lives in the body,
where route middleware cannot see it — so `RequestService.act()` re-checks the permission for the action
the body actually names. `POST /requests/{id}/transition` with `{"action":"assign"}` as an employee is
therefore the same 403 as `/assign`, never a way around the manager gate.

### 6.8 How the guarantees are met

- **SQL injection.** Every value is a bound parameter (`$1…$n`), including identifiers, filter tokens
  and search text. `ORDER BY` is the one place a string cannot be bound, so the sort key is validated
  against a ten-value whitelist and mapped to a fixed SQL fragment; the client's text never reaches the
  query. `LIKE` patterns escape `\`, `%` and `_` so a search string is literal.
- **Transactions.** A submit touches `requests`, `request_numbers`, `sla_trackers`, `assignments` and
  `request_events`; a transition touches the same set minus the number. All of it runs in one
  `BEGIN … COMMIT` with the target row locked (`SELECT … FOR UPDATE`), so a failure at any statement —
  proven in the suite by a fake adapter that fails the `INSERT INTO assignments` — rolls the whole
  write back and leaves no orphan number, tracker or assignment row.
- **Concurrent updates.** `version` is bumped by every write and checked under the lock; `If-Match` is
  the client-facing half. Two claims of the same ticket serialise: one wins, one gets 409. A
  serialisation failure (`SQLSTATE 40001`) is translated to 409 with a retryable message.
- **Database failures.** Every read and write funnels SQLSTATEs through one map: outages and timeouts
  (`08001/08003/08006/57P01/57P02/57P03/53200/53300/57014`) become `503 SERVICE_UNAVAILABLE`, constraint
  violations become 400/409, and anything unexpected becomes a `500 INTERNAL` carrying only a
  `request_id` — the driver's message never reaches the client.
- **Deactivated accounts.** The JWT gate verifies a token without a user lookup, so every write re-reads
  the actor and returns 403 `This account is no longer active` for an account that was turned off after
  its token was issued.


## 7. Comments and the activity timeline

One aggregate, three surfaces, and only two of them are readable over HTTP:

| Surface | Backed by | Audience | Carries the comment text? |
|---|---|---|---|
| `GET /requests/{id}/comments` | `comments` | the people allowed on the ticket | yes, visibility-filtered |
| `GET /requests/{id}/timeline` | `request_events` ⧺ `comments` | the same people | yes, on `kind: "comment"` entries |
| *(no route exists)* | `audit_logs` | administrators, out of band | **no** — the row stores `characters`, never the prose |

The separation is enforced in storage, not just in the routers: the comment row holds the body, the
`comment_added` activity marker holds a summary of it (`visibility`, `characters`, `is_post_closure`),
and the audit row holds a pointer (`entity_id`, `service_request_id`) plus that same summary. A request
that was commented on therefore produces one piece of user content and two pieces of evidence about it.

Both endpoints are addressed through the parent request and inherit its scope exactly: the service
re-reads the ticket with `RequestService.requireVisible()` before it touches the thread, so a comment
feed on a request the caller may not open is a `404` (`req-thread-other-request.json`), never a `403`.
That is the §6 rule applied unchanged — including for another user's *draft*, which a manager cannot
see and therefore cannot read or annotate. The order of checks is worth stating plainly: role checks
(`comment.create`, then `comment.internal`) run before the scope read, so an employee asking to write an
internal note on a hidden ticket is answered with a 403 that names only their role — it cannot confirm
or deny that the id exists.

| Role on a visible request | Read `public` | Read `internal` | Write `public` | Write `internal` |
|---|---|---|---|---|
| anonymous | 401 | 401 | 401 | 401 |
| employee (requester or scoped-in) | yes | **no — filtered in SQL** | yes | **403** |
| agent / manager / admin | yes | yes | yes | yes |

### 7.1 `GET /requests/{id}/comments` — the thread

`?page=&page_size=` behave exactly as §6.2 (default 20, max 100). The thread is returned **oldest
first**, because a conversation is read that way, and `visibility='internal'` rows are removed by the
query for any caller below `agent` (`canSeeInternalNotes()`) rather than dropped on the way out — so
`meta.total`, the page size and the payload all describe the same already-authorised set. The same
request, captured one after another by two identities:

```jsonc
// GET /api/v1/requests/4/comments          (as the requester)   req-thread-employee.json
{ "data": [
    { "id": "1", "request_id": "4", "author": { "id": "1", "full_name": "Demo Employee" },
      "body": "The boot loop came back this morning after the second reboot.",
      "visibility": "public", "is_post_closure": false,
      "created_at": "2026-10-27T18:37:36.917Z", "updated_at": "2026-10-27T18:37:36.917Z" },
    { "id": "3", "request_id": "4", "author": { "id": "1", "full_name": "Demo Employee" },
      "body": "Confirmed stable over two days of normal use. Thank you.",
      "visibility": "public", "is_post_closure": true,
      "created_at": "2026-10-27T18:37:37.598Z", "updated_at": "2026-10-27T18:37:37.598Z" }
  ],
  "meta": { "page": 1, "page_size": 20, "total": 2 } }

// GET /api/v1/requests/4/comments          (as the assigned agent)  req-thread-agent.json
  /* …the two rows above plus id 2, the agent's internal note… */
  // meta: { "page": 1, "page_size": 20, "total": 3 }
```

`total` is 2 for the requester and 3 for the agent on the identical request at the identical instant.
Paging stays honest too: `?page=2&page_size=2` returns the post-closure comment alone, `total` still 3
(`req-thread-paged.json`) — the third page of a filtered set, not the third page of the table.

### 7.2 `POST /requests/{id}/comments`

| Field | Rule |
|---|---|
| `body` | required; trimmed **before** the length check, 1–5000 characters — the exact `comments_body_check` on the table, so nothing Zod accepts can be rejected by the database |
| `visibility` | `public` (default) \| `internal`; `internal` additionally needs the `comment.internal` action (agent+) |

The object is `.strict()`, which is what keeps authorship honest: `author_id`, `created_at`,
`is_post_closure` and every other stored column are absent from the accepted payload, so they cannot be
smuggled. The acting identity and the server clock stamp them instead.

```jsonc
// POST /api/v1/requests/4/comments        Authorization: Bearer <employee>   req-comment-public.json
{ "body": "The boot loop came back this morning after the second reboot." }

// 201 Created
{ "data": {
    "id": "1", "request_id": "4",
    "author": { "id": "1", "full_name": "Demo Employee" },
    "body": "The boot loop came back this morning after the second reboot.",
    "visibility": "public", "is_post_closure": false,
    "created_at": "2026-10-27T18:37:36.917Z", "updated_at": "2026-10-27T18:37:36.917Z" } }
```

Every rejection below is a live capture from the walk:

| Call | Status | Envelope |
|---|---|---|
| no token | 401 | `UNAUTHENTICATED` — "Authentication is required for this operation" |
| `{"body":"   \\n  "}` | 400 | `VALIDATION_ERROR`, `path: "body"`, "A comment needs at least 1 non-space character" |
| 5001 characters | 400 | `VALIDATION_ERROR`, `path: "body"`, "A comment must be at most 5000 characters" |
| extra `author_id`, `created_at` | 400 | `VALIDATION_ERROR`, `path: "author_id.created_at"`, `Unrecognized keys: "author_id", "created_at"` |
| `visibility:"internal"` as an employee | 403 | `FORBIDDEN` — "Role 'employee' may not write an internal note" |
| any verb on request `999999` | 404 | `NOT_FOUND` — "Request '999999' not found" |

**BR-8.** A comment on a ticket whose workflow had already ended is flagged, and the flag is *derived*
from the row's status (`resolved`, `closed`, `cancelled` or any terminal status) — never read from the
payload. `req-comment-post-closure.json` is the requester writing back two days later on the closed
ticket: `"is_post_closure": true`.

A comment does not change the ticket, and that is deliberate: the write locks the parent row
(`SELECT … FOR UPDATE`, so it cannot race a transition and it reads the request number and version for
the audit entry) but never updates it, so **commenting does not bump `version`** and cannot invalidate
an in-flight `If-Match` edit. A closed ticket therefore stays closed and immutable while conversation
continues around it — which is exactly why BR-8 flags the comment instead of reopening anything.

**One transaction.** The comment row, its `comment_added` marker in `request_events` and its
`comment.added` audit row are a single repository write, hence one `BEGIN … COMMIT`. The suite proves
all three directions of that: `undoes a comment and its activity marker when the comment audit row
fails`, `never writes the audit row when the comment itself fails first`, and
`commits once, and only once, when every statement in the transaction succeeds`.

### 7.3 `GET /requests/{id}/timeline` — the activity feed

Lifecycle events and comments merged into one chronological list. The read needs **both**
`request.events.read` and `comment.read`, because the feed is the union of what those two permissions
cover; internal notes are then filtered out of the union for anyone below agent.

`?limit=` is bounded like `GET /requests/{id}/events`: default 100, maximum 200, and anything larger is
a 400 (`{"path":"limit","message":"Too big: expected number to be <=200"}`) rather than a clamp — an
unbounded `LIMIT` across two append-only tables would let a year-old ticket turn its detail page into a
sequential scan.

Each entry is a request event plus one discriminator:

```jsonc
// GET /api/v1/requests/4/timeline?limit=50        (as the requester)  req-timeline-employee.json
{ "data": [
    { "id": "7",  "kind": "event",   "event_type": "created", "actor_role": "employee",
      "from_status": null, "to_status": null, "detail": { "draft": false, "priority": "high" },
      "created_at": "2026-10-27T18:37:35.587Z" },
    { "id": "11", "kind": "event",   "event_type": "assigned", "actor_role": "manager",
      "from_status": "submitted", "to_status": "assigned",
      "detail": { "reason": "Hardware queue owner this week", "assignee_id": "2" },
      "created_at": "2026-10-27T18:37:36.580Z" },
    { "id": "1",  "kind": "comment", "event_type": "comment_added", "actor_role": "employee",
      "detail": { "comment_id": "1", "visibility": "public", "is_post_closure": false,
                  "body": "The boot loop came back this morning after the second reboot." },
      "created_at": "2026-10-27T18:37:36.917Z" }
    /* …priority_changed, started, placed_on_hold, resumed, resolved, closed, reopened,
       resolved, closed, and the post-closure comment… */
  ],
  "meta": { "page": 1, "page_size": 50, "total": 14 } }
```

(The capture is trimmed here for width; `actor` and the remaining fields are as stored.)

Four properties of the feed are deliberate:

- **A comment appears once.** The `comments` row supplies the entry; the `comment_added` marker that the
  same write drops in `request_events` is excluded from the event side of the union, so the feed never
  shows a conversation twice (test: `lists a comment once, not as both a marker and a row`).
- **Order is stable, not approximate.** `created_at` ascending, then events before comments inside the
  same millisecond, then id — so a transition and a marker committed together cannot swap between
  reads.
- **The requester sees 14 entries and a manager sees 15** on the same ticket (`req-timeline-manager.json`),
  the difference being the agent's internal note. Nothing else differs, which is the point: the filter is
  about who may read the text, not about which history exists. The plain event feed applies the same rule
  to the note's marker, so there is no read path on which a staff-only comment announces itself (§6.4).
- **Audit rows are never in it.** The feed is built from `request_events` and `comments`; the
  administrative record is a third table with no read route (test:
  `keeps audit rows out of the timeline, which is the user-visible feed`).

### 7.4 How comment content reaches the browser

The API returns the stored text verbatim — escaping is a presentation concern, and storing an escaped
copy would corrupt it for every other consumer. The portal therefore renders comment bodies and timeline
`detail.body` **only** as React children, never through the raw-HTML prop (searching `frontend/src` for
`dangerouslySetInnerHTML` returns nothing, and that is enforced rather than hoped for: ESLint's
`no-restricted-syntax` matches `JSXAttribute[name.name="dangerouslySetInnerHTML"]` across every frontend
file, so adding one fails `npm run lint` and therefore `npm run verify`). React escapes text children on
the way into the DOM, so markup arrives as characters.

That claim is tested by absence rather than by string comparison: `renders a hostile comment body as
text and creates no element from it` posts `<img src=x onerror="alert(1)"><script>alert(2)</script>`
through the real component and then asserts `container.querySelector('img')` and
`querySelector('script')` are both `null` — the proof is that no element was created, not that some
escaped sequence appeared. The client validates against the same shared Zod schema, so
`refuses a body longer than the contract maximum before sending it` asserts that no `POST` leaves the
browser at all when the content is inadmissible.

The page itself is `/requests/:id/activity`, and `evidence/screenshots/11-activity-request-4-unauthenticated.png`
shows it on the running portal. What it shows is the fail-closed pair of notices — the SPA still has no
login screen, so both reads come back `UNAUTHENTICATED · HTTP 401` with the server's own wording and
correlation id. That is evidence of the surface and of the gate; the thread, the post form and the merged
timeline are proven with data by the component tests in `frontend/src/components/Activity.test.tsx`, not
by a screenshot.

## 8. Attachments
`POST /files` multipart (`file`) → 201 `{ id, file_name, size_bytes, mime_type }` (status pending;
20 MB hard cap at proxy; per-file 10 MB + type/magic checks). Planned binding: request create/patch
will gain `attachment_ids` — the schemas are `.strict()`, so today such a key is rejected as an
unrecognized field rather than quietly ignored. `GET /files/{id}/download` — auth = can-view-request; header
`Content-Disposition: attachment; filename="…"` + `nosniff`. `DELETE /requests/{id}/attachments/{aid}`
— owner (while draft) or agent+ with reason (audit).

## 9. SLA
`GET /sla/trackers/{requestId}` — full tracker (manager+ / assigned agent; requester sees only
`state` + due date via request DTO). `GET /sla/policies` (auth) · `PUT /sla/policies/{priority}`
(manager+; audit; new requests only — edge §16.6).

## 10. Notifications
`GET /notifications?unread=true&page=` → `{ id, type, request_id, payload, read_at, created_at }`
`POST /notifications/{id}/read` · `POST /notifications/read-all`. Unread count piggybacks on `/auth/me` meta for the bell (60 s poll).

## 11. Analytics (manager/admin)
| Endpoint | Query | Returns |
|---|---|---|
| `GET /analytics/summary` | `from,to` | `{ open, submitted_in_range, resolved_in_range, breached, sla_compliance_pct, mttr_business_hours, first_response_adherence_pct }` |
| `GET /analytics/trends` | `from,to&group_by=day\|week&category_id?` | series `{ bucket, submitted, resolved, breached }` |
| `GET /analytics/breaches` | pagination | list of breached trackers w/ request ref |
| `GET /analytics/workload` | | per open agent: `{ agent, open, breached }` |
| `GET /analytics/export?type=…` | same filters | CSV (BOM, ≤ 10 000 rows, ST-603) |

Definitions locked to `requirements.md` §8 (SLA compliance = resolutions before due ÷ total
resolutions in range; MTTR in business hours). SQL reference versions live in `test-plan.md` §5.

## 12. Audit trail — written always, read never

**There is no read endpoint.** `GET /audit-logs` belongs to the ST-502 plan and is **not** implemented.
The live walk calls it with an administrator's token and keeps the answer
(`req-audit-logs-not-exposed.json`):

```jsonc
// GET /api/v1/audit-logs        Authorization: Bearer <admin>
{ "error": { "code": "NOT_FOUND", "message": "Route GET /api/v1/audit-logs not found",
             "request_id": "e5e6f1f6-3d99-4b36-8dc0-92e9b49429af" } }
```

That is a genuine gap against the requirement, not a security feature dressed up as one: the trail exists
and is protected, but an administrator answers "who changed this?" with SQL against `audit_logs` — there
is no API path and no screen. What follows describes what *is* built.

### 12.1 What a row holds
`{ id, actor_id, actor_role, actor_ip, http_request_id, action, entity_type, entity_id, before, after,
created_at, request_id }`. Two columns carry an id that looks like "the request": `http_request_id` is
the `x-request-id` correlation string, so one audit row traces to one API call, and `request_id` is the
BIGINT FK to the audited service request — `SET NULL`, never `CASCADE`, because the trail must outlive
the ticket it describes. `actor_role` is the role as it was at the moment of the action, not as it is
now. The full action inventory lives in `docs/database-design.md` §2.12; in short: every lifecycle move,
the assignment side-effect, draft edits and reprioritisations, `comment.added`, `sla_policy.updated`,
`user.created` / `user.updated` / `role.changed`, and the auth events (login success, failure, blocked,
logout, refresh-reuse, password change).

### 12.2 Two write paths, two different guarantees

| Path | Used by | What it guarantees |
|---|---|---|
| `AuditWrite` closures handed to a repository write | request aggregate, comments, SLA policy edits | the INSERT runs on the **same transaction's client**: a failed audit row rolls the business change back, and a committed change can never be missing from the trail |
| `AuditSink.record()` | auth and security events | best-effort and never throws — an audit outage must not turn a completed login into a 500 |

Both funnel through one statement (`INSERT_AUDIT_SQL`, `backend/src/db/audit.sql.ts`), so they cannot
drift into recording different things. The transactional half is proven by the suite, not asserted:
`undoes a transition whose audit row could not be written` and `undoes a comment and its activity marker
when the comment audit row fails` drive the SQL adapter with a pool whose audit INSERT rejects, and
`commits once, and only once, when every statement in the transaction succeeds` proves the happy path is
not secretly two-phase.

### 12.3 What never reaches the table
`withRedaction()` walks both JSONB images before they are serialised and replaces the value of any key
whose words hit the sensitive list (`password`, `passwd`, `pwd`, `secret`, `token`, `authorization`,
`cookie`, `credential(s)`, `apikey`/`api_key`, `accesskey`, `privatekey`, `session`, `salt`, `hash`,
`otp`, `totp`, `mfa`, `jwt`, `bearer`, `refresh`) with `'[redacted]'`; it splits key names on separators
*and* camel-case boundaries, so `api_key`, `apiKey` and `newPassword` are all caught while ordinary
fields such as `author` or `bypass` survive untouched. Structures deeper than 6 levels or self-referential
are collapsed rather than followed, strings over 512 characters are clipped with an explicit
`…[truncated]` marker, and non-JSON values are rendered as strings so serialising cannot throw. A
password, an access token and a refresh token therefore cannot be recorded even by a service that tried
to pass them through.

**A comment body is never copied into the trail.** The audit row for a comment stores
`{ request_id, request_number, author_id, visibility, characters, is_post_closure }` — the length of the
note, not the note. The live capture makes this visible: the `comment_added` marker for a 61-character
internal comment holds `"characters": 61` and nothing readable from the sentence, and the test
`describes a comment without copying it, keeping the trail distinct from the thread` asserts the body is
absent. That is what keeps "audit history" and "user-visible comments" two different things instead of
two copies of one thing.

### 12.4 Why an ordinary user cannot rewrite it
Migration 017 installs three tiers: `REVOKE UPDATE, DELETE, TRUNCATE` from the application role, BEFORE
`UPDATE`/`DELETE` row triggers on `audit_logs` and `request_events` that raise SQLSTATE `42501`, and a
trigger on `comments` freezing `id`, `request_id`, `author_id`, `created_at` and `is_post_closure` — a
correctable typo may still be edited, but a note cannot be silently re-attributed or back-dated. The
escape hatch is `SET LOCAL esrs.allow_history_mutation = 'on'`, scoped to one transaction.

`docs/database-design.md` §8 states the limits of that in full; the one that has already bitten is worth
repeating here because it is demonstrated rather than theoretical: **a cascading `DELETE FROM requests`
fires the append-only triggers**, so the e2e driver's cleanup must run inside a maintenance transaction.
Also honest: the development database is single-owner, so tier 1 is a guarded no-op there and tier 2 is
what actually protects the rows; rows are immutable but not tamper-evident (no hash chain); and the
timestamp may come from the application clock or from `now()`, which are two clocks.

### 12.5 Planned
`GET /audit-logs?actor=&action=&entity_type=&entity_id=&from=&to=&page=` (admin only, append-only, never
exported through the analytics CSV path without a separate permission) is what ST-502 still needs.
Until it exists, the 404 above is the evidence of the gap.

## 13. Rate limiting & headers
| Scope | Limit |
|---|---|
| `/auth/*` | 10/min/IP (login, refresh 30/min) |
| writes (`POST/PATCH`) | 60/min/user |
| reads | 300/min/user |
| `/files` | 10/min/user |
Global middleware `express-rate-limit` keyed by user→IP fallback; 429 + `Retry-After`.
Security headers via helmet (details security-plan §6). CORS: origin allowlist = web origin only;
credentials true.

## 14. Versioning & evolution
- Path version `/api/v1`; breaking change ⇒ `/v2` + deprecation window; non-breaking = additive fields (clients ignore unknown).
- Every response DTO has a Zod schema in `shared`; FE builds against schemas, BE tests serialize against the same (contract tests in test-plan §4).
- Error codes are an append-only enum (`shared/src/enums/errorCodes.ts`).
- `@esrs/shared` publishes `CONTRACT_VERSION` — **`1.1.0`** — which `GET /meta` reports as
  `contract_version` and the contract test asserts is well-formed semver. The comment and timeline DTOs
  of §7, the `kind` discriminator on timeline entries and `can_comment` on the request projection are the
  additive `1.0.0 → 1.1.0` step: no existing field changed type or meaning, so a `1.0.0` client keeps
  working and simply does not read the new keys.

## 15. Example flows (sequence sketches)

Both flows are tickets the live driver creates on every run and are captured in
`evidence/api-responses/` (`req-index.json` is the full 76-call list, `npm run e2e:requests` regenerates
both). The ids are the same on every run, so they are written out literally.

**Draft → submit** (`REQ-2026-000002`, id 5) — the number only appears when the ticket is filed
```
POST    /requests {draft:true, …}                 [employee]  201 status=draft, request_number null,
                                                              no tracker, no SLA clock
PATCH   /requests/5 {sub_category_id}             [employee]  200 version 1, ETag "1"
PATCH   /requests/5 {priority, reason}            [employee]  403 — priority is manager+
PATCH   /requests/5 {priority, reason}            [manager]   404 — somebody else's draft is invisible
POST    /requests/5/submit                        [employee]  200 REQ-2026-000002, tracker created,
                                                              events: created + submitted(draft→submitted)
PATCH   /requests/5 {title}                       [employee]  409 CONFLICT — no longer a draft
```

**Assign → work → close → reopen → close** (`REQ-2026-000001`, id 4) — the trail in §6.4 and the thread in §7
```
POST    /requests {title, description, …}         [employee]  201 REQ-2026-000001, allowed_actions=["cancel"]
POST    /requests/4/assign {assignee_id}          [employee]  403 — employees may not route tickets
POST    /requests/4/assign {assignee_id:2}        [manager]   200 assigned
POST    /requests/4/assign {assignee_id:…}        [manager]   422 ×3 — unknown / non-agent / other team
POST    /requests/4/comments                      (none)      401 UNAUTHENTICATED
POST    /requests/4/comments {body:"   \n  "}     [employee]  400 — trimmed to nothing
POST    /requests/4/comments {body:<5001 chars>}  [employee]  400 — over the column CHECK
POST    /requests/4/comments {body,author_id,…}   [employee]  400 — .strict() refuses a smuggled author
POST    /requests/4/comments {body,internal}      [employee]  403 — internal notes are staff-only
POST    /requests/4/comments {body}               [employee]  201 comment 1; the request version does
                                                              not move, so no If-Match is invalidated
POST    /requests/4/comments {body,internal}      [agent]     201 comment 2, visibility internal
POST    /requests/4/start    If-Match: "0"        [agent]     409 CONFLICT — the row is at version 1
POST    /requests/4/start    If-Match: "banana"   [agent]     400 BAD_REQUEST — header not a version
PATCH   /requests/4 {priority:"critical",reason}  [manager]   200; SLA due dates do not move (ST-404)
POST    /requests/4/start                         [agent]     200 in_progress
POST    /requests/4/claim                         [agent]     409 INVALID_TRANSITION — already worked
POST    /requests/4/hold {reason}                 [agent]     200 on_hold (no reason → 400)
POST    /requests/4/resume                        [agent]     200 in_progress
POST    /requests/4/resolve {resolution_note}     [agent]     400 — note shorter than 20 characters
POST    /requests/4/resolve {note, reason}        [agent]     200 resolved, tracker completion 'met'
POST    /requests/4/close                         [employee]  200 closed
POST    /requests/4/reopen {reason}               [agent]     403 — only the requester reopens
POST    /requests/4/reopen {reason}               [employee]  200 assigned, back to the previous agent,
                                                              original due date resumed; 409
                                                              REOPEN_WINDOW_EXPIRED after day 7
POST    /requests/4/transition {action:"resolve"} [agent]    200 — same service path as /resolve
POST    /requests/4/close                         [employee]  200 closed
POST    /requests/4/cancel                        [employee]  409 INVALID_TRANSITION — a closed ticket
POST    /requests/4/comments {body}               [employee]  201 is_post_closure=true (BR-8) on a
                                                              ticket that stays closed and immutable
GET     /requests/4/events?limit=50               [employee]  200 the trail, minus the internal note's
                                                              marker — the requester's own slice
GET     /requests/4/events?limit=50               [manager]   200 the same trail plus that marker
GET     /requests/4/events?limit=5000             [employee]  400 — the feed stays bounded
GET     /requests/4/events                        (none)      401 UNAUTHENTICATED
GET     /requests/4/comments                      [employee]  200 two rows, total 2 — the internal note
                                                              was never in the result set
GET     /requests/4/comments                      [agent]     200 three rows, total 3
GET     /requests/4/comments?page=2&page_size=2   [manager]   200 the post-closure row, total still 3
GET     /requests/999999/comments                 [employee]  404 — an invisible parent has no thread
GET     /requests/4/timeline?limit=50             [employee]  200 fourteen entries in feed order
GET     /requests/4/timeline?limit=50             [manager]   200 fifteen — the note is the difference
GET     /requests/4/timeline?limit=5000           [employee]  400 — and that, too, is bounded
GET     /audit-logs                               [admin]     404 — the audit trail has no read route (§12)
```

The read paths are exercised between the two tickets: the requester's own list, an agent's team queue
(`assignee_id=me`), a manager's cross-team filter, the detail view, and the negative cases
(`GET /requests/not-a-number` 400, `GET /requests/999999` 404, `GET /requests/4` as a non-scope
employee 404, `?status=pending` 400 at `status.0`, `?sort=description` 400, `?nonexistent=1` 400 and
`?page_size=5000` clamped to 100 with 200).
