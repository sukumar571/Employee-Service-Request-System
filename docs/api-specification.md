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
| 400 | `VALIDATION_ERROR`, `BAD_REQUEST` (malformed) |
| 401 | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `REFRESH_REUSE` |
| 403 | `FORBIDDEN`, `OUT_OF_TEAM_SCOPE`, `PASSWORD_CHANGE_REQUIRED` |
| 404 | `NOT_FOUND` |
| 409 | `INVALID_TRANSITION`, `CONFLICT` (version/claim), `LAST_ADMIN_GUARD`, `ASSIGNEE_HAS_OPEN_TICKETS` |
| 413 / 415 | `FILE_TOO_LARGE` / `UNSUPPORTED_FILE_TYPE` |
| 423 | `ACCOUNT_LOCKED` |
| 429 | `RATE_LIMITED` (+`Retry-After`) |
| 500 | `INTERNAL` (request_id only; never stack traces) |

### 1.2 Idempotency & concurrency
State-changing single-resource calls accept `If-Match: "<version>"` (optimistic lock) → mismatch 409.
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
| 6.2 | `POST /requests` (draft or direct submit) | employee+ | ST-201/202 |
| 6.3 | `GET /requests/{id}` | scoped | ST-203 |
| 6.4 | `PATCH /requests/{id}` (draft edit) | owner | ST-202 |
| 6.5 | `POST /requests/{id}/submit` | owner | ST-201 |
| 6.6 | `POST /requests/{id}/transition` | scoped | ST-204/303/304/206 |
| 6.7 | `POST /requests/{id}/claim` | agent team | ST-302 |
| 6.8 | `POST /requests/{id}/assign` | manager/admin | ST-304 |
| 6.9 | `GET /requests/{id}/events` | scoped | FR-13 |
| 7.1 | `GET/POST /requests/{id}/comments` | scoped | ST-205 |
| 8.1 | `POST /files` · `GET /files/{id}/download` · `DELETE /requests/{id}/attachments/{aid}` | scoped | ST-201 |
| 9.1 | `GET /sla/trackers/{requestId}` · `GET/PUT /sla/policies` | scoped / manager+ | ST-401/403 |
| 10.1 | `GET /notifications` · `POST /notifications/{id}/read` · `POST /notifications/read-all` | self | ST-601 |
| 11.1 | `GET /analytics/summary` · `/trends` · `/breaches` · `/workload` · `GET /analytics/export` | manager/admin | ST-602/603 |
| 12.1 | `GET /audit-logs` | admin | ST-502 |
| 13.1 | `GET /health/live` · `/health/ready` | public | ST-702 |
| 13.2 | `GET /meta` · `GET /` (endpoint index) | public | ST-702 |
| 13.3 | `GET /openapi.json` | public | ST-702 |

**Served today (scaffold phase):** `GET /`, `GET /health/live`, `GET /health/ready`, `GET /meta`,
`GET /sla/policies`, `PUT /sla/policies/{priority}`. The two SLA routes sit behind the identity
middleware, which is a deliberate **fail-closed gate** until Phase 5 issues JWTs — an anonymous call
returns the standard `401 UNAUTHENTICATED` envelope (verified in `backend/src/app.test.ts`).
Everything else in this index is planned; `GET /openapi.json` will be generated from the Zod contract
and complements (not replaces) `GET /meta`, which the SPA reads at runtime.

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

`GET /users?role=&team=&is_active=&q=` → `{ id, email, full_name, role, department_id, team_category_id, is_active, last_login_at }`
`POST /users` → `{ email, full_name, role, department_id, team_category_id?, initial_password }` — 201;
`must_change_password=true`. `PATCH /users/{id}` (role/team/dept/name; role change audit-logged).
`POST /users/{id}/deactivate` → 409 `ASSIGNEE_HAS_OPEN_TICKETS` when applicable (BR-4); 409 `LAST_ADMIN_GUARD`.

## 5. Taxonomy

`GET /categories` (public to any authenticated; returns active + `deactivatable` flag for admin UI).
`POST /categories {code,name,team_label}`; `PATCH /categories/{id} {name?,is_active?}` — setting
`is_active=false` blocked if open requests exist? **No** — deactivation allowed; open requests keep
working (edge §16.14); new-request form excludes it (query filter). Sub-categories:
`GET/POST /categories/{id}/sub-categories`, `PATCH /sub-categories/{id}`. Departments analogous.

## 6. Requests

### GET /requests — the unified list (visibility-scoped server-side)
Query: `status[]` `priority[]` `category_id` `assignee_id=me|unassigned|<id>` `sla=warning|breached|safe`
`q` (title/number/description) `sort=submitted_at|priority|sla_remaining` `page/page_size`.
Scope rules (architecture §4): `employee` → `requester_id = me AND status <> 'draft'` plus own drafts;
`agent` → team category; `manager/admin` → all.
Item shape:
```jsonc
{ "id":"4192", "request_number":"REQ-2026-000412", "title":"VPN cert expired",
  "status":"in_progress", "priority":"high",
  "category":{"id":"1","name":"IT"}, "sub_category":{"id":"3","name":"Network & VPN"},
  "requester":{"id":"871","full_name":"Rita"}, "assignee":{"id":"881","full_name":"Amit"}|null,
  "submitted_at":"…Z", "sla": { "resolution_due_at":"…Z",
      "resolution_business_minutes_remaining": 137, "state":"safe|warning|breached" },
  "unread_for_me": 2, "version": 4 }
```

### POST /requests
`{ title, description, category_id, sub_category_id, priority, draft: bool, attachment_ids?: [] }`
→ 201 (draft: `status=draft`, no number yet? **Number allocated on submit only**, so drafts show "Draft — save").
Direct submit allowed (`draft=false`) → full submit pipeline (number + SLA tracker + events + queue visibility, ST-201).
Draft validation relaxed (fields may be partial) — submission validates BR-2.

### PATCH /requests/{id} — draft-only field edits (owner). 409 if not draft.
### POST /requests/{id}/submit — validates BR-2, allocates number, creates SLA tracker, emits `submitted` event. 200 with number.

### POST /requests/{id}/transition — single chokepoint (ST-303)
```jsonc
{ "action": "start|hold|resume|resolve|cancel|close_confirm|reopen",
  "reason": "…",            // required: cancel(≥10), hold(≥10), reopen(≥10), priority n/a
  "resolution_note": "…",   // required on resolve (≥20)
  "priority": "medium"      // optional change, managers+; with priority_reason
}
// 200 → { …request dto, version: n+1 }   409 INVALID_TRANSITION | CONFLICT | FORBIDDEN
```
Server-side legality per `requirements.md` §6; `If-Match` honored.

### POST /requests/{id}/claim — atomic self-assign (conflict semantics of §1.2; test R-03) → 200/409.
### POST /requests/{id}/assign `{ assignee_id, reason? }` — manager/admin; assignee must be active user with `team_category_id = request.category_id` else 400 `INVALID_ASSIGNEE`.
### GET /requests/{id}/events — chronological activity (ST-203): `{event_type, actor, actor_role, from_status, to_status, detail, created_at}`; internal-note events visible to agent+ only.

## 7. Comments
`GET /requests/{id}/comments?page=` — employee sees only `visibility='public'` (SQL filtered).
`POST` `{ body, visibility? }` — `internal` allowed for agent+; posting to others' drafts → 403;
resolved/closed requests: requester may still comment (`is_post_closure` auto-set, BR-8).

## 8. Attachments
`POST /files` multipart (`file`) → 201 `{ id, file_name, size_bytes, mime_type }` (status pending;
20 MB hard cap at proxy; per-file 10 MB + type/magic checks). Bound via request create/patch
`attachment_ids`. `GET /files/{id}/download` — auth = can-view-request; header
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

## 12. Audit logs (admin)
`GET /audit-logs?actor=&action=&from=&to=` → `{ id, actor, action, entity, before, after, created_at }`; append-only; CSV export reuses `/analytics/export?type=audit`.

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

## 15. Example flows (sequence sketches)

**Submit → breach warning**
```
POST /requests(draft) → PATCH → POST submit        [employee]
  DB: number=REQ-2026-…, tracker due=business(+24h), event(submitted)
queue GET sees it (team IT)                        [agent]
POST claim → transition start → job at 75% creates notification(sla_warning)
POST transition resolve(note) → tracker.completion_status=met → requester notified
POST transition close_confirm  → status closed, immutable
```
**Reopen after day 3**
```
POST transition reopen(reason) → status assigned, tracker resumes original due,
events: reopened(3), notifications to assignee+requester
```
