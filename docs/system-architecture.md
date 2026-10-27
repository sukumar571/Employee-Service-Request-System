# ESRS — System Architecture

Companion to `requirements.md` (behavior) and `database-design.md` (persistence).
Status: Draft v1.0. Changes here require updating §11 (build order) and affected docs.

---

## 1. Architecture style

**Modular monolith + SPA** — a single Express API service and a single React SPA, backed by one
PostgreSQL instance. Chosen deliberately over microservices for an MVP/internship scope:
one deployable, one transaction boundary, simple testing; modules inside the API keep
clean boundaries so extraction later is possible but not paid for now.

```
┌──────────────┐  HTTPS/JSON   ┌───────────────────────────────────┐        ┌────────────┐
│  React SPA   │ ────────────▶ │            Express API            │        │ PostgreSQL │
│ (Vite, TS,   │  fetch +      │  ┌─────────────────────────────┐  │  pg    │  (single)  │
│  Tailwind)   │  Bearer/      │  │ HTTP layer (routes,zod,auth)│  │ ─────▶ │            │
└──────────────┘  refresh      │  ├─────────────────────────────┤  │        └────────────┘
      ▲  cookie                 │  │ Application services        │  │
      │                        │  ├─────────────────────────────┤  │        ┌────────────┐
┌─────┴────────┐               │  │ Domain (pure TS: state       │  │        │ local disk │
│ Browser      │               │  │ machine, SLA clock, RBAC)    │  │ ─────▶ │ volume for │
│ (employee /  │               │  ├─────────────────────────────┤  │ │multipart│ attachments│
│  agent /     │               │  │ Infra (repos, pg pool, mail? │  │ └────────┴────────────┘
│  manager /   │               │  │  no — out of MVP, storage)   │  │
│  admin)      │               │  └─────────────────────────────┘  │        └──────────────┘
└──────────────┘               │  Scheduler (SLA sweep, auto-close)│
                               └───────────────────────────────────┘
```

## 2. Repository layout (npm workspaces monorepo)

Shipped layout — four workspace packages at the repository root (`package.json` →
`workspaces: ["shared", "database", "backend", "frontend"]`), one lockfile, one tool config set.

```
esrs/
├─ package.json                  # root scripts: dev, dev:api, dev:web, build, lint, format,
│                                # typecheck, test, verify, evidence, e2e:requests,
│                                # db:{up,down,migrate,seed,status,reset,make}
├─ eslint.config.mjs             # flat config: typed rules + architectural import boundaries
├─ tsconfig.base.json            # strict superset inherited by every package
├─ docker-compose.yml            # postgres + postgres-test (api/web containers: Phase 21)
├─ scripts/collect-evidence.mjs  # runs the suites and probes a live API into evidence/
├─ scripts/e2e-requests.mjs      # 76-call lifecycle walk against the API + PostgreSQL (asserts status)
├─ docs/                         # this documentation set
├─ evidence/                     # generated test/build output + screenshots (`npm run evidence`)
├─ shared/                       # @esrs/shared — enums + zod DTOs + transition table (no Node APIs)
│  └─ src/{enums,dto,domain}/
├─ database/                     # @esrs/database — schema and data as reviewable SQL
│  ├─ migrations/NNN_name.sql    # node-pg-migrate Up/Down markers, 001…017 (database-design §3)
│  ├─ seeds/{001_reference_data,002_demo_data}.sql
│  ├─ scripts/                   # run.mjs (up|down|status|seed|reset|make), seed.mjs, config.mjs
│  └─ test/enumParity.test.ts    # contract test C-02: SQL enums/defaults == @esrs/shared
├─ backend/                      # @esrs/backend — Express 5 + TypeScript API (ESM, NodeNext)
│  └─ src/
│     ├─ app.ts / main.ts        # composition root (app vs listen split for Supertest)
│     ├─ config/                 # zod env parsing → typed config, version constants
│     ├─ db/                     # Database port + pg adapter + PostgresAuditSink; UnconfiguredDatabase
│     ├─ domain/                 # PURE — no express/pg/node imports (ESLint-enforced)
│     │  ├─ request/stateMachine.ts
│     │  ├─ sla/businessHours.ts
│     │  ├─ rbac/policy.ts       # can(actor, action) — single source of truth
│     │  └─ ports/clock.ts       # Clock { now(): Date }, injectable for tests
│     ├─ http/                   # router wiring + zod boundary parsing (params/query/body)
│     ├─ middleware/             # request-id context, logging, JWT authN + forced-change + authZ gates, error handler
│     ├─ modules/                # feature slices: routes → service → repository port → adapters
│     │  ├─ health/ meta/ sla/   # contract-safe vertical slice (phases 3–4 + the policy API of 9)
│     │  ├─ auth/                # login/refresh/logout/me/change-password, lockout, JWT + users.routes.ts (admin)
│     │  ├─ request/             # requests core (7) + comments/timeline (8): CRUD, lifecycle verbs, events,
│     │  │                       #   activity service + routes, directory; memory + pg adapters
│     │  └─ taxonomy/ attachments/ notifications/ analytics/ audit/          # planned
│     ├─ jobs/                   # node-cron: sla-sweep, auto-close, draft-expiry (planned)
│     └─ lib/                    # logger(pino), errors(AppError + exhaustive code→status map), envelopes
└─ frontend/                     # @esrs/frontend — React 19 + Vite + Tailwind CSS 4 SPA
   └─ src/
      ├─ main.tsx / App.tsx      # router + QueryClient providers + layout shell
      ├─ api/queries.ts          # TanStack Query hooks over the typed client
      ├─ lib/                    # apiClient (envelope + ApiError), config, format, cx
      ├─ components/             # Layout, Feedback (Spinner/Notice/ErrorNotice), Badge, Activity (thread + timeline)
      ├─ pages/                  # Dashboard, Lifecycle simulator, Request activity, SLA policies, NotFound
      └─ test/                   # RTL harness (fetch stub, fixtures, provider wrapper)
```

**Import rules (enforced by ESLint `no-restricted-imports`):**
`domain` → nothing outside `domain`+`shared` · `modules/*` may import domain, shared, lib, db ·
no cross-module repository imports (talk via service layer) · `frontend` may import `shared` only.

## 3. Frontend design

| Concern | Decision |
|---|---|
| Routing | React Router v6; route guards `<RequireAuth roles=[…]>`; role-based homes (`/me/requests`, `/queues`, `/admin`) |
| Server state | TanStack Query (caching, retries, invalidation per mutation); no global Redux needed |
| Forms | React Hook Form + zod resolver using **the same schemas from `shared`** (single validation source of truth) |
| Auth storage | access token in memory; refresh via `httpOnly` cookie; on 401 → one refresh call → retry (ST-102) |
| Design system | Tailwind only; status/priority colors centralized in `tokens.ts`; AA contrast (ST-703) |
| Data tables | server-side pagination/filter/sort serialized in URL query (queue filters persist, ST-301) |
| SLA countdown | computed from server-provided `due_at` + `business_hours_remaining` — client never reimplements clock math |

## 4. Backend design (layered within each module)

```
route (HTTP in/out, zod parse, auth mw)
  → service (use-case orchestration, transactions, domain calls, emits notifications/activity)
    → repository (parameterized SQL via pg; no business logic)
domain functions are called by services, never by routes/repos (testable without HTTP/DB).
```

- **Error model:** `AppError { code: ErrorCode, status, message }` → central error handler maps to
  `{ error: { code, message, details? } }`. Unknown errors → 500 + request-id logged, never leaked.
- **AuthN middleware** attaches `AuthContext { userId, role, teamId }`; **RBAC policy** (`domain/rbac`)
  answers `can(actor, action, resourceContext)`; visibility filter (team scoping §7 requirements) is a
  repository **query constraint** applied in services — never trust client filters.
- **State transitions** flow through one service function `transitionRequest(id, action, actor, reason, expectedVersion)`
  which: loads row `FOR UPDATE`-equivalent (version check), consults `domain/request/stateMachine`,
  updates + writes activity + notifications + SLA side-effects **in one transaction**.
- **Optimistic concurrency:** `requests.version`; stale writes → 409 `CONFLICT` with current state (edge §16.4).
- **Clock port:** `Clock { now(): Date }` injected everywhere; jobs and SLA math use it → deterministic tests (NFR-6).

## 5. Cross-cutting subsystems

| Subsystem | Design |
|---|---|
| SLA engine | Trackers created on submit (snapshot of policy). `businessHoursBetween(a,b)` pure fn. Sweep job (every 5 min) evaluates elapsed → emits `sla_warning`(75 %)/`sla_breach` once per tracker (flags `warned_at`, `breached_at`). Pause/resume recorded as segments, not recomputed from scratch. |
| Activity history | Derived `request_events` (typed events incl. status, assign, priority, hold) written in the same transaction as mutations; read-only API. Distinct from `audit_logs` (security/admin events). Distinct from `comments` too: a `comment_added` event carries a summary (length, visibility, comment id) and never the body, and the summary follows the comment's visibility, so an internal note leaves no marker in a requester's trail. |
| Notifications | DB table + in-app only; written by services via `notify(userId, type, payload)` in same txn; FE polls unread count every 60 s (MVP; SSE deferred). |
| Attachments | `POST /files` (multipart, streaming to tmp) → magic-byte check (`file-type`) → move to volume → row `attachments(status=pending)`; bound on request save; nightly purge of orphans (BR-3). Download via authorized URL, `Content-Disposition` set, served with `X-Content-Type-Options: nosniff`. |
| Jobs | node-cron inside API process (single instance assumed A-1); each job idempotent + advisory-locked (`pg_advisory_lock`) so restarts don't double-run. |

## 6. Validation strategy (Zod)

- `shared/` (`@esrs/shared`) owns every request/response schema + enums (`RequestStatus`, `Priority`, `Role`,
  `NotificationType`) → API parses bodies/queries, the SPA wires the same schema into Hook Form.
- DB keeps independent CHECK constraints + FKs (defense in depth; see database-design §4).
- Drift guard test: a unit test asserts FE enum union === BE enum (imported from shared) — snapshot.

## 7. Authentication flow (sequence)

```
Login:  POST /auth/login {email,pw} → verify bcrypt (+ dummy-verify on miss for timing parity)
        → check lockout → issue access JWT (15m, in-memory at client)
        → issue refresh token (random 256-bit, stored hashed, family id) Set-Cookie httpOnly
Refresh: POST /auth/refresh (cookie) → rotate (invalidate old, new family-member); reuse ⇒ revoke family
Logout:  POST /auth/logout → revoke family
```
Details, token claims and hardening: `security-plan.md` §3.

## 8. Deployment topology (Docker)

```
docker-compose.yml
  ├─ postgres:16-alpine        # named volume pgdata; healthcheck
  ├─ migrator                  # node-pg-migrate up; restart:"on-failure"; then exits
  ├─ api                       # build: docker/api.Dockerfile (multi-stage, node:20-alpine)
  │     depends_on: postgres (healthy), migrator (completed_successfully)
  ├─ web                       # nginx serve of Vite build; /api proxied → api:4000
  └─ (demo profile) seed        # one-shot idempotent seed, profiles: ["demo"]
```
Dev mode: compose runs only `postgres`; `npm run dev` starts the API (tsx watch, port 4000) + the SPA
(Vite, port 5173) with Vite proxy `/api → localhost:4000` — the same path prefix as nginx in prod,
so client code never holds environment-specific base URLs. Env via `.env` (never committed;
`.env.example` provided). Published host ports: web `8080`, api `4000` (overrideable in `.env`).

## 9. Observability

- `pino` structured JSON logs with `request_id` (AsyncLocalStorage) + `user_id` on every line.
- `GET /health/ready` (DB ping) & `/health/live`; migration status logged at boot.
- Slow-query log (`pg` `statement_timeout` 5 s + `log_min_duration_statement: 250ms`).
- MVP: no APM — stdout + Docker logging; metrics endpoint deferred (documented risk accepted).

## 10. Module dependency graph (build these first → later)

```
          [0 toolchain/monorepo]
                   │
     ┌─────────────┼──────────────┐
     ▼             ▼              ▼
[1 shared]     [2 db+migrations]  │
     │             │              │
     │        [3 config/err/log]  │
     │             │              │
     ▼             ▼              ▼
     └────▶ [4 domain: stateMachine, businessHours, rbac]  (pure, tests first)
                     │
                     ▼
              [5 auth module] ──▶ [6 users + taxonomy]
                     │                   │
                     ▼                   ▼
              [7 requests core] ◀───────┘   (needs domain + auth + taxonomy)
                ├─▶ [8 comments + activity]
                ├─▶ [9 attachments]
                └─▶ [10 SLA trackers/policy + scheduler]
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
 [11 notifications][12 analytics][13 audit]
        │            │            │
        └────────────┼────────────┘
                     ▼
        [14 FE shell+routing+auth] → [15 FE employee portal] → [16 FE agent workspace]
                     → [17 FE admin + analytics] → [18 hardening, a11y, e2e-ish smoke]
```

Rules: a module starts only when everything upstream is merged; FE modules 15–17 need only API
contract (mocks via MSW) — can proceed in parallel once `shared` schemas for them exist.

## 11. Implementation order (phases = PR-sized increments)

| # | Phase (deps) | Deliverable | Stories |
|---|---|---|---|
| 0 | — | Monorepo scaffold (npm workspaces, TS strict, ESLint/Prettier, Vitest configs, `shared`+`database`+`backend`+`frontend` skeletons), compose with Postgres, `npm run verify` green | ST-702 ✅ shipped |
| 1 | 0 | `shared`: enums + zod schemas + error codes; contract freeze doc | all ✅ shipped |
| 2 | 0 | Migrations 001–017 + `seeds/` (all tables, indexes, CHECKs; see database-design §3), pg pool, node-pg-migrate runner scripts, enum/SLA parity test | ✅ shipped — applied to a live PostgreSQL 16 (`npm run db:migrate`) and exercised through the API by `npm run e2e:requests` |
| 3 | 2 | config (zod env), error model, logger, request-id, health endpoints, `/meta` catalogue | ST-702 ✅ shipped |
| 4 | 1,2 | **Domain core** with tests-before-code: state machine, business-hours math, RBAC policy (TDD, ≥ 90 % lines on `domain/`) | ST-401a ✅ shipped |
| 5 | 3,4 | Auth: login/refresh/logout/change-password, lockout, JWT mw, bcrypt | ST-101–104 ✅ shipped (in-memory + Postgres adapters; rotation, reuse revocation and lockout covered by unit + HTTP tests, and a real login drives `npm run e2e:requests`) |
| 6 | 5 | Users admin (create/deactivate/roles, BR-4 guards), departments/categories/sub-categories CRUD + seed taxonomy | ST-105, ST-501 — user list/create/patch (incl. `is_active`, last-admin guard, audit) ✅ shipped; taxonomy CRUD and the dedicated deactivate endpoint + BR-4 open-ticket check are planned |
| 7 | 4,5,6 | Requests core: drafts, submit (REQ- numbering), list/detail with visibility + pagination + search, transitions via state machine, optimistic locking | ST-201,202,203,204,302,303,304 ✅ shipped (149 integration tests + the 76-call live walk; events read API included) |
| 8 | 7 | Comments (public/internal) + activity history read API | ST-205, FR-13 ✅ shipped — comment thread with length/empty validation and BR-8 closure flag, staff-only visibility rule, merged timeline (events + comments), in-transaction audit, provenance frozen by migration 017, and an FE page (`/requests/:id/activity`) that renders bodies as text only; the read API of Phase 14 is still open |
| 9 | 7 | SLA trackers on submit, policy CRUD, sweep job (warning/breach flags), pause/resume accounting | ST-401b,402,403 — policy read/update API + manager-only RBAC + audit sink + FE page ✅ shipped; tracker create/advance now happens inside the request transactions (Phase 7 shipped), so only the scheduled sweep job remains |
| 10 | 7,9 | Auto-close job + draft expiry + orphan attachment purge | ST-404 |
| 11 | 7 | Attachments upload/download with magic-byte validation | ST-201 |
| 12 | 5 | Notifications table/API + fan-out hooks + FE bell (poll) | ST-601 |
| 13 | 7,9 | Analytics SQL services + dashboard endpoints | ST-602,603 |
| 14 | 1,5 | Audit log writes across modules + read API | ST-502 — writes ✅ shipped (in-transaction `AuditWrite` for request/comment changes, best-effort sink elsewhere, secrets redacted, migration 017 makes the history append-only); the `GET /audit-logs` read API is planned and its absence is captured, not asserted (api-spec §12) |
| 15 | 5 | FE shell: router, auth context, axios-style client w/ refresh interceptor, layout, role guards | ST-101,102 — router/layout/typed client/query layer ✅ shipped (dashboard, lifecycle simulator, policy admin); auth context + role guards are the remaining FE work now that the API's JWT gate is live |
| 16 | 7,8,12 | FE employee portal: create/draft/list/detail/cancel/reopen/comment | ST-201–206 — the comment thread, the post form and the activity timeline are shipped on `/requests/:id/activity`; create/list/detail flows remain planned |
| 17 | 7,8,9 | FE agent workspace: queue (filters in URL, SLA colors), claim, transitions, assign/reassign | ST-301–304 |
| 18 | 6,9,13,14 | FE admin: users, taxonomy, SLA policy, audit, notifications surfaces | ST-105,501,502 |
| 19 | 13 | FE analytics dashboards + CSV | ST-602,603 |
| 20 | all | Hardening pass: rate limits, security headers, a11y audit, error states, empty states, load smoke (autocannon 200 VU), runbook | ST-701,703 |
| 21 | 20 | Production compose (multi-stage builds, nginx, env template), README with demo accounts, screenshots | ST-701 |

> **Mentor note:** each phase ends with green CI + a demoable slice. Do not batch phases; the
> dependency graph only permits the arrows shown. Phase 4 is intentionally test-heavy because
> SLA/lifecycle bugs are the costliest (requirements §15).

> **Scaffold status (this repository):** phases 0–5, requests core (7), comments and the activity timeline
> (8) and the SLA-policy slice of 9/15
> are implemented; `evidence/` holds the lint/typecheck/test/build output, the live API responses and the
> 76-call request lifecycle walk that justify those ✅ marks. Neither placeholder mentioned here before is
> one now: `/sla` and `/requests` sit behind the **real JWT gate** (which still fails closed — anonymous
> 401, wrong role 403, out-of-scope row 404 — and adds the forced-password-change gate), and the Postgres
> adapters are exercised against a live server: `npm run db:up && npm run db:migrate && npm run db:seed &&
> npm run dev && npm run e2e:requests` drives them with five seeded identities and asserts a status for
> every call. What remains planned is taxonomy, attachments, notifications, analytics, the audit
> read API and the scheduled SLA sweep.

## 12. Key architectural decisions (summary — rationale in ADRs)

1. Modular monolith, not microservices (ADR-002 planned).
2. npm workspaces monorepo with a `shared` contract package (ADR-003 planned).
3. JWT access (15 min, memory) + rotating refresh cookie — rationale in security-plan §3.
4. Business-hours SLA as pure-function domain module with injectable clock.
5. Optimistic concurrency on requests; single `transitionRequest` chokepoint.
6. Local-disk attachment storage behind an interface (swap to S3 later without domain changes).
