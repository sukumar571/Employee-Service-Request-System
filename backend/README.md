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
├── middleware/           # request context, logging, authz guard, 404, error handler
├── domain/               # pure: clock port, business-hours math, state machine, RBAC policy
├── ports/                # interfaces for I/O collaborators (audit sink)
├── db/                   # pg pool + audit adapter
└── modules/<name>/       # routes.ts · service.ts · repository(.port|.memory|.pg).ts
```

`modules/` currently ships the contract-safe vertical slice: **health**, **meta** and **sla**.
Requests, comments, attachments, notifications, admin and analytics are the next phases and reuse
these conventions unchanged.

## Commands

| Command                                       | Purpose                                             |
| --------------------------------------------- | --------------------------------------------------- |
| `npm run dev:backend`                         | watch mode on `http://localhost:4000` (`tsx watch`) |
| `npm run start:backend`                       | run the compiled `dist/main.js`                     |
| `npm run build --workspace @esrs/backend`     | `tsc` emit into `backend/dist`                      |
| `npm run typecheck --workspace @esrs/backend` | typecheck source **and** tests                      |
| `npm test --workspace @esrs/backend`          | Vitest + Supertest HTTP tests                       |

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

`requirePermission(permission)` reads `req.auth`, which is only ever populated by the
authentication middleware of Phase 5. Until that module exists every guarded endpoint answers
**401**, and a request with an out-of-scope role gets **403** — the failure mode of an unwired
guard is "deny", never "allow" (`domain/rbac/policy.ts` + `middleware/requirePermission.ts`).
HTTP tests inject a test identity through `createApp({ identity })`, so no development backdoor
exists in the production graph.

## Running without PostgreSQL

`DATABASE_URL` is optional in development: `UnconfiguredDatabase` keeps the service bootable and
`GET /health/ready` reports `database.state = "not_configured"` with HTTP 200, while the SLA module
falls back to `InMemorySlaPolicyRepository`. Set `DATABASE_URL` to activate
`PostgresSlaPolicyRepository` and `PostgresAuditSink`.

## Endpoints

| Method | Path                             | Access   | Notes                                                 |
| ------ | -------------------------------- | -------- | ----------------------------------------------------- |
| `GET`  | `/api/v1`                        | public   | index: service, version, endpoints                    |
| `GET`  | `/api/v1/health/live`            | public   | process up; no dependency checks                      |
| `GET`  | `/api/v1/health/ready`           | public   | `degraded` + 503 when a dependency is down            |
| `GET`  | `/api/v1/meta`                   | public   | enums, lifecycle table, SLA defaults (drives the SPA) |
| `GET`  | `/api/v1/sla/policies`           | public   | four policies in resolution-target order              |
| `PUT`  | `/api/v1/sla/policies/:priority` | manager+ | reason required, audited, 400 on inverted targets     |
