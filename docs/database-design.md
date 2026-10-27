# ESRS — Database Design (PostgreSQL 16)

Source of truth for schema. Applied via **node-pg-migrate** from the `@esrs/database` package
(`database/migrations/`, numbered `NNN_name.sql`, run with `npm run db:migrate`). Every migration
must be reversible (`-- Down Migration`) unless justified in a comment.
Docs ↔ migrations drift is a review-blocker.

Conventions: `snake_case`; PK `id BIGINT GENERATED ALWAYS AS IDENTITY`; timestamps
`TIMESTAMPTZ` default `now()`; soft delete = `is_active`/`deleted_at` only where stated;
enum types = native `CREATE TYPE … AS ENUM` (values frozen in `shared` package);
FKs indexed; audit columns `created_at`/`updated_at` on mutable tables.

---

## 1. Entity overview (ER, logical)

```
departments ──< users >── role_teams(=agent team via category)          categories ──< sub_categories
                 │  ▲                                                   ▲              ▲
 requesters ─────┘  └── assignees (users)                               │              │
                          ┌─────────────────────────────────────────────┴──────────────┘
                          │
request_numbers ──< requests >──┬── request_attachments >── attachments
                          │     ├── comments (public/internal)
      sla_policies ──< sla_trackers   ├── request_events (activity history)
                          │           ├── assignments (history)
                          │           └── notifications
                          └──< requests (self: reopened_from)
refresh_token_families   login_attempts   audit_logs   app_settings
```

## 2. Core tables (DDL intent, not literal migration code)

### 2.1 users
```sql
CREATE TYPE user_role AS ENUM ('employee','agent','manager','admin');

CREATE TABLE users (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email               TEXT UNIQUE NOT NULL,          -- uniqueness re: case handled by LOWER() index below
  password_hash       TEXT NOT NULL,                    -- bcrypt cost 12
  full_name           TEXT NOT NULL,
  role                user_role NOT NULL DEFAULT 'employee',
  department_id       BIGINT REFERENCES departments(id),
  team_category_id    BIGINT REFERENCES categories(id), -- agent/manager scoping (ST-301); NULL for employee/admin
  is_active           BOOLEAN NOT NULL DEFAULT true,
  must_change_password BOOLEAN NOT NULL DEFAULT false,  -- ST-104
  failed_login_count  INT  NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,                      -- ST-103
  last_login_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_team ON users(team_category_id) WHERE role IN ('agent','manager');
```
*Note:* emails are normalized to lowercase in the app layer (`normalizeEmail`) and protected by
`CREATE UNIQUE INDEX uq_users_email_lower ON users (LOWER(email))`. `citext` was considered and
rejected to keep the column type portable and the normalization rule explicit in code.

### 2.2 departments / categories / sub_categories
```sql
CREATE TABLE departments (id PK, name TEXT UNIQUE NOT NULL, is_active BOOL DEFAULT true, …);

CREATE TABLE categories (
  id PK, code TEXT UNIQUE NOT NULL,          -- 'IT' | 'HR' | 'FAC'
  name TEXT NOT NULL,
  team_label TEXT NOT NULL,                  -- 'IT Support'…
  is_active BOOL NOT NULL DEFAULT true       -- ST-501 soft deactivate
);
CREATE TABLE sub_categories (
  id PK, category_id FK NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL, is_active BOOL DEFAULT true,
  UNIQUE (category_id, name)
);
```
Seed (idempotent): IT — *Hardware, Software, Network & VPN, Email & Access, Peripherals*;
HR — *Onboarding, Leave & Attendance, Payroll & Benefits, Employment Letter, Policy Query*;
Facilities — *Workspace & Seating, Cleaning, Electrical, Security Access, Books & Supplies*.

### 2.3 requests (the aggregate root)
```sql
CREATE TYPE request_status AS ENUM
 ('draft','submitted','assigned','in_progress','on_hold','resolved','closed','cancelled');
CREATE TYPE request_priority AS ENUM ('low','medium','high','critical');

CREATE TABLE requests (
  id              BIGINT PK,
  request_number  TEXT UNIQUE NOT NULL,        -- 'REQ-2026-000123' (assigned on submit, §5)
  requester_id    BIGINT NOT NULL REFERENCES users(id),
  assignee_id     BIGINT REFERENCES users(id),
  category_id     BIGINT NOT NULL REFERENCES categories(id),
  sub_category_id BIGINT REFERENCES sub_categories(id),
  department_id   BIGINT REFERENCES departments(id),   -- snapshot of requester dept
  title           TEXT CHECK (char_length(title) >= 5),
  description     TEXT CHECK (char_length(description) >= 20),
  status          request_status NOT NULL DEFAULT 'draft',
  priority        request_priority NOT NULL,
  status_reason   TEXT,                          -- reason for latest transition (BR-5)
  resolution_note TEXT,                          -- required on resolve (ST-303)
  submitted_at    TIMESTAMPTZ,                   -- SLA clock start; NULL while draft
  resolved_at     TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  reopen_count    INT NOT NULL DEFAULT 0,
  reopened_from   BIGINT REFERENCES requests(id),-- self link when reopened
  requester_inactive BOOLEAN NOT NULL DEFAULT false, -- edge §16.1
  version         INT NOT NULL DEFAULT 0,        -- optimistic concurrency
  created_at / updated_at TIMESTAMPTZ …,
  CONSTRAINT valid_dates CHECK (resolved_at <= closed_at),  -- nulls pass
  CONSTRAINT no_negative CHECK (reopen_count >= 0)
);
CREATE INDEX idx_requests_queue ON requests(category_id, status, priority)
  WHERE status NOT IN ('draft','closed','cancelled');
CREATE INDEX idx_requests_requester ON requests(requester_id) WHERE status <> 'draft';
CREATE INDEX idx_requests_assignee  ON requests(assignee_id)  WHERE status IN ('assigned','in_progress','on_hold');
-- Full text search lives in a generated column rather than an expression index, so the indexed
-- text is queryable/inspectable and the index definition stays trivial:
--   search_text tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(description,''))) STORED
CREATE INDEX idx_requests_search    ON requests USING gin (search_text);
```
**State invariants enforced in app (single `transitionRequest`), not DB triggers** — DB keeps only
cheap CHECKs + FKs; the state machine is the authority (domain testable without DB).

### 2.4 request_numbers (gapless human ID generator)
```sql
CREATE TABLE request_numbers (
  year     INT PRIMARY KEY,
  last_seq BIGINT NOT NULL DEFAULT 0
);
-- On submit: INSERT INTO request_numbers (year, last_seq) VALUES ($1, 1)
--            ON CONFLICT (year) DO UPDATE SET last_seq = last_seq + 1 RETURNING last_seq
-- inside the submission transaction → unique sequential number per year under concurrency.
-- `last_seq` is the sequence already handed out, so the row is seeded with 1 rather than left to the
-- column default: the first ticket of a fresh year is REQ-{YYYY}-000001.
```

### 2.5 assignments (audit of who held the ticket)
```sql
CREATE TABLE assignments (
  id PK, request_id FK, agent_id FK REFERENCES users(id),
  assigned_by FK users, assigned_at TIMESTAMPTZ DEFAULT now(),
  unassigned_at TIMESTAMPTZ,                     -- NULL = current
  reason TEXT                                    -- 'claim'|'manager_assign'|'reassign'|'reopened'
);
CREATE INDEX idx_assignments_open ON assignments(request_id) WHERE unassigned_at IS NULL;
```

### 2.6 comments
```sql
CREATE TYPE comment_visibility AS ENUM ('public','internal');
CREATE TABLE comments (
  id PK, request_id FK CASCADE, author_id FK users,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  visibility comment_visibility NOT NULL DEFAULT 'public',
  is_post_closure BOOL NOT NULL DEFAULT false,   -- BR-8
  created_at / updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_comments_request ON comments(request_id, created_at);
```

| Fact | Where it is nailed down |
|---|---|
| 1–5000 characters, never blank | `comments_body_check` **and** `commentBodySchema` (`COMMENT_BODY_MIN/MAX` in `@esrs/shared`), which trims before it measures. A payload the API accepts cannot be rejected by the table, and `'   '` fails instead of being stored as content |
| author and instant | stamped by `RequestActivityService` from the verified identity and the injected clock. The POST schema is `.strict()`, so `author_id`/`created_at` cannot be smuggled in; migration 017 then freezes them at row level (§8) |
| BR-8 post-closure flag | derived, never supplied — `true` when the request was already `resolved`/`closed`/`cancelled` at the moment of posting |
| internal notes | `visibility='internal'` — **filtered in the SQL of every read path**: `listComments` and `timeline` drop the rows, and `events` drops the `comment_added` *marker* of an internal note, because a marker discloses that the note exists and how long it was. `page_size`, `total` and the payload therefore all describe the same already-authorised set |

A comment is content; the audit row that announces it is evidence. `comment.added` stores
`{request_id, request_number, author_id, visibility, characters, is_post_closure}` — the *length* of the
text, never the text.

### 2.7 request_events (activity history, append-only)
```sql
CREATE TYPE event_type AS ENUM
 ('created','submitted','assigned','claimed','unassigned','reassigned','started',
  'placed_on_hold','resumed','resolved','reopened','closed','cancelled',
  'priority_changed','comment_added','attachment_added');

CREATE TABLE request_events (
  id PK, request_id FK CASCADE,
  actor_id FK users, actor_role user_role NOT NULL,   -- snapshot (role may change later)
  event_type event_type NOT NULL,
  from_status request_status, to_status request_status,
  detail JSONB NOT NULL DEFAULT '{}',                 -- {priority_from,…}, {note_id},…
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_request ON request_events(request_id, created_at);
-- Append-only since 017: a BEFORE UPDATE/DELETE trigger raises SQLSTATE 42501, and a deployment that
-- defines the `esrs_app` role gets INSERT/SELECT only. §8 states what that does and does not guarantee.
```

`comment_added` rows are written in the same transaction as the comment they announce and carry a
summary — `{comment_id, visibility, characters, is_post_closure}` — never the body.
`GET /requests/{id}/timeline` (api-spec §7.3) drops those markers from this table and unions the real
`comments` rows in their place, so a comment appears once, with its text, visibility-filtered. The plain
event feed (api-spec §6.4) keeps the marker of every comment the reader may see and hides the marker of
an internal note from anyone below `agent` — the same predicate as the thread, applied to the metadata
instead of to the content, so no read path lets a staff-only note announce itself to its subject.

### 2.8 sla_policies & sla_trackers
```sql
CREATE TABLE sla_policies (                    -- ST-403, manager-editable
  id PK, priority request_priority UNIQUE NOT NULL,
  first_response_mins INT CHECK (first_response_mins > 0),
  resolution_mins INT CHECK (resolution_mins > first_response_mins),
  business_hours JSONB NOT NULL DEFAULT '{"days":[1..5],"start":"09:00","end":"18:00","timezone":"Asia/Kolkata"}',
  updated_by FK users, updated_at …
);
-- Column names are `*_mins` in SQL and `*_minutes` on the wire; `sla.repository.pg.ts` maps between
-- them. The `timezone` key is the one `businessHoursSchema` in @esrs/shared parses.
CREATE TABLE sla_trackers (                    -- one per submission (snapshot, edge §16.6)
  id PK, request_id FK UNIQUE,
  policy_snapshot JSONB NOT NULL,              -- {first_response_mins, resolution_mins, business_hours}
  submitted_at TIMESTAMPTZ NOT NULL,
  first_response_due_at TIMESTAMPTZ,           -- business-hours computed
  resolution_due_at  TIMESTAMPTZ,
  first_response_met_at TIMESTAMPTZ,           -- first agent action stamps it
  paused_intervals JSONB NOT NULL DEFAULT '[]' -- [{start,end}] business-time segments
  warned_at TIMESTAMPTZ, breached_at TIMESTAMPTZ,
  breached BOOL NOT NULL DEFAULT false,
  completion_status TEXT CHECK (completion_status IN ('met','breached')) -- set at resolve
);
CREATE INDEX idx_trackers_open ON sla_trackers(breached, resolution_due_at)
  WHERE breached IS FALSE;  -- partial for sweep efficiency (sweep scans eligible)
```
**Why JSONB snapshot:** policy edits must never mutate outstanding due dates (edge §16.6);
segments list keeps pause math auditable and recomputable.

### 2.9 attachments & request_attachments
```sql
CREATE TABLE attachments (
  id UUID PK DEFAULT gen_random_uuid(),
  uploaded_by FK users, file_name TEXT, stored_path TEXT UNIQUE NOT NULL,
  size_bytes BIGINT CHECK (size_bytes <= 10485760),
  mime_type TEXT, magic_type TEXT,               -- file-type detected (edge §16.9)
  status TEXT CHECK (status IN ('pending','bound','purged')) DEFAULT 'pending',
  created_at …
);
CREATE TABLE request_attachments (
  request_id FK CASCADE, attachment_id FK UNIQUE, added_by FK, added_at DEFAULT now()
);
```

### 2.10 notifications
```sql
CREATE TYPE notification_type AS ENUM
 ('request_status_changed','request_assigned','request_commented',
  'sla_warning','sla_breach','auto_close_warning','auto_closed','request_reopened');

CREATE TABLE notifications (
  id PK, user_id FK CASCADE, type notification_type NOT NULL,
  request_id FK, payload JSONB NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL DEFAULT '',           -- event/job run id (or '' for user-triggered events)
  read_at TIMESTAMPTZ, created_at …,
  UNIQUE (user_id, type, request_id, dedupe_key)     -- §16.16 fan-out dedupe
);
CREATE INDEX idx_notif_unread ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;
```
`dedupe_key` = scheduler run id / event id; job re-runs stay idempotent.

### 2.11 auth security tables
```sql
CREATE TABLE refresh_token_families (
  id UUID PK, user_id FK, family_id UUID NOT NULL,  -- rotation chain id
  token_hash TEXT NOT NULL,                          -- sha256(raw), never raw
  parent_token_hash TEXT,                            -- rotation lineage
  replaced_by TEXT, revoked_reason TEXT,
  expires_at TIMESTAMPTZ NOT NULL, created_at …,
  UNIQUE (family_id, token_hash)
);
CREATE INDEX idx_rtf_user ON refresh_token_families(user_id) WHERE revoked_reason IS NULL;

CREATE TABLE login_attempts (
  id PK, email_lf TEXT, ip INET, success BOOL, attempted_at DEFAULT now()
);                                              -- source for lockout counting + audit
CREATE INDEX idx_la_recent ON login_attempts(email_lf, attempted_at DESC);
```

### 2.12 audit_logs (admin/security actions — separate from request history)
```sql
CREATE TABLE audit_logs (
  id PK, actor_id FK users, actor_role user_role, actor_ip INET,
  http_request_id TEXT,          -- x-request-id: the audit row traces to one API call
  request_id BIGINT FK requests  -- the audited ticket; SET NULL, so the trail outlives the row
           ON DELETE SET NULL,
  action TEXT NOT NULL,          -- 'user.created','role.changed','comment.added',…
  entity_type TEXT, entity_id TEXT,
  before JSONB, after JSONB, created_at …
);
CREATE INDEX idx_audit_http_request ON audit_logs(http_request_id) WHERE http_request_id IS NOT NULL;
CREATE INDEX idx_audit_service_request ON audit_logs(request_id) WHERE request_id IS NOT NULL;
```
Migration 015 split what used to be one ambiguous `request_id TEXT` into these two columns: the
correlation string keeps its old index, and the service-request reference became a real FK. It is
`SET NULL` and never `CASCADE` — deleting a ticket must not delete the evidence about it, and the
append-only trigger means a cascaded `DELETE` could not have written the trail's own rows anyway (§8).
`actor_role` is the role at the moment of the action, and `actor_id` is NULL for anonymous/system
actions; both are filled from the entry the caller supplies, whether it arrives through the sink or
through a transactional write.

**Two write paths, one statement.** Both funnel through `INSERT_AUDIT_SQL`
(`backend/src/db/audit.sql.ts`), so they cannot drift into recording different things:

| Path | Used by | Guarantee |
|---|---|---|
| `AuditWrite` closure handed to a repository write | request aggregate (create, submit, patch, every lifecycle action, assignment), comments, SLA policy edits | the INSERT runs on the *same* transaction's client: a failed audit row rolls the business write back, and a committed change can never be missing from the trail |
| `AuditSink.record()` | auth/security events | best-effort and never throws — an audit outage must not turn a completed login into a 500 |

Actions recorded today: `request.created`, `request.submitted`, `request.updated`, `request.<action>`
for every lifecycle move (`claim`, `assign`, `start`, `hold`, `resume`, `resolve`, `close`, `reopen`,
`cancel`, `escalate`), `request.assigned` (the assignment side-effect, carrying
`assignee_open_tickets_before`), `comment.added`, `sla_policy.updated`, `user.created`, `user.updated`,
`role.changed`, `auth.login.success`, `auth.login.failed`, `auth.login.blocked`, `auth.logout`,
`auth.refresh.reuse_detected`, `password.changed`.

`entity_id` names the row that changed and `request_id` the ticket it belongs to — a comment is its own
entity, so its audit entry points at the *parent* request. `before`/`after` are the field images the
service had already read and the patch it asked for; a rejected write never reaches the table at all.

**Nothing sensitive is stored.** `withRedaction()` walks both images and replaces the value of any key
whose words hit `SENSITIVE_TOKENS` (`password`, `passwd`, `pwd`, `secret`, `token`, `authorization`,
`cookie`, `credential(s)`, `apikey`/`api_key`, `accesskey`, `privatekey`, `session`, `salt`, `hash`,
`otp`, `totp`, `mfa`, `jwt`, `bearer`, `refresh`) with `'[redacted]'`, collapses structures deeper than
`AUDIT_MAX_DEPTH` (6) or self-referential, clips strings over `AUDIT_VALUE_MAX` (512) with an explicit
`…[truncated]` marker, and renders non-JSON values as strings so serialising cannot throw. Key names are
split on separators *and* camel-case boundaries, so `api_key`, `apiKey` and `newPassword` are all caught
while ordinary fields such as `author` or `bypass` survive untouched. A password, an access token and a
comment body therefore never reach `audit_logs`.

### 2.13 app_settings (single-row-per-key config)
```sql
CREATE TABLE app_settings (
  key TEXT PK, value JSONB NOT NULL, updated_by FK, updated_at …
);
-- keys: reopen_days=7, auto_close_business_days=5, auto_close_warning_days=3,
--       draft_expiry_days=90, attachment_max_mb=10, business_hours (default)
```

## 3. Migration plan (node-pg-migrate, order = Phase 2)

Files live in `database/migrations/` and are plain SQL (`NNN_name.sql`) with the node-pg-migrate
legacy markers `-- Up Migration` / `-- Down Migration`, so the schema is reviewable and the runner
needs no TypeScript toolchain at migrate time. Seeds are *not* migrations: they live in
`database/seeds/` and are applied by `npm run db:seed`.

| # | Migration (as shipped) | Contents |
|---|---|---|
| 001 | `001_extensions.sql` | `pgcrypto`(gen_random_uuid), `pg_trgm` (fuzzy search later), `btree_gin` optional |
| 002 | `002_enums.sql` | all `CREATE TYPE` above — parity with `@esrs/shared` is asserted by `database/test/enumParity.test.ts` |
| 003 | `003_departments.sql` | |
| 004 | `004_categories_sub_categories.sql` | teams/taxonomy first: `users.team_category_id` FKs `categories`, so this must precede users |
| 005 | `005_users.sql` | + indexes |
| 006 | `006_request_numbers.sql` | |
| 007 | `007_requests.sql` | + indexes, CHECKs, generated `search_text tsvector` (GIN index) |
| 008 | `008_assignments.sql` | |
| 009 | `009_comments_request_events.sql` | |
| 010 | `010_sla_policies_trackers.sql` | sla_policies (+ the four contract default rows), sla_trackers |
| 011 | `011_attachments.sql` | attachments, request_attachments |
| 012 | `012_notifications.sql` | |
| 013 | `013_auth_security.sql` | refresh_token_families, login_attempts |
| 014 | `014_audit_logs_app_settings.sql` | audit_logs, app_settings (+ seed defaults) |
| 015 | `015_schema_alignment_columns.sql` | the columns the API had grown that the first cut of the schema lacked |
| 016 | `016_refresh_rotation_timestamp.sql` | `replaced_at` on refresh_token_families (rotation lineage) |
| 017 | `017_history_immutability.sql` | append-only triggers on audit_logs + request_events, comment provenance trigger, least-privilege grants when `esrs_app` exists (§8) |
| — | `seeds/001_reference_data.sql` | departments, categories, sub-categories, app settings |
| — | `seeds/002_demo_data.sql` | demo users/taxonomy/sample requests; guarded by `app.current_environment='demo'`, demo password hash injected at run time |

Rules: no destructive change without a written data-migration plan; add-column-not-null needs
default or backfill step; every up step gets a matching down step; numbering is monotone and
never re-used (the runner records file names in the `pgmigrations` table).

## 4. Constraints & integrity summary

| Rule | Where enforced |
|---|---|
| Lifecycle legality | domain state machine (app) + `version` optimistic lock |
| Priority change needs reason | service (app) + `status_reason NOT NULL` when status changed via API |
| Title/description length | DB CHECK + zod schema (both) |
| Comment length / non-blank | DB CHECK + zod schema (both) |
| Comment author & instant are real | service stamps them, `.strict()` schema rejects smuggling, 017 trigger freezes them |
| Attachment size/type | app (magic bytes) + DB CHECK size |
| One tracker per request | DB UNIQUE(request_id) |
| Team visibility | service query constraint (`team_category_id` = request.category) |
| Last admin protected | service transaction (count check + row lock) |
| Append-only history/audit | migration 017: BEFORE UPDATE/DELETE triggers (SQLSTATE 42501) on `audit_logs` and `request_events`, provenance trigger on `comments`, and privilege grants where `esrs_app` exists — see §8 for the limits |

## 5. ID & numbering

- Internal PK: BIGINT identity (join-heavy, compact). Exposed to API as opaque string.
- Public ticket: `REQ-{YYYY}-{seq:06d}` from `request_numbers` counter (per-year, transactional).
- Attachment IDs: UUIDv4 (unguessable in URLs; still authorization-checked).

## 6. Indexing & query notes

Primary access paths (from API spec §4–§8): queue filters (`category,status,priority` partial
index), my-requests (`requester_id`), assignee workload (partial on open statuses), unread
notifications (partial), tracker sweep (partial on `breached=false`), full-text search
(gin tsvector; MVP prefix fallback via `ILIKE` with escaped wildcards on title).
`pg_stat_statements` enabled in dev compose for slow-query work (Phase 20).

## 7. Backup / restore (operational)

`pg_dump -Fc` nightly via cron into a mounted volume; restore drill documented in README runbook;
demo seed is idempotent so restore + seed = working demo. Retention: 7 daily / 4 weekly.

## 8. History immutability — what migration 017 guarantees, and what it does not

Three tiers, strongest first.

| Tier | Mechanism | Holds when |
|---|---|---|
| 1 | `REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs, request_events FROM esrs_app` (+ `REVOKE DELETE ON comments`) | the deployment defines a separate application role. PostgreSQL refuses the statement before any code runs and the session cannot switch it off |
| 2 | `forbid_history_mutation()` — a BEFORE UPDATE/DELETE trigger on `audit_logs` and `request_events` raising SQLSTATE `42501` | any role, including the schema owner. **This is the tier that actually protects the development database** |
| 3 | `preserve_comment_provenance()` — a BEFORE UPDATE trigger on `comments` freezing `id`, `request_id`, `author_id`, `created_at`, `is_post_closure` | always, for the columns listed; `body` and `visibility` stay correctable on purpose |

Both guard functions honour one documented escape hatch,
`SET LOCAL esrs.allow_history_mutation = 'on'`, for maintenance (retention purge, erasure) and for the
foreign-key cascade below. No application code path issues `SET`, and the setting is transaction-scoped.
`database/scripts/verify.mjs` asserts every tier live: an audit UPDATE and DELETE, an event actor swap
and delete, a comment author swap and back-date are all refused, and the final check proves the hatch
does not survive its own transaction.

**Honest limitations.**

- **The development database is single-owner.** `docker-compose.yml` defines one role, `esrs`, which owns
  the schema, so the `REVOKE … FROM esrs_app` block is a guarded no-op (`IF EXISTS`) there. Tier 1 is
  real only in a deployment that creates `esrs_app` and points `DATABASE_URL` at it; today the guarantee
  rests on tier 2 alone.
- **A row trigger cannot stop `TRUNCATE`.** Triggers do not fire for TRUNCATE, and the schema owner can
  always `DROP TRIGGER`/`DROP TABLE`. Tier 2 protects against application bugs and ordinary SQL, not
  against a DBA. If tamper-evidence has to survive a determined insider, the answer is shipping the
  table to WORM storage or an external append-only log — not more triggers in this schema.
- **`ON DELETE CASCADE` still reaches `request_events` and `comments`.** Deleting a request deletes its
  history, which is why the cascade needs the escape hatch at all. A `RESTRICT` policy would be
  stronger; that is *not* what the schema does today, because deleting a request is a legitimate
  demo-data reset.
- **Rows are immutable, not provable.** There is no hash chain, signature or external receipt, so a
  holder of tier-2 bypass could drop a table's contents without leaving evidence inside the database.
- **Ids and roles are silently NULL when they do not fit.** `actor_id` and `request_id` are BIGINT
  columns, so a non-numeric subject (an `anonymous` login attempt, a test JWT subject) and
  `sla_policy.updated`'s `entity_id` of `'high'` bind NULL into them; `actor_role` becomes NULL if it is
  outside the `user_role` enum. The action, entity and payloads survive — the link to a row that does
  not exist as an id does not.
- **Two clocks.** In-transaction audit rows carry the injected application clock; best-effort security
  rows fall back to `COALESCE($10, now())`, the database clock. Ordering is only guaranteed within one
  request's own writes, so the timeline tie-break (instant, then source, then id) is deterministic per
  ticket but cannot prove causality across two API calls.
- **No retention job exists.** Nothing deletes or archives audit rows today, so `audit_logs` and
  `request_events` grow without bound; the 7-daily/4-weekly retention plan in §7 covers dumps of the
  whole cluster, not this table's lifecycle.
- **No read endpoint for audit data.** `GET /audit-logs` (api-spec §12) is still unimplemented, so
  administrators cannot currently query what is guaranteed to be there — the trail is written and
  frozen, but only inspectable with SQL.

## 9. Deferred / rejected design options

- **Normalization of events into many tables** → rejected: single typed `request_events` + JSONB detail is simpler and immutable.
- **STS temporary SLA columns on requests** → rejected: separate `sla_trackers` keeps aggregate lean and policy snapshotting explicit.
- **SELECT FOR UPDATE everywhere** → rejected in favor of optimistic `version` (lower contention, clearer 409 contract).
- **Schema-per-feature (multi-tenancy)** → rejected (no requirement).
- **CQRS read models** → deferred; MVP analytics are indexed aggregate queries over the same tables.
