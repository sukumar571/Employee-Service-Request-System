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
-- On submit: INSERT … ON CONFLICT (year) DO UPDATE SET last_seq = last_seq + 1 RETURNING last_seq
-- inside the submission transaction → unique sequential number per year under concurrency.
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
  created_at …
);
```
Internal comments: `visibility='internal'` — **filtered in SQL of every read path**, not just API layer.

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
-- No UPDATE/DELETE grants at app level (append-only; revoke in DB role for prod hardening).
```

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
  request_id TEXT,               -- x-request-id, so an audit row traces to one API call
  action TEXT NOT NULL,          -- 'user.created','role.changed','sla_policy.updated',…
  entity_type TEXT, entity_id TEXT,
  before JSONB, after JSONB, created_at …
);
CREATE INDEX idx_audit_request ON audit_logs(request_id) WHERE request_id IS NOT NULL;
```
`actor_role` and `request_id` are filled by `PostgresAuditSink`, which is the same sink the SLA
service writes through — so "who changed what, under which request" is one query.

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
| Attachment size/type | app (magic bytes) + DB CHECK size |
| One tracker per request | DB UNIQUE(request_id) |
| Team visibility | service query constraint (`team_category_id` = request.category) |
| Last admin protected | service transaction (count check + row lock) |
| Append-only history/audit | app-level (no update/delete routes) + optional DB privilege revoke |

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

## 8. Deferred / rejected design options

- **Normalization of events into many tables** → rejected: single typed `request_events` + JSONB detail is simpler and immutable.
- **STS temporary SLA columns on requests** → rejected: separate `sla_trackers` keeps aggregate lean and policy snapshotting explicit.
- **SELECT FOR UPDATE everywhere** → rejected in favor of optimistic `version` (lower contention, clearer 409 contract).
- **Schema-per-feature (multi-tenancy)** → rejected (no requirement).
- **CQRS read models** → deferred; MVP analytics are indexed aggregate queries over the same tables.
