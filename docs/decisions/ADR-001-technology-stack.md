# ADR-001: Technology Stack

**Status:** Accepted
**Date:** 2026-10-25
**Deciders:** project author (builder), mentor (reviewer)
**Context tag:** ESRS MVP

---

## 1. Context

ESRS is an intermediate, real-world internship project: an internal portal where employees raise
IT/HR/Facilities service requests, agents work them under SLA targets, managers route and monitor,
and administrators manage the system. The stack must support a full professional lifecycle —
typed contracts, migrations, automated tests, containerized deployment — while remaining small
enough for one developer to own end-to-end and to reason about in review.

Non-negotiable input from the project brief: React + Vite + TypeScript + Tailwind on the front end;
Node.js + Express + TypeScript on the back end; PostgreSQL; JWT + bcrypt; Zod; node-pg-migrate;
Vitest / React Testing Library / Supertest; Docker + Docker Compose.

The decision recorded here is **how and why these technologies are arranged**, plus the boundary
choices the brief left open (monorepo layout, package manager, API style, state shape, testing
topology, job execution model).

## 2. Decision

### 2.1 Stack of record

| Concern | Choice | Version intent | Why this, in one line |
|---|---|---|---|
| Language | **TypeScript** (strict) everywhere | 5.x | One type system across contract, server, UI; Zod infers the types so there is a single source of truth |
| Frontend | **React + Vite** | React 19.3, Vite 8.3 (as built) | Fast HMR, zero-config TS, small production bundle; no Next.js because there is no SEO/SSR requirement |
| Styling | **Tailwind CSS** | 4.3 (`@tailwindcss/vite`, `@theme` tokens) | Design system via tokens (status/priority colors), no CSS-file drift, quick to keep AA-contrast consistent |
| Server state | **TanStack Query** | v5 | Caching, retries, invalidation, stale-while-revalidate for queues/dashboards without hand-rolled reducers |
| Forms | **React Hook Form** + `@hookform/resolvers/zod` | 7.91 / resolvers 5.9 | Uncontrolled inputs for performance; shares the exact `shared` schemas the API parses |
| Routing | **React Router** | v7 (declarative mode) | Route guards by role; deep links into `/requests/:id` from notifications |
| Backend runtime | **Node.js 22 LTS + Express 5** | node:22-alpine image | LTS baseline, ubiquitous in internships/job market, huge middleware ecosystem; Express 5 async handlers drop the `try/catch`-per-route noise |
| DB | **PostgreSQL 16** | 16-alpine | Native enums, JSONB (SLA snapshots, event details), partial indexes, `pg_trgm`/FTS for search, transactional integrity for the lifecycle aggregate |
| DB access | **`pg` (node-postgres)** with a thin repository layer | 8.x | No ORM: forces SQL literacy (a stated learning goal), keeps migrations authoritative, avoids ORM-driven N+1 surprises |
| Validation | **Zod** in a shared package | 4.6 | Same schema validates FE input and BE bodies/queries; error details map straight to the API error envelope |
| AuthN | **JWT access (15 min) + rotating refresh cookie**, **bcrypt** cost 12 | `jsonwebtoken`, `bcryptjs` | Brief-mandated; refresh rotation gives server-side revocation that pure JWT lacks (security-plan §3). `bcryptjs` is used by the seed script so hashing works without a native toolchain on every clone |
| Migrations | **node-pg-migrate** | 9.0 | Numbered, reversible, runs as a one-shot compose service before API boot; no schema sync magic. `.sql` files with `-- Up/Down Migration` markers keep the schema reviewable and remove a TS build step from migrate time |
| Testing | **Vitest** (unit/api/integration w/ Supertest), **React Testing Library**, **MSW**, **testcontainers**, **Playwright** (smoke only), **autocannon** | Vitest 5, RTL 16, Supertest 7 | Vitest shares config with Vite; RTL enforces user-centric queries; real Postgres in integration tests instead of SQLite emulation |
| Lint/format | ESLint (typed rules + import boundaries) + Prettier | ESLint 10 (flat config) / Prettier 3 | Enforces the architecture's dependency rules mechanically (architecture §2) |
| Logging | **pino** + AsyncLocalStorage request-id | 10.x | Structured JSON, cheap, correlates logs↔errors↔audit |
| Monorepo | **npm workspaces**: `shared`, `database`, `backend`, `frontend` | npm 11 (Node ≥ 22.12) | Zero extra tooling for an internship repo: one lockfile, `npm -w` scripts, shared package compiled before both apps. Package manager is pinned via `packageManager` |
| Containerization | **Docker multi-stage builds + Docker Compose** (`postgres`, `migrator`, `api`, `web`(nginx), `seed` under a `demo` profile) | Compose v2 | One-command reproducible environment (AC-8); nginx serves static + proxies `/api` so dev/prod share same-origin assumptions. As built, compose ships the two Postgres instances; app containers land in Phase 21 |
| CI | GitHub Actions: lint → typecheck → test → coverage gate → docker build | — | Mirrors local `npm run verify` so CI is never the first to catch it |

**As-built revisions (scaffold phase, 2026-10-25)** — recorded here rather than silently applied:

1. **Versions moved up** to the current stable lines while keeping the decision intact: React 19,
   Vite 8, Tailwind 4 (CSS-first `@theme`, no `tailwind.config.js`), Express 5, Zod 4,
   node-pg-migrate 9, ESLint 10. `npm ls` + `npm audit` are the check that nothing installed is
   marked deprecated.
2. **TypeScript stays on the 5.9 line** even though a newer major exists: `typescript-eslint@8`
   declares `typescript: >=4.8.4 <6.1.0`, and moving compiler majors is a separate decision with
   its own migration cost (revisit when the ecosystem peer range allows it).
3. **Package manager became npm workspaces** (root `package.json` → `workspaces`, pinned
   `packageManager: npm@11`) instead of pnpm, so a reviewer clones and runs `npm ci` with the
   toolchain they already have. The `shared`/`database`/`backend`/`frontend` package split, the
   single lockfile and "build shared first" property of the original decision are unchanged.
4. **`@hookform/resolvers` is pinned to ^5.9** — v6 conflicted with React Hook Form 7 in this
   dependency set, and a monorepo that cannot `npm ci` cleanly fails AC-8 (reproducible setup).

### 2.2 Architectural consequences of the choice (not in the brief, decided here)

1. **Modular monolith, not microservices.** One API deployable, one transaction boundary; the SLA
   lifecycle requires atomic multi-table writes (request + tracker + event + notification), which
   distributed transactions would make needlessly hard at this scale.
2. **HTTP API style: REST/JSON over `/api/v1`**, not GraphQL. The surface is a small, stable set of
   resources with rich permission rules; GraphQL's dataloader/complexity-budget machinery would be
   net negative for an MVP and complicates RBAC-per-resolver.
3. **Domain layer is framework-free** (`domain/` imports no express/pg/fs). State machine,
   business-hours math and RBAC are pure functions with an injectable `Clock`, which is what makes
   the SLA test suite (test-plan §1) deterministic and fast.
4. **Jobs run in-process** (node-cron + `pg_advisory_lock`) rather than a separate worker/queue
   service — consistent with assumption A-1 (single node, < 200 requests/month).
5. **Attachments on local volume behind a `Storage` interface** — swap to S3 later without touching
   domain/services (assumption A-4).

## 3. Alternatives considered

| Alternative | Why rejected for this MVP |
|---|---|
| **Next.js (App Router) full-stack** | SSR/routing model adds concepts beyond the learning objective; no SEO need for an intranet portal; API routes less natural for middleware-driven RBAC and Supertest integration testing |
| **NestJS** | DI/decorator framework hides the request lifecycle a learner benefits from seeing directly in Express; heavier ceremony per module |
| **Prisma / Drizzle ORM** | Direct conflict with the brief's node-pg-migrate requirement (Prisma migrate is schema-driven); ORM would shadow the SQL skills this project targets. Drizzle was the closest call — still adds a second schema source of truth alongside migrations |
| **MongoDB / SQLite** | Relational invariants (assignee must be active agent of that team; one tracker per request; audit trail) plus transactional multi-row writes favor Postgres; SQLite lacks `TIMESTAMPTZ`, enums, partial-index parity and JSONB used here |
| **Session cookies only (no JWT)** | Rejected by brief; noted trade-off: refresh-token rotation is what buys us revocation, so the JWT design keeps server-side state for refresh families |
| **OAuth/OIDC provider (Keycloak, Auth0)** | Strong production answer, but external identity infra is out of scope for an internship demo; documented as the upgrade path when SSO enters scope |
| **Kubernetes / PaaS deploy** | Single-host Compose satisfies NFR-2 for MVP scale; K8s adds operational surface disproportionate to the project |
| **Redux Toolkit for server data** | TanStack Query covers caching/invalidation with less boilerplate; Redux retained only if complex client-only state appears (not anticipated) |
| **Jest across the board** | Vitest reuses Vite config and transforms TS faster with less setup; brief permits "Jest or compatible" — Jest kept only as the API-compatibility reference |
| **Feature-flag/admin SDKs (LaunchDarkly, etc.)** | External paid dependency violates constraint §14; `app_settings` table covers the small config surface needed |

## 4. Consequences

**Positive**
- End-to-end type safety from DB row → API DTO → UI props, with one contract package to review in PRs.
- `docker compose up` reproduces the whole system, including migrations and demo data (AC-8), and
  is the same artifact reviewed in CI.
- Skill set is directly employable (React/TS/Express/Postgres/Docker/testing discipline).
- Testing pyramid is cheap to obey because domain logic is pure and the DB is real in integration tests.

**Negative / accepted costs**
- Hand-written SQL is more work than an ORM and puts query-review burden on the author (mitigated:
  repository layer, indexes enumerated in database-design §6, `statement_timeout` + slow-query log).
- Zod schemas in `shared` couple FE and BE release trains — handled by additive-only DTO evolution (api-spec §14).
- Single-process jobs mean horizontal scaling later requires extracting a worker (interface already isolated; documented in architecture §5).
- bcrypt at cost 12 dominates login latency (~200–300 ms) — accepted; rate limits and NFR-1 targets account for it (test-plan P-02).
- Local-disk attachments are lost if the volume is removed — mitigated by named volume + backup runbook; storage interface ready for S3.
- **Multi-role per user is out of scope** — if a person becomes both agent and admin, MVP forces a
  second account; revisit in ADR-004 if org grows (assumption A-3).

**Follow-up ADRs planned**
- ADR-002 Modular monolith & dependency boundaries (enforcement rules).
- ADR-003 npm-workspaces + shared contract package (build/type pipeline).
- ADR-004 Identity model: roles, agent-team scoping, multi-role future.
- ADR-005 SLA time accounting representation (segments vs recomputation).

## 5. Validation of this decision

The stack is considered validated when Phase 4 (domain tests), Phase 5 (auth integration tests),
Phase 7 (request lifecycle), Phase 13 (analytics oracle-SQL equality) and Phase 21 (compose
one-command demo) are green in CI. Any layer that cannot be tested as specified in `test-plan.md`
is grounds for reopening this ADR rather than silently working around it.
