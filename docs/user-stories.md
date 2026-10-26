# ESRS — User Stories

Companion to `docs/requirements.md` (traceability: **FR-n → ST-nnn**).
Format: *As a \<role\>, I want \<capability\>, so that \<benefit\>.*
Acceptance criteria use Given/When/Then. Points = relative effort (1/2/3/5/8; >8 must be split).

Status legend: ⬜ not started · 🔨 in phase (see implementation order in `system-architecture.md` §11)

---

## Epic 1 — Authentication & Accounts

### ST-101 Sign in 🔨 (FR-1, FR-2) — 3
As an employee, I want to sign in with my email and password, so that I can securely access my requests.
- **AC:** Valid credentials → access token + rotating refresh cookie, redirected per role.
- **AC:** Wrong password → generic "Invalid email or password" (no user enumeration).
- **AC:** Deactivated account → "Contact your administrator".

### ST-102 Stay signed in safely (FR-2) — 2
As a user, I want to stay logged in across browser restarts without storing tokens in JS-readable places.
- **AC:** Refresh happens transparently when the access token expires (one retry-on-401 interceptor).
- **AC:** Logout revokes the refresh token family; other devices unaffected.

### ST-103 Locked out after repeated failures (FR-5) — 2
As a security owner, I want brute-force logins throttled.
- **AC:** 5 failures → 15-min lock, lock state per email, neutral error shown.
- **AC:** Successful post-lock login resets counter.

### ST-104 Forced password change on first login (FR-4) — 2
As a new user created by an admin, I must change my initial password before using the portal.
- **AC:** `must_change_password=true` → only the change-password screen is reachable.
- **AC:** New password must pass Zod strength rules (≥ 12 chars, mixed classes).

### ST-105 Admin manages users (FR-4, BR-4) — 3
As an admin, I want to create, deactivate, and role-assign accounts.
- **AC:** Create user picks department + role; initial password set once, shown once.
- **AC:** Deactivating a user with open assigned tickets is blocked with a reassignment hint.
- **AC:** Cannot demote/deactivate the last active admin.

## Epic 2 — Request Creation (Employee)

### ST-201 Raise a service request (FR-6, FR-8, FR-20) — 5
As an employee, I want to submit an IT/HR/Facilities request with details and attachments, so that the right team can act on it.
- **AC:** Category → dependent sub-category select; priority chooser with SLA hints.
- **AC:** Submit → `REQ-YYYY-NNNNNN` ID, confirmation screen, appears in "My requests".
- **AC:** Validation: title ≥ 5, description ≥ 20, attachments ≤ 5 × 10 MB, allowed types (magic-byte verified).

### ST-202 Save a draft (FR-7) — 2
As an employee, I want to save partial requests and finish later.
- **AC:** Draft visible only to me; edit freely; submit when ready.
- **AC:** Drafts auto-persist form to server every blur-save; no data loss on refresh.

### ST-203 Track my requests (FR-10, FR-19) — 3
As an employee, I want a list + detail view with status, SLA state, and history.
- **AC:** List filterable by status/category; shows due-date countdown for open items.
- **AC:** Detail shows public comments only — internal notes never rendered (and absent from API payload).

### ST-204 Cancel a request (FR-10, BR-5) — 1
As a requester, I want to cancel while the work hasn't started.
- **AC:** Allowed from submitted/assigned with reason ≥ 10 chars; terminal; notification to assignee if assigned.

### ST-205 Comment on a request (FR-11) — 2
As a requester or agent, I want threaded communication on a ticket.
- **AC:** Public comment notifies the counterpart; internal note (agent+) visually distinct and hidden from requester.

### ST-206 Reopen a resolved request (FR-12) — 2
As a requester, if unresolved I want to reopen within 7 days.
- **AC:** Reopen requires reason; SLA tracker resumes; day 8+ → clear rejection message.

## Epic 3 — Agent Workspace

### ST-301 Team queue (FR-18, §7 scoping) — 5
As an agent, I want my team's open tickets sorted by SLA urgency.
- **AC:** Columns: ID, title, priority, status, remaining business time, assignee.
- **AC:** Row colors: safe / warning ≥ 75 % / breached; filters persist in URL.
- **AC:** IT agent sees zero HR/Facilities rows (API-enforced).

### ST-302 Claim a ticket (FR-9, edge §16.3) — 2
As an agent, I want to take unassigned tickets.
- **AC:** Claim is atomic; concurrent claim → 409 with "already assigned to X" and queue refresh.

### ST-303 Work a ticket (FR-9, FR-11) — 3
As an assigned agent, I want to move status (start/hold/resolve) with audit reasons.
- **AC:** Resolve requires resolution summary ≥ 20 chars; hold requires reason; every transition logs from→to.
- **AC:** Optimistic-lock (`version`) prevents acting on stale detail pages.

### ST-304 Manager assigns & reassigns (FR-9, BR-4) — 2
As a manager, I want to route tickets to the right agent.
- **AC:** Assignee picker lists only active agents of that request's team.
- **AC:** Reassignment notifies old + new assignee; history retains both.

## Epic 4 — SLA Engine

### ST-401 SLA clocking (FR-14, FR-15, AC-4 in requirements) — 8
As the system, I compute first-response/resolution due times in business hours, pausing on hold.
- **AC:** Unit: Fri 18:30 start + 4 h target → due Mon 13:00 (weekend excluded); Mon 10:00 + 24 business-h (high) → due Wed 16:00. Exact tables in test plan TC-SLA-01…07.
- **AC:** Pause/resume shifts due date by paused span only during business hours.
- **AC:** Recompute (priority change) never extends past original target duration — only remaps.

### ST-402 SLA alerts (FR-16) — 2
As an agent/manager, I get notified at 75 % and breach.
- **AC:** Scheduler every 5 min evaluates eligible trackers; notifications deduped per event.

### ST-403 SLA policy editing (FR-14, edge §16.6) — 2
As a manager, I can adjust targets per priority.
- **AC:** Change applies to new requests; existing trackers immutable; audit-logged.

### ST-404 Auto-close job (FR-12, BR-7) — 2
As the system, I close resolved requests after 5 business days of silence.
- **AC:** Actor = `system`; requester notified at day 3 (grace warning) and on close.

## Epic 5 — Administration

### ST-501 Departments & categories (FR-20) — 3
As an admin, I maintain org structure and request catalog.
- **AC:** Soft deactivate only for in-use records; new requests exclude them; open requests unaffected (edge §16.14).

### ST-502 Audit log (FR-21, NFR-4) — 2
As an admin, I review security- and state-relevant actions with filters (actor, action, period).
- **AC:** Append-only at app level (no update/delete endpoints); CSV export.

## Epic 6 — Notifications & Analytics

### ST-601 In-app notifications (FR-22) — 3
As a user, I see unread count and a list; click deep-links to the request.
- **AC:** Types: status change, assignment, SLA warning/breach, auto-close; mark read / mark all read.

### ST-602 Dashboards (FR-23, AC-7) — 5
As a manager, I see volume, SLA compliance %, MTTR, breach list, agent workload for a date range.
- **AC:** Figures reproducible by SQL reference queries in test plan.
- **AC:** Range presets 7/30/90 d + custom; empty state when no data.

### ST-603 CSV export (FR-24) — 1
As an admin, export current analytics table; row cap 10 000; UTF-8 BOM for Excel.

## Epic 7 — Non-functional stories

### ST-701 Deploy pipeline (NFR-7, AC-8) — 5
As a maintainer, `docker compose --profile demo up` gives a working, seeded demo at `http://localhost:8080`.

### ST-702 Quality gates (NFR-5) — 3
As a reviewer, every PR passes lint, typecheck, unit + integration tests, coverage threshold.

### ST-703 Accessibility & UX baseline — 2
As any employee, forms usable by keyboard, contrast AA on status badges, errors announced to screen readers (aria-live).

---

## Story → FR traceability index

| Story | FRs | Story | FRs |
|---|---|---|---|
| ST-101 | FR-1,2 | ST-401 | FR-14,15 |
| ST-102 | FR-2 | ST-402 | FR-16 |
| ST-103 | FR-5 | ST-403 | FR-14 |
| ST-104 | FR-4 | ST-404 | FR-12 |
| ST-105 | FR-4 | ST-501 | FR-20 |
| ST-201 | FR-6,8 | ST-502 | FR-21 |
| ST-202 | FR-7 | ST-601 | FR-22 |
| ST-203 | FR-10,19 | ST-602 | FR-23 |
| ST-204 | FR-10 | ST-603 | FR-24 |
| ST-205 | FR-11 | ST-701 | NFR-7 |
| ST-206 | FR-12 | ST-702 | NFR-5 |
| ST-301 | FR-18 | ST-703 | NFR-5 |
| ST-302 | FR-9 | | |
| ST-303 | FR-9,11,13 | | |
| ST-304 | FR-9,11 | | |

## Prioritization (MVP = Must + Should)

| MoSCoW | Stories |
|---|---|
| **Must** | 101–105, 201–206, 301–304, 401–404, 501, 502, 601, 701, 702 |
| **Should** | 602, 703 |
| **Could** | 603 |
| **Won't (MVP)** | email notifications, SSO, KB, auto-triage (§10 requirements) |

> ST-401 (8 pts) is the largest story — it is intentionally split in implementation into
> `clock math` (pure domain, Phase 4), `tracker persistence` (Phase 4), and `scheduler/alerts` (Phase 9).
