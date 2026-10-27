# Employee Service Request System (ESRS)

An internal service-desk portal: employees raise IT / HR / Facilities requests, agents work the
tickets under SLA targets, managers route and monitor, administrators manage the system.

This repository implements the architecture documented in [`docs/`](docs) as a maintainable
**npm-workspaces monorepo**: a React SPA, an Express + TypeScript REST API, a SQL migration and
seed package, and a frozen `shared` contract package that both sides of the wire import.

| Package     | Name             | Purpose                                                                                                    |
| ----------- | ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `shared/`   | `@esrs/shared`   | Enums, Zod DTOs, error codes, lifecycle transition table - the single source of truth for the API contract |
| `database/` | `@esrs/database` | node-pg-migrate SQL migrations, idempotent seeds, runner scripts                                           |
| `backend/`  | `@esrs/backend`  | Express 5 REST API: routes -> services -> repository ports (memory + Postgres adapters), pure domain layer |
| `frontend/` | `@esrs/frontend` | React 19 + Vite + Tailwind CSS 4 portal                                                                    |
| `docs/`     | -                | Requirements, user stories, architecture, database design, API spec, security plan, test plan, ADRs        |
| `evidence/` | -                | Generated proof: lint/typecheck/test/build output, live API responses, screenshots                         |

---

## Prerequisites

- **Node.js >= 22.12** and **npm >= 11** (the workspace protocol and `packageManager` field enforce it)
- **Docker Desktop** (only to run PostgreSQL) - or any reachable PostgreSQL 16 instance

```
node -v     # expect v22.x or newer
npm -v      # expect 11.x
```

## Quick start

```bash
npm ci                      # install every workspace from the single lockfile
cp .env.example .env        # root env (docker compose reads this)
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
cp database/.env.example database/.env    # only needed to migrate/seed

npm run verify              # lint + typecheck + test + build, all workspaces
npm run dev                 # shared (watch) + API on :4000 + portal on :5173
```

Open <http://localhost:5173>. The portal talks to the API through the Vite proxy
(`/api` -> `http://localhost:4000`), so no base URL is baked into the client.

**The API starts without a database.** When `DATABASE_URL` is unset every module falls back to its
in-memory adapter — `/api/v1/meta`, the SLA policies, users, the whole request lifecycle — and
`/health/ready` reports `not_configured`, so frontend work and CI never need Postgres. To use the SQL
persistence path:

```bash
npm run db:up        # docker compose up -d postgres  (and postgres-test on :5433)
npm run db:migrate   # apply database/migrations/*.sql
npm run db:seed      # reference data (demo data additionally requires SEED_DEMO_PASSWORD)
npm run db:status    # which migrations are applied
```

## Commands

All commands run from the repository root; `npm run <script> -w @esrs/<pkg>` reaches a single
workspace.

| Command                                                                     | What it does                                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `npm run dev`                                                               | shared (watch) + backend (tsx watch) + frontend (Vite) together                 |
| `npm run dev:backend` / `npm run dev:frontend` / `npm run dev:shared`       | one process only                                                                |
| `npm run build`                                                             | build shared, then backend (`tsc`), then frontend (`vite build`)                |
| `npm run start:backend`                                                     | run the compiled API (`backend/dist/main.js`)                                   |
| `npm run preview:frontend`                                                  | serve the built portal on <http://localhost:4173>                               |
| `npm run lint` / `npm run lint:fix`                                         | ESLint flat config over every workspace, architectural boundaries included      |
| `npm run format` / `npm run format:check`                                   | Prettier write / verify                                                         |
| `npm run typecheck`                                                         | `tsc --noEmit` for all four workspaces (tests included)                         |
| `npm run test`                                                              | Vitest suites for all four workspaces                                           |
| `npm run test:coverage`                                                     | the same with V8 coverage                                                       |
| `npm run verify`                                                            | lint -> typecheck -> test -> build (the CI gate, also what `evidence/` records) |
| `npm run evidence`                                                          | run `verify` **and** probe a live API into `evidence/`                          |
| `npm run e2e:requests`                                                      | replay 76 request-API calls against a live API + PostgreSQL, asserting a status |
| `npm run db:migrate` / `db:rollback` / `db:status` / `db:seed` / `db:reset` | schema and data operations                                                      |
| `npm run db:make -- 015_add_tickets_table`                                  | scaffold the next numbered migration                                            |
| `npm run db:up` / `db:down`                                                 | Docker Compose PostgreSQL                                                       |

## Configuration

Environment-specific configuration is parsed and validated by Zod at boot
(`backend/src/config/env.ts`); an invalid variable fails startup with a readable message instead of
producing a half-configured process.

| File                    | Consumed by                      | Notable keys                                                                                                                                                                                                                            |
| ----------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.env.example`          | docker compose + shared defaults | `NODE_ENV`, `POSTGRES_USER/PASSWORD/DB/PORT`, `POSTGRES_TEST_PORT`, `DATABASE_URL`, `DATABASE_URL_TEST`                                                                                                                                 |
| `backend/.env.example`  | API                              | `NODE_ENV`, `PORT`, `SERVICE_NAME`, `LOG_LEVEL`, `DATABASE_URL`, `DATABASE_POOL_MAX`, `STATEMENT_TIMEOUT_MS`, `BODY_LIMIT_KB`, `CORS_ORIGINS`, `TRUST_PROXY`, `JWT_ACCESS_SECRET`, `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_DAYS` |
| `frontend/.env.example` | SPA build                        | `VITE_API_BASE_URL` (default `/api/v1`), `VITE_DEV_API_TARGET`                                                                                                                                                                          |
| `database/.env.example` | migration/seed runner            | `DATABASE_URL` or `POSTGRES_*`, `SEED_DEMO_PASSWORD`                                                                                                                                                                                    |

Rules:

- `.env` files are git-ignored; only `.env.example` templates are committed, and their values are
  placeholders, never real credentials (`JWT_ACCESS_SECRET` is deliberately empty in the template and
  generated ephemerally in development).
- `NODE_ENV` selects the defaults (development / test / production), and production tightens them:
  boot fails when `JWT_ACCESS_SECRET` is missing or when `CORS_ORIGINS` still points at `localhost`.
- No secret is hardcoded in source. Demo passwords are generated at seed time from
  `SEED_DEMO_PASSWORD` (bcrypt cost 12) and injected into `database/seeds/002_demo_data.sql`, which
  ships a `{{DEMO_PASSWORD_HASH}}` token; seeding refuses to run when the variable is unset.

## Conventions

- **Naming.** Packages `@esrs/<word>`; directories `kebab-case`; TS/React symbols `camelCase` for
  values and `PascalCase` for types/components; SQL `snake_case`; environment variables
  `SCREAMING_SNAKE_CASE`; tests `*.test.ts` next to the code they cover.
- **Module shape.** `backend/src/modules/<feature>/` holds `<feature>.routes.ts`,
  `<feature>.service.ts`, `<feature>.repository.ts` (the port) and `<feature>.repository.{memory,pg}.ts`
  (the adapters). ESLint rejects cross-module repository imports - talk to a feature through its service.
- **Domain purity.** `backend/src/domain/**` imports nothing from `express`, `pg` or Node built-ins;
  time always comes from the injected `Clock` port, which makes SLA math deterministic to test.
- **Imports.** Backend and shared are ESM with `moduleResolution: NodeNext`, so relative imports
  carry the `.js` extension; the frontend uses bundler resolution and extensionless imports.

### Centralized error handling

`backend/src/lib/errors/` defines `AppError { code, message, status, details, cause }` with an
**exhaustive** `ApiErrorCode -> HTTP status` map (`STATUS_FOR_ERROR_CODE`), so a new error code
cannot be added without deciding its status. Every route is wrapped by one `errorHandler` middleware
that: converts `ZodError` and body-parser failures into `AppError`, logs 5xx at error level and 4xx
at warn level, attaches the `x-request-id`, and never leaks internals or stack traces. Express 5
forwards rejected async handlers there automatically, so route files contain no `try/catch`.

### API response conventions

Every endpoint answers under `/api/v1` with one of two shapes:

```jsonc
// success
{ "data": <resource> }
{ "data": [<items>], "meta": { "page": 1, "page_size": 20, "total": 137 } }

// failure
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid request payload",
             "details": [{ "path": "reason", "message": "too_short" }],
             "request_id": "trace-2026-10-25-0001" } }
```

`x-request-id` is echoed on every response (a client-supplied id is honoured only when it matches a
safe shape, otherwise a UUID is generated). The schemas that define these envelopes live in
`shared/src/dto/envelope.ts` and are used by the API, the tests and the frontend client alike.

Current surface: `GET /api/v1`, `GET /api/v1/health/{live,ready}`, `GET /api/v1/meta`, the full
`/api/v1/auth` set (login, refresh, logout, me, change-password), `GET|POST /api/v1/users` +
`PATCH /api/v1/users/:id`, `GET|PUT /api/v1/sla/policies[/:priority]` and the complete request API —
`POST|GET /api/v1/requests`, `GET|PATCH /api/v1/requests/:id`, `GET /api/v1/requests/:id/events`,
`GET|POST /api/v1/requests/:id/comments`, `GET /api/v1/requests/:id/timeline` and
`POST /api/v1/requests/:id/{submit,claim,assign,start,hold,resume,resolve,close,reopen,cancel,transition}`.
`GET /api/v1` answers that list at runtime, and [`docs/api-specification.md`](docs/api-specification.md)
§6 documents each request endpoint and §7 each comment/timeline endpoint with captured payloads.

## Testing and evidence

| Workspace  | Suite                                                                                                        | Files |
| ---------- | ------------------------------------------------------------------------------------------------------------ | ----- |
| `shared`   | contract tests: transition table, enums, envelope schemas                                                    | 2     |
| `database` | SQL <-> contract parity (enums, SLA defaults, business hours, migration naming)                              | 1     |
| `backend`  | domain (state machine, business hours, RBAC, clock), auth + request services, HTTP integration via Supertest | 12    |
| `frontend` | API client, components, page behaviour (Vitest + Testing Library)                                            | 5     |

```bash
npm run verify     # green means lint + typecheck + test + build all pass
npm run evidence   # writes evidence/*.txt and evidence/api-responses/*.json
```

`npm run evidence` runs the quality gates verbatim and probes the live API, so a running server is
needed for the HTTP captures (start it first with `npm run dev` or `npm run start:backend`).
`npm run e2e:requests` additionally replays the request lifecycle against that server and PostgreSQL,
asserting an expected status per call and writing `evidence/api-responses/req-*.json`, which the
collector indexes. Screenshots are the one manually captured artifact: place them in
`evidence/screenshots/` and the next `npm run evidence` run indexes them in `evidence/README.md`.

## Security posture

Implemented today: a real authentication gate (`Authorization: Bearer <jwt>` verified against signed
claims — the role is never taken from the request), rotating httpOnly refresh tokens with
family-reuse revocation, forced password change, login rate limit + lockout, default-deny role checks in
`domain/rbac/policy.ts` plus per-row scoping in the services (an invisible row is a 404, not a 403),
parameterized SQL only, optimistic locking with `ETag`/`If-Match`, Zod validation at every boundary,
helmet + `nosniff` + no `x-powered-by`, CORS allowlist, body-size limit, an append-only history
(`audit_logs` and `request_events` are written inside the transaction they describe and blocked from
UPDATE/DELETE by migration 017's triggers, with least-privilege grants where a separate `esrs_app`
role exists), structured logs with request
correlation, and the error handler's no-leak guarantee (covered by a test that asserts a thrown
connection string never reaches the response body). `docs/security-plan.md` is the checklist that
governs the rest.

## What is implemented, what is next

Phases 0-5 of `docs/system-architecture.md` section 11, requests core (7), comments and the activity
timeline (8) and the SLA-policy slice of 9:
the monorepo, tooling, contract package, complete SQL schema and seeds, the pure domain core with its
tests, the HTTP spine (config, logging, request-id, envelopes, error handling, health, meta), auth
(login/refresh/logout/me/change-password plus admin user provisioning) and the full service-request API
— drafts, submission with gapless `REQ-YYYY-NNNNNN` numbering, scoped lists with pagination, filtering,
sorting and search, the ten lifecycle verbs, optimistic locking and the append-only event trail, public
and staff-only comments, a merged activity timeline, an append-only `audit_logs` trail written in the
same transaction as the change it describes, all served by interchangeable in-memory and PostgreSQL
adapters.

Next, in dependency order: taxonomy CRUD (the rest of Phase 6), the scheduled SLA sweep plus
auto-close/draft expiry (9b, 10), attachments (11), notifications (12),
analytics (13) and the audit read API (14) — then the portal flows that consume them, since the SPA still
has no login screen of its own.

## Troubleshooting

| Symptom                                                           | Cause and fix                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ERESOLVE` while installing                                       | `@hookform/resolvers` v6 conflicts with React Hook Form 7; the root lockfile pins `^5.9.2`. Use `npm ci`                                                                                         |
| `'ESM request pointing to a CJS module'` / `ERR_MODULE_NOT_FOUND` | `@esrs/shared` was not built. Run `npm run build:shared` (or `npm run dev`, which builds first)                                                                                                  |
| `GET /health/ready` answers `database: not_configured`            | Expected without `DATABASE_URL`. Start Postgres with `npm run db:up` and set the variable                                                                                                        |
| `401 UNAUTHENTICATED` on `/api/v1/sla/*` or `/api/v1/requests/*`  | Expected without a token: `POST /api/v1/auth/login`, then send `Authorization: Bearer <access_token>`. The SPA has no login screen yet, so its guarded views (SLA policies) render this envelope |
| `403 PASSWORD_CHANGE_REQUIRED`                                    | The account still carries `must_change_password`; `POST /api/v1/auth/change-password` first                                                                                                      |
| Port 4000 or 5173 already in use                                  | Override `PORT` in `backend/.env` and `server.port`/proxy target in `frontend/vite.config.ts`                                                                                                    |
| Migration runner says "No database configured"                    | `database/.env` (or the root `.env`) lacks `DATABASE_URL`/`POSTGRES_*`                                                                                                                           |
