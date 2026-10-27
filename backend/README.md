# @esrs/backend — ESRS REST API

Express 5 + TypeScript. Layered architecture (docs/system-architecture.md §3): every request goes
`route → service → repository port → adapter`, and the rules that matter most live in pure
functions under `src/domain/` that never touch Express or PostgreSQL.

## Layout

```
src/
├── main.ts               # process entry: env cascade, listen, graceful shutdown
├── app.ts                # composition root (`createApp`) — the only place wiring happens
├── config/               # env parsing (Zod) + API version/base path
├── http/                 # respond() helpers + schema validation
├── lib/errors/           # AppError, code → status map, toAppError()
├── middleware/           # request context, logging, JWT authn + authz guard, 404, error handler
├── domain/               # pure: clock port, business-hours math, state machine, RBAC policy
├── ports/                # interfaces for I/O collaborators (audit sink)
├── db/                   # pg pool + audit adapter
└── modules/<name>/       # routes.ts · service.ts · repository(.port|.memory|.pg).ts
```

`modules/` ships **auth** (login/refresh/logout/me/change-password, plus the admin user router in
`auth/users.routes.ts`), **health**, **meta**, **request** (drafts, submission, scoped reads, editing,
the whole lifecycle, the append-only event trail, the comment thread and the activity timeline — the
last three in `request.activity.{service,routes}.ts`) and **sla**. Taxonomy, attachments, notifications
and analytics are the next phases and reuse these conventions unchanged. `audit_logs` is written by
every one of those modules but has no read route (see `docs/api-specification.md` §12).

## Commands

| Command                                       | Purpose                                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| `npm run dev:backend`                         | watch mode on `http://localhost:4000` (`tsx watch`)                                    |
| `npm run start:backend`                       | run the compiled `dist/main.js`                                                        |
| `npm run build --workspace @esrs/backend`     | `tsc` emit into `backend/dist`                                                         |
| `npm run typecheck --workspace @esrs/backend` | typecheck source **and** tests                                                         |
| `npm test --workspace @esrs/backend`          | Vitest + Supertest HTTP tests                                                          |
| `npm run verify` (repo root)                  | lint → format → typecheck → test → build, all workspaces                               |
| `npm run e2e:requests` (repo root)            | 76-call lifecycle walk against a running API + PostgreSQL, asserting a status per call |

Environment: copy `backend/.env.example` to `backend/.env` (git-ignored). `main.ts` loads
`.env.<NODE_ENV>.local` → `.env.<NODE_ENV>` → `.env.local` → `.env`, so local overrides never
reach the repository.

## Response conventions

Implemented in `src/http/respond.ts` and typed by `@esrs/shared`:

```jsonc
{ "data": { … } }                                  // single resource
{ "data": [ … ], "meta": { "page": 1, "page_size": 20, "total": 7 } }  // list
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [ { "path": "title", "message": "…" } ],
             "request_id": "8f2c…" } }              // failure
```

- Wire format is `snake_case`; the base path is `/api/v1`; every response echoes `x-request-id`.
- Handlers call `respond`/`validate`; no route builds an envelope by hand.

## Centralized error handling

- `AppError(code, message, { cause, details })` is the only expected failure type; codes are the
  append-only list in `shared/src/enums/errorCodes.ts`.
- `statusForCode.ts` is an exhaustive `Record<ApiErrorCode, number>` — adding a code without a
  status is a compile error.
- `toAppError()` normalises anything else (Zod issues, malformed JSON, body-limit errors, unknown
  exceptions) into an `AppError`. Unexpected errors log the cause with `err` and return only
  `INTERNAL` plus the request id: internals never reach the client (asserted in `app.test.ts`).
- `errorHandler` is registered last; Express 5 forwards rejected promises to it automatically.

## Authorization

Three pieces, each answering a different question:

- `middleware/authenticate.ts` → _who is calling_. It verifies `Authorization: Bearer <jwt>` and copies
  the role, user id and team out of the **signed claims** into `req.auth`. A role is never read from a
  body, query or cookie, so a caller cannot grant itself privileges.
- `domain/rbac/policy.ts` → _may that role ever perform this action_. `can()` is default-deny: the
  `anonymous` role is not in any allow-list, so an unwired guard fails rather than admits.
- the service → _is this the caller's row_. Draft ownership, team queues and the assignee-only verbs are
  object rules that depend on the row, so they live in `RequestService`, and a row outside the caller's
  scope is reported as **404**, never 403.

Net effect: no credentials is **401**, a role the matrix excludes is **403**, a row you may not see is
**404**, and an action the current status forbids is **409**. `/sla` and `/requests` mount behind
`authenticate` **plus** `passwordChangeGate()` (an account still on its temporary password is told so);
`/auth` and `/users` mount before that gate because they guard themselves per route. HTTP tests inject
a fabricated identity through `createApp({ identity })`, so no development backdoor exists in the
production graph.

## Running without PostgreSQL

`DATABASE_URL` is optional in development: `UnconfiguredDatabase` keeps the service bootable and
`GET /health/ready` reports `database.state = "not_configured"` with HTTP 200, while every module falls
back to its in-memory adapter — `InMemorySlaPolicyRepository`, `InMemoryRequestRepository`,
`InMemoryUserRepository`, `InMemoryRefreshTokenStore` and a `RecordingAuditSink`. Set `DATABASE_URL` to
activate `PostgresRequestRepository`, `PostgresSlaPolicyRepository`, `PostgresUserRepository`,
`PostgresRefreshTokenStore` and `PostgresAuditSink`. The two request adapters implement identical
scoping, filtering, ordering, version and multi-record-write semantics, so a rule proven on one holds on
the other — and the Postgres one additionally gets `SELECT … FOR UPDATE` locking and a real
`BEGIN … COMMIT`, which is what makes a submit's five-row write atomic.

## Endpoints

| Method  | Path                                  | Access                            | Notes                                                              |
| ------- | ------------------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| `GET`   | `/api/v1`                             | public                            | index: service, version, endpoints                                 |
| `GET`   | `/api/v1/health/live`                 | public                            | process up; no dependency checks                                   |
| `GET`   | `/api/v1/health/ready`                | public                            | `degraded` + 503 when a dependency is down                         |
| `GET`   | `/api/v1/meta`                        | public                            | enums, lifecycle table, SLA defaults (drives the SPA)              |
| `POST`  | `/api/v1/auth/login`                  | public, rate-limited              | access token + rotating httpOnly refresh cookie; 423 on lockout    |
| `POST`  | `/api/v1/auth/refresh`                | refresh cookie                    | reuse of a replaced token revokes the whole family                 |
| `POST`  | `/api/v1/auth/logout`                 | refresh cookie                    | idempotent; burns the family, clears the cookie                    |
| `GET`   | `/api/v1/auth/me`                     | any authenticated                 | current-user snapshot (SPA bootstrap)                              |
| `POST`  | `/api/v1/auth/change-password`        | any authenticated                 | escapes the forced-change gate; revokes the other families         |
| `GET`   | `/api/v1/users`                       | admin                             | `user.manage`; filter by role/team/active                          |
| `POST`  | `/api/v1/users`                       | admin                             | no self-registration; initial password + forced change             |
| `PATCH` | `/api/v1/users/:id`                   | admin                             | role/team/department/`is_active`; last-admin guard, audited        |
| `POST`  | `/api/v1/requests`                    | any authenticated                 | draft or direct submit; a protected field is a 400 that names it   |
| `GET`   | `/api/v1/requests`                    | scoped                            | pagination, filtering, sorting, search                             |
| `GET`   | `/api/v1/requests/:id`                | scoped                            | detail + `ETag`; out of scope is indistinguishable from missing    |
| `GET`   | `/api/v1/requests/:id/events`         | scoped                            | append-only trail, `?limit=1..200`                                 |
| `PATCH` | `/api/v1/requests/:id`                | owner · manager+ priority         | draft content; `priority` needs a manager and a reason             |
| `POST`  | `/api/v1/requests/:id/submit`         | owner                             | allocates `REQ-YYYY-NNNNNN` and the SLA tracker in one transaction |
| `POST`  | `/api/v1/requests/:id/claim`          | agent+                            | atomic self-assign; the loser of the race gets 409                 |
| `POST`  | `/api/v1/requests/:id/assign`         | manager+                          | same-team active agent, else 422 `INVALID_ASSIGNEE`                |
| `POST`  | `/api/v1/requests/:id/{start,resume}` | assignee (manager+ may act)       | `request.transition`                                               |
| `POST`  | `/api/v1/requests/:id/hold`           | assignee (manager+ may act)       | reason ≥ 10 characters                                             |
| `POST`  | `/api/v1/requests/:id/resolve`        | assignee (manager+ may act)       | note ≥ 20 characters; stamps `resolved_at` and the tracker         |
| `POST`  | `/api/v1/requests/:id/close`          | requester                         | from `resolved`; the record becomes immutable                      |
| `POST`  | `/api/v1/requests/:id/reopen`         | requester                         | 7-day window, else 409 `REOPEN_WINDOW_EXPIRED`                     |
| `POST`  | `/api/v1/requests/:id/cancel`         | requester                         | from `draft`, `submitted` or `assigned`                            |
| `POST`  | `/api/v1/requests/:id/transition`     | per action named in the body      | the generic chokepoint; aliases of the verbs above, one service    |
| `GET`   | `/api/v1/requests/:id/comments`       | scoped                            | thread oldest-first; `internal` rows only for agent+               |
| `POST`  | `/api/v1/requests/:id/comments`       | scoped; `internal` needs agent+   | 1–5000 chars, author/timestamp server-set; BR-8 closure flag       |
| `GET`   | `/api/v1/requests/:id/timeline`       | needs events **and** comment read | events + comments merged chronologically, `?limit=1..200`          |
| `GET`   | `/api/v1/sla/policies`                | any authenticated                 | four policies in resolution-target order                           |
| `PUT`   | `/api/v1/sla/policies/:priority`      | manager+                          | reason required, audited, 400 on inverted targets                  |

`docs/api-specification.md` §6 documents the request surface and §7 the comment/timeline surface, both
with responses captured from a live server, and `src/request.http.test.ts` (149 tests) is the
executable version of that contract.
