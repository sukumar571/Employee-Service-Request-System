# ESRS — Requirements Specification

**Product:** Employee Service Request System (ESRS)
**Scope:** MVP (internship / real-world portfolio project)
**Status:** Draft v1.0 — supersede via PR only; changes must be reflected in `docs/user-stories.md` and `docs/system-architecture.md`.

---

## 1. Purpose & Vision

ESRS is an internal portal where employees raise service requests across **IT**, **HR**, and
**Facilities**, service agents work those requests under **SLA** targets, and administrators
manage users, categories, and monitor performance through analytics. The system replaces an
assumed ad-hoc process (email/verbal requests) with a traceable ticket lifecycle.

## 2. Stakeholders

| Stakeholder | Interest / Influence |
|---|---|
| **Employee** (requester) | Primary user; wants fast, transparent request submission and status visibility |
| **Service Agent** (IT/HR/Facilities) | Fulfills requests; needs queues, assignment, SLA countdown |
| **Service Desk Manager** | Assigns tickets, tunes SLA policies, owns breach escalations |
| **System Administrator** | Manages users, departments, categories, roles, audits the system |
| **Engineering / project mentor** | Reviews architecture, code quality, security posture |
| **Auditor (implicit)** | Needs tamper-evident history of status and assignment changes |

## 3. Personas & Roles

MVP enforces **exactly one role per user** (see ADR-001 consequences; multi-role deferred).

| Role | Summary |
|---|---|
| `employee` | Can create and manage own requests |
| `agent` | Works requests in team queues; can claim unassigned requests |
| `manager` | All agent abilities + assignment, SLA policy view, full visibility, analytics |
| `admin` | All manager abilities + user/department/category/role administration |

## 4. Functional Requirements

Numbering: `FR-n`. Priority: **M** must / **S** should / **C** could (MVP backlog = M+S).

### 4.1 Identity & Access
- **FR-1 (M)** Email + password authentication; passwords stored hashed (bcrypt, cost ≥ 12).
- **FR-2 (M)** JWT session: short-lived access token (15 min) + rotating refresh token in `httpOnly` cookie.
- **FR-3 (M)** Role-based authorization enforced server-side on every endpoint (RBAC matrix in §7).
- **FR-4 (M)** Admin can create users (invite-style: admin sets initial password, forced change on first login) and deactivate users. No public self-registration in MVP.
- **FR-5 (S)** Account lockout for 15 minutes after 5 consecutive failed logins.

### 4.2 Request lifecycle
- **FR-6 (M)** Employee creates a request: category (IT/HR/Facilities), sub-category, title, description, priority self-declaration (`low/medium/high/critical` — see §5 mapping), optional attachments (≤ 5 files, ≤ 10 MB each; pdf/png/jpg/docx/xlsx).
- **FR-7 (M)** Requests can be saved as **draft** and submitted later. Drafts are invisible to agents.
- **FR-8 (M)** On submission a request gets a unique human-readable ID (`REQ-YYYY-NNNNNN`), a **requester-declared priority**, and starts SLA tracking.
- **FR-9 (M)** Lifecycle states: `draft → submitted → assigned → in_progress → resolved → closed`, with side states `cancelled` (requester, before resolution) and `on_hold` (agent/manager). Invalid transitions rejected by a server-side state machine.
- **FR-10 (M)** Requester can cancel own request while `submitted|assigned`; can add comments and view full activity history.
- **FR-11 (M)** Agent/manager can transition status, assign/reassign (agent → agent), add **internal notes** (hidden from requester) and public comments.
- **FR-12 (M)** After `resolved`, requester confirms closure or raises **reopening** within 7 days; auto-close 5 business days after `resolved` if requester is silent. Reopened requests re-enter `assigned` keeping original SLA clock.
- **FR-13 (M)** Every status/assignment/priority change writes an **activity history** entry (actor, timestamp, from → to, optional reason).

### 4.3 SLA
- **FR-14 (M)** SLA targets per priority, business-hours based (Mon–Fri 09:00–18:00 IST): see §8. A manager-editable policy table drives targets.
- **FR-15 (M)** SLA clock **pauses** while a request is `on_hold` (waiting on requester/external dependency) and resumes on re-activation.
- **FR-16 (M)** Warning at 75 % elapsed and breach at 100 % → in-app notification to assigned agent + managers; breached requests flagged in queues.
- **FR-17 (S)** Requester- or agent-declared priority changes recompute remaining SLA time (target from creation, not retroactive reset).

### 4.4 Queues & search
- **FR-18 (M)** Agents/managers see team queues filtered by category, status, SLA state (safe / warning / breached), assignee; text search on title/description/ID.
- **FR-19 (M)** Employees see only their own requests and public comments.

### 4.5 Administration
- **FR-20 (M)** Admin CRUD for departments, categories, sub-categories (soft deactivation only — history stays intact).
- **FR-21 (M)** Admin views system-wide analytics and the audit log of admin actions.

### 4.6 Notifications & analytics
- **FR-22 (M)** In-app notifications (bell + list) for: status change on own request, assignment to agent, SLA warning/breach. (Email = out of scope, see §10.)
- **FR-23 (S)** Analytics for managers/admins: open/resolved per period, **SLA compliance %** (breach-free resolutions), **MTTR**, volume by category/priority, breach list, agent workload (open tickets per agent).
- **FR-24 (C)** CSV export of analytics tables.

## 5. Priority model (MVP assumption)

Requesters self-declare priority; agents may downgrade/upgrade with reason (audit-logged).
Priority maps directly to the SLA target on submission — no auto-triage in MVP (see §10).

| Declared priority | Example intent |
|---|---|
| `critical` | outage affecting many people / safety |
| `high` | blocker for one team |
| `medium` | needed soon, workaround exists |
| `low` | request / question |

## 6. Request lifecycle state machine

```
                 ┌────────────┐  cancel   ┌───────────┐
   create ─────▶ │    draft   │ ────────▶ │ cancelled │ (terminal)
                 └─────┬──────┘           └───────────┘
                submit │
                       ▼
                 ┌────────────┐  assign/claim  ┌─────────────┐
                 │  submitted │ ─────────────▶ │   assigned  │
                 └─────┬──────┘                 └──────┬──────┘
              claim/   │  start work                   │
              self-    ▼                               ▼ assignee
              assign ┌────────────┐   hold  ┌──────────┐  resolve ┌───────────┐
                 └──▶│ in_progress│ ◀─────▶ │ on_hold  │ ────────▶│ resolved  │
                     └────────────┘         └──────────┘          └─────┬─────┘
                                                    confirm/auto-close  │
                                                                        ▼
                                                                     ┌────────┐
                                                                     │ closed │ (terminal)
                                                                     └────────┘
```

Transition rules (enforced server-side — the table below **is** the contract encoded in
`shared/src/domain/requestTransitions.ts`, which both the API and the portal import):

| From | To | Allowed actor | Notes |
|---|---|---|---|
| draft | submitted | requester | starts SLA clock |
| draft | cancelled | requester (own) | no reason required, silently drops |
| submitted / assigned | cancelled | requester (own) | reason ≥ 10 chars; **not** allowed from `in_progress` onward (work already started) — MVP simplification |
| submitted | assigned | manager assigns; agent claims self | |
| assigned/in_progress | in_progress/assigned | assignee; manager re-assigns | |
| assigned/in_progress | on_hold | assignee, manager | pauses SLA |
| on_hold | assigned/in_progress | assignee, manager | resumes SLA |
| assigned/in_progress | resolved | assignee, manager | records resolution time |
| resolved | closed | requester; system auto-close after 5 business days | terminal |
| resolved/closed* | **assigned** (reopened, original assignee) | requester, within 7 days of resolution | *closed only if reopened within window before auto-close lands; keeps the original SLA clock (FR-12) |

## 7. Role permission matrix (excerpt — full matrix in §4 features map)

| Capability | employee | agent | manager | admin |
|---|:-:|:-:|:-:|:-:|
| Create/cancel own request | ✅ | ✅ | ✅ | ✅ |
| View own requests | ✅ | ✅ | ✅ | ✅ |
| View all requests | — | team queues | ✅ | ✅ |
| Claim / be assigned | — | ✅ | ✅ | ✅ |
| Resolve / hold / close others' tickets | — | own only | ✅ | ✅ |
| Internal notes | — | ✅ | ✅ | ✅ |
| Reassign | — | — | ✅ | ✅ |
| Change SLA policy | — | — | ✅ | ✅ |
| Manage users/departments/categories | — | — | — | ✅ |
| Analytics | — | own stats | org | org + export |
| Audit log | — | — | view | view + write |

**Team scoping rule (MVP):** an agent sees requests whose category matches an agent-team the user
belongs to (one team per agent: IT / HR / Facilities). Managers see all teams they manage.

## 8. SLA targets (initial policy — manager-editable)

Business hours: Mon–Fri 09:00–18:00 IST (9 h/day).

| Priority | First response | Resolution |
|---|---|---|
| critical | 30 min | 4 h (~1 business day) |
| high | 2 h | 24 h (~3 business days) |
| medium | 4 h | 3 business days |
| low | 8 h | 5 business days |

**SLA compliance %** = resolutions before resolution-due / total resolutions in period.

## 9. Business rules

- **BR-1** Priority set by requester on creation; only agent/manager/admin may change it after submission, with mandatory reason.
- **BR-2** A request must have category + sub-category + title (≥ 5 chars) + description (≥ 20 chars) before submission.
- **BR-3** Attachments bound to a request only after submission of the draft that referenced them; orphaned uploads purged nightly (24 h grace).
- **BR-4** Only `agent|manager|admin` accounts may be assignees; deactivating a user with open tickets requires reassignment first.
- **BR-5** Cancel/reopen require a reason (≥ 10 chars).
- **BR-6** `submitted` requests unassigned for > first-response target appear in "waiting" queue with warning color at 75 % elapsed.
- **BR-7** Auto-close is performed by a scheduled job (daily) and records actor = `system`.
- **BR-8** A closed/cancelled request is immutable except new comments flagged `post_closure` (read-only).

## 10. Out of scope for MVP (documented deferrals)

Email/Teams notifications · SSO/LDAP · multi-role users · mobile app · knowledge base ·
auto-triage/priority suggestion · asset management · reporting subscriptions · i18n ·
service catalog with approval workflows · external customer access.

## 11. MVP assumptions (uncertain areas — do NOT treat as fact)

| # | Assumption | If wrong, change |
|---|---|---|
| A-1 | ~50 employees, ~15 agents, < 200 requests/month — single-node Postgres + Node is enough | Add read replicas / caching |
| A-2 | Business-hours IST only, single timezone org | Generalize holiday/timezone config |
| A-3 | One team per agent is sufficient | Join table user↔team, broader scoping |
| A-4 | Attachments stored on local disk inside container volume (metadata in DB) | Swap storage driver → S3-compatible; interface already isolated (`storage` module) |
| A-5 | Admin creates accounts (no self-registration) | Add registration + approval flow |
| A-6 | Password change forced via flag on first login | SSO migration removes this |
| A-7 | Reopen window 7 days / auto-close 5 business days are acceptable defaults | Config table values |

## 12. Non-functional requirements

- **NFR-1 Performance:** p95 API latency < 300 ms at 200 concurrent users for list endpoints (page size 20); page load < 2 s on broadband.
- **NFR-2 Availability:** MVP target 99 % within business hours; restart-safe (Docker restart policy), zero data loss on crash (transactional writes).
- **NFR-3 Security:** see `docs/security-plan.md` (OWASP-aligned).
- **NFR-4 Auditability:** 100 % of state-changing actions recorded with actor + timestamp.
- **NFR-5 Maintainability:** TypeScript strict mode, lint + format enforced in CI, layered architecture per `system-architecture.md`, ≥ 70 % line coverage on core business logic.
- **NFR-6 Testability:** deterministic business-hours/SLA clock via injectable `Clock` port (faked in tests).
- **NFR-7 Portability:** entire stack runs with `docker compose up`; seed data for demos.

## 13. Success metrics (measurable)

| Metric | Definition | MVP target |
|---|---|---|
| SLA compliance | % resolutions before due | ≥ 90 % |
| MTTR | mean business-hours from submit → resolved | visible trend, decreasing |
| First-response adherence | ≥ 95 % within target | |
| Data completeness | requests with full activity trail | 100 % |
| Submission funnel completion | drafts started → submitted | ≥ 80 % |
| API error rate | 5xx / total requests | < 0.5 % |
| Test coverage | backend core domain lines | ≥ 70 % |

## 14. Constraints

Mandated stack (§ADR-001) · internship timeline — incremental delivery, mentor reviews each phase
· single small deployment VM/Docker host · no external paid services · IST business hours ·
must not store PII beyond name/email/department.

## 15. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| SLA clock complexity (business hours, pauses) — silent time-accounting bugs | breaches missed | Domain module `sla/clock.ts` with exhaustive unit tests + injectable clock; property test across DST-free IST (no DST, but week boundaries) |
| State-machine drift (FE allows what BE rejects) | corrupt data | Shared transition table generated from one source of truth (backend constant mirrored by FE type test) |
| Team-scoping of queues mis-specified | data leakage between teams | Central `visibility` policy function, permission-matrix integration tests per endpoint |
| Attachment storage on local disk lost on redeploy | data loss | Named volume + backup note in runbook; storage interface ready for S3 |
| Refresh-token rotation race (double submit) | users randomly logged out | Grace window of 10 s per rotated token, tested with concurrent refresh |
| Scope creep (approvals, email, SSO) | MVP never ships | Out-of-scope list §10 enforced as gate; anything new requires doc PR |
| Seed/demo data leaks into "prod" | fake metrics | Migration-guard check: refuse seed outside `demo` environment |

## 16. Edge cases (must be handled & tested)

1. Requester deactivates/leaves org while request open → manager reassigns visibility; request stays, flagged `requester_inactive`.
2. Assigned agent is deactivated → open tickets must be re-queued (BR-4) before deactivation succeeds.
3. Two agents claim same `submitted` request concurrently → optimistic lock; second claim gets 409 with fresh state.
4. Cancel and resolve submitted simultaneously → last-write-wins is **invalid**; transitions validated against `version` (optimistic concurrency column on `requests`).
5. Reopen attempt on day 8 → rejected (409) with clear message.
6. SLA target edited after requests created → existing trackers keep original due dates (policy applies to new submissions only).
7. Request created 18:30 Friday → clock starts next business window (Monday 09:00); due dates computed accordingly.
8. Attachment upload interrupted mid-way → chunk not committed; orphan purge (§9 BR-3).
9. File type spoofing (renamed .exe) → magic-byte check, not just extension/MIME.
10. Draft left unsubmitted for 90 days → auto-expire notification then purge (config).
11. Search injection (`%'`, `--`, wildcard storms) → parameterized ILIKE with escaped wildcards, length cap.
12. Refresh-token replay after logout → family revoked, all sessions of user invalidated + security notification.
13. Admin demotes themselves / last remaining admin → blocked (system must retain ≥ 1 active admin).
14. Category deactivated while requests open in it → open requests keep working; new requests cannot select it.
15. Clock skew across pods → all SLA math uses DB `now()` or single time source; tests use fixed clock.
16. Notification fan-out when a manager+agent is same person → dedupe per (user, event) within 1 min window.
17. Pagination beyond last page → empty array, 200 (not error) to keep FE tables simple.
18. Comment posted while request resolved by another actor → allowed; comment never blocked by state (except drafts by non-owner).

## 17. Acceptance criteria (release-level, Given/When/Then)

**AC-1 Authentication**
- Given a valid account, When logging in with correct password, Then an access token + refresh cookie are issued and the user lands on their role-appropriate home.
- Given 5 failed logins, When a 6th attempt occurs within the lock window, Then login is refused with a neutral message until unlock.

**AC-2 Request submission**
- Given an employee on the create form, When submitting with valid fields, Then a `REQ-…` ID exists, SLA tracker is created with correct business-hours due date, and the request appears in the assigned team's queue.
- Given a draft, When saved without description ≥ 20 chars, Then validation blocks submission with field-level errors.

**AC-3 Lifecycle integrity**
- Given a `resolved` request, When the requester reopens on day ≤ 7, Then status returns to `assigned`, original SLA tracker resumes, and the activity log contains the reopen reason.
- Given any state, When an actor attempts a transition not in the §6 table, Then API returns 409 `INVALID_TRANSITION` and no data changes.

**AC-4 SLA correctness**
- Given a `high` request (24 business-h resolution target, 9-h business day) submitted Mon 10:00 IST, When no action occurs until Tue 11:00, Then elapsed business hours = 10 (Mon 10–18 = 8, Tue 9–11 = 2) and remaining = 14.
- Given the same tracker, When elapsed reaches 18 business-h (Wed 10:00 IST = 75 %), Then a warning notification exists for the assignee and managers; at 24 business-h (Wed 16:00) a breach notification exists and the request is flagged breached in the queue.

**AC-5 Visibility**
- Given user A (IT agent), When browsing queues, Then HR/Facilities requests are absent from every list/search/detail response (verified at API level, not only UI).

**AC-6 Audit**
- Given any status/assignment/priority change, When inspecting the request history, Then an entry with actor, role, timestamp, from → to, reason (if required) is present; admin actions appear in the audit log.

**AC-7 Analytics**
- Given seeded demo data, When opening the dashboard for last 30 days, Then SLA compliance %, MTTR (business hours), volume-by-category chart, and breach list match an SQL-verified reference query.

**AC-8 Deploy**
- Given a clean machine with Docker, When running `docker compose --profile demo up`, Then migrations and idempotent seed apply automatically and the portal is reachable at `http://localhost:8080` (dev mode: `http://localhost:5173`) with demo accounts documented in `README`.

## 18. Traceability

Every FR maps to user stories in `docs/user-stories.md` (ST-nnn), and every story carries acceptance
criteria tested in `docs/test-plan.md` (TC-nnn). A PR that changes behavior without updating docs +
tests is rejected in review.
