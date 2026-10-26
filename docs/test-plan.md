# ESRS — Test Plan

Philosophy: **fast deterministic unit tests for domain rules, real-Postgres integration tests for
use cases, thin E2E smoke through the UI.** No test mocks of our own business logic; fakes only at
ports (Clock, storage). Every acceptance criterion in `requirements.md` §17 and each story AC in
`user-stories.md` must map to at least one TC id below.

Layers & tools:

| Layer | Tooling | DB | Speed target |
|---|---|---|---|
| Unit (domain, lib, FE utils/hooks) | Vitest (+ fast-check property tests) | none | < 5 s total |
| Component (web) | Vitest + React Testing Library + MSW | mocked HTTP | < 15 s |
| Integration (api) | Vitest + Supertest | **real Postgres** (testcontainers or compose `esrs-test` db) | < 60 s |
| Contract (shared schemas) | Vitest snapshots + zod↔TS drift checks | none | < 5 s |
| E2E smoke (optional Phase 20) | Playwright | full compose stack | nightly |

Coverage gates (CI fail under): `domain/` **90 %** lines+branches · services **70 %** · overall backend 70 %, frontend 60 %. Coverage reported per-package (`npm run test:coverage`).

> **As built (scaffold phase):** the API suites run Supertest against `createApp()` with the
> in-memory repository + fake clock/audit sink, so they are hermetic and need no database; the
> Postgres adapters are covered today by the `@esrs/database` contract test (SQL enums/SLA defaults
> vs `@esrs/shared`) and move to the real-DB row above as soon as `npm run db:up` + `db:migrate`
> are part of the loop. `npm run evidence` captures the actual output of every layer.

---

## 1. Unit — domain core (highest ROI; write before implementation, TDD)

### TC-SLA-* business-hours clock (`domain/sla/businessHours.ts`)
| ID | Given | When | Expect |
|---|---|---|---|
| TC-SLA-01 | Mon 10:00 IST, +24 h target | addBusinessHours | Wed 10:00? **No** — business-hour accounting: Mon 10–18 = 8 h remaining, Tue 9–18 = 9 h, need 7 h Wed ⇒ **Wed 16:00** |
| TC-SLA-02 | Fri 18:30 (outside hours) + 4 h | | Mon 13:00 |
| TC-SLA-03 | Sat 11:00 + 1 h | | Mon 10:00 |
| TC-SLA-04 | Pause segments: tracker submitted Mon 09:00, resolution target 24 business-h, `on_hold` Tue 09:00 → Thu 09:00 | computeDue | Unpaused due = Wed 15:00 (Mon 9 h + Tue 9 h + Wed 6 h). Paused span contains 18 business-h (Tue 9 + Wed 9; Thu 00:00–09:00 is outside hours) ⇒ **due = Fri 15:00** |
| TC-SLA-05 | target 0 / negative | | throws `InvalidTarget` |
| TC-SLA-06 | property: for random (start, duration) within 2 years | add then subtract | original start (identity) |
| TC-SLA-07 | elapsedBusinessMinutes across weekend/holiday-free IST (no DST) | | monotonic, never negative |

### TC-SM-* state machine (`domain/request/stateMachine.ts`)
| ID | Case |
|---|---|
| TC-SM-01 | full transition table enumeration (from × action) ⇒ allowed set exactly equals requirements §6 (single source-of-truth import; table-driven test) |
| TC-SM-02 | reopen only within `resolved_at + 7d` (injectable clock at day 6.9 ok / day 7.1 reject) |
| TC-SM-03 | cancel legal from submitted/assigned only; reject in_progress+ |
| TC-SM-04 | auto-close after 5 business days resolved (boundary: 4.9 no, 5.0 yes) |
| TC-SM-05 | invalid action name ⇒ `UNKNOWN_ACTION`, no mutation |

### TC-RBAC-* policy (`domain/rbac/policy.ts`)
| ID | Case |
|---|---|
| TC-RBAC-01 | matrix test: role × action × resource-context(own/other, team match/mismatch, draft/open) ⇒ expected allow/deny — generated from requirements §7 (data-driven, ~120 cases) |
| TC-RBAC-02 | default-deny for undeclared action |
| TC-RBAC-03 | internal comment visibility: employee ⇒ deny; agent same team ⇒ allow |

### TC-DOM other
- ID generation format `REQ-YYYY-NNNNNN` (pad, year rollover seq=1).
- Priority change remap: new due ≤ original due unless already elapsed (never grants free time).

## 2. Unit — lib/config
env validation fail-fast w/ missing names; pagination clamp (page_size>100 ⇒ 100); ILIKE escape
(`100%_` → `100\%\_`); CSV formula guard (`=cmd` ⇒ `'=cmd`); error mapper (AppError→HTTP); logger masks email.

## 3. Integration — API (Supertest + real DB)

Harness: `withDb()` truncate-all between files, per-test `tx` helpers; fixed `TestClock`;
seed factories (`makeUser(role,team)`, `makeRequest(status,…)`).

### TC-AUTH
| ID | Scenario | Expect |
|---|---|---|
| A-01 | login ok | 200, cookie set with attributes, token parses, `/auth/me` 200 |
| A-02 | wrong pw × 5 then correct within window | 423 until lock expiry (clock advance), then ok; counter reset |
| A-03 | unknown email vs wrong pw | identical response body/timing band (<20 % delta, stat test skipped on CI flake—assert body only) |
| A-04 | refresh rotates; old token reuse | new works; reuse ⇒ 401 `REFRESH_REUSE` + family revoked (subsequent valid refresh also fails) |
| A-05 | concurrent refresh ×2 | one wins, other within 10 s grace succeeds (no lost session) |
| A-06 | `must_change_password` user hits /requests | 403 `PASSWORD_CHANGE_REQUIRED` |
| A-07 | logout then refresh | 401 |

### TC-REQ lifecycle & concurrency
| ID | Scenario | Expect |
|---|---|---|
| R-01 | draft → submit | number allocated, tracker created w/ snapshot due, events `[created,submitted]`, appears in team queue |
| R-02 | submit missing BR-2 fields | 400 field errors, state unchanged |
| R-03 | claim race (2 agents parallel) | one 200, other 409 + current assignee shown; DB consistent |
| R-04 | stale If-Match transition | 409 CONFLICT, version unchanged |
| R-05 | invalid transition (submitted→resolved) | 409 `INVALID_TRANSITION`, no event written |
| R-06 | resolve without note | 400 |
| R-07 | reopen day 7 vs 8 (clock) | 200 resumed w/ same due / 409 |
| R-08 | auto-close job | resolved+5bd → closed, actor system, notifications exist; re-run idempotent (advisory lock + already-closed skip) |
| R-09 | priority change requires reason; tracker remapped not reset | event + audit; `completion_status` unchanged until resolve |
| R-10 | employee PATCHes someone else's draft | 404 |

### TC-VIS (visibility — security-critical)
| ID | Scenario |
|---|---|
| V-01 | IT agent list/search/detail of HR request ⇒ absent/404 (endpoint-by-endpoint) |
| V-02 | employee never receives `internal` comments or `on_hold` internal reasons in payload (deep-key scan of response JSON for forbidden substrings) |
| V-03 | requester sees own drafts; agent does not see any `draft` rows |
| V-04 | deauthorized attachment download (file of request in other team) ⇒ 404 |
| V-05 | manager sees all; admin sees audit-only extras |

### TC-TAX / TC-USR
- deactivating category: open requests still operable; new-request query excludes it.
- deactivate user with open tickets ⇒ 409 `ASSIGNEE_HAS_OPEN_TICKETS`; last admin ⇒ 409 `LAST_ADMIN_GUARD`; role change writes audit before/after.

### TC-SLA-JOB
- sweep at 74 %/75 %/101 % elapsed creates zero/one/one+breach-flag respectively; rerun no duplicates (dedupe key).
- policy edit affects only trackers created after edit (edge §16.6 asserted end-to-end).

### TC-NOTIF / TC-ANL / TC-AUD
- notifications created per event types; unread count accurate; read-all idempotent.
- analytics: seed a deterministic mini-dataset ⇒ compare endpoint output to **reference SQL** queries in §5 (exact equality incl. rounding of % to 1 decimal).
- audit: each admin mutation appends one row with before/after; no update/delete route exists (404 on attempts).

### TC-RATE
- login 11th call in minute ⇒ 429 + Retry-After; write limit per user; reset after window (clock).

## 4. Contract tests
| ID | Case |
|---|---|
| C-01 | every response DTO: `schema.parse(exampleFromRouteHandler)` in handler tests (routes export their schema) |
| C-02 | enum parity snapshot: DB enums (from migration SQL) === `shared` enums (CI fails on drift) |
| C-03 | OpenAPI generation smoke (`zod-to-openapi` emits valid doc; path count === endpoint registry count) |

## 5. Reference SQL for analytics (test oracle)
```sql
-- SLA compliance % in [from,to): resolutions before due
SELECT round(100.0 * count(*) FILTER (
  WHERE t.completion_status='met') / nullif(count(*),0), 1)
FROM requests r JOIN sla_trackers t ON t.request_id=r.id
WHERE r.resolved_at BETWEEN :from AND :to;

-- MTTR business hours: reuses domain fn per row via a small set-returning helper
-- (tested against JS implementation both ways)
```
The integration test seeds rows, runs these SQL queries **and** the API, asserts equality — this
guards against silent definition drift between service code and docs.

## 6. Security test pack (mirrors security-plan checklist)
| ID | Case |
|---|---|
| SEC-TC-01 | JWT `alg:none` / expired / wrong-aud rejected |
| SEC-TC-02 | SQLi payloads in `q`/filters ⇒ 0 rows or 400; pg log shows parameters only |
| SEC-TC-03 | XSS payloads in title/description/comment ⇒ stored raw, rendered escaped (component test: `screen.getByText` not innerHTML) |
| SEC-TC-04 | **permission matrix integration** (generated endpoint × role; declared expectations file; undeclared endpoint fails) |
| SEC-TC-05 | upload: `.exe` renamed `.png` ⇒ 415 magic mismatch; oversize ⇒ 413; multipart boundary fuzz ⇒ 400 not 500 |
| SEC-TC-06 | path traversal `GET /files/../etc/passwd` style normalized & denied |
| SEC-TC-07 | headers snapshot test (helmet CSP, nosniff, frameguard) |
| SEC-TC-08 | rate-limit + lockout combo (credential-stuffing simulation 50 attempts) |

## 7. Frontend component tests (RTL + MSW)
| Area | Must-cover |
|---|---|
| Auth | login error display incl. lockout; refresh interceptor single-flight (401→refresh→retry exactly once; concurrent 401s coalesce) |
| Request form | zod field errors; draft autosave on blur; submit success → redirect w/ number; attachment rejection messages (size/type) |
| My requests | countdown states safe/warning/breached from server fields only; empty states; filter → URL sync |
| Queue | claim conflict 409 → toast + refetch; assignment picker filtered by team |
| Detail | internal notes hidden for employee role even if response tampered (defensive filter) ; transitions buttons match state machine (snapshot of allowed actions per status from shared fn) |
| Dashboards | chart data mapping, range presets, CSV download triggered |
| A11y | axe-core scan of key pages (zero critical); keyboard submit paths; `aria-live` on async form errors |

## 8. E2E smoke (Playwright, nightly, Phase 20+)
1. admin login → create agent → agent claims seeded request → resolves → requester confirms close → dashboard reflects resolution.
2. critical request ages → warning notification appears (accelerated clock via demo env `ESRS_TEST_TIME=1`).
Paths recorded as video artifact on failure.

## 9. Performance tests (autocannon/k6, Phase 20)
| ID | Scenario | Pass |
|---|---|---|
| P-01 | `GET /requests` queue page_size=20, 200 VU × 60 s | p95 < 300 ms, err < 0.5 % |
| P-02 | login burst 50 VU | p95 < 400 ms (bcrypt dominant), no lockout false-positives (per email) |
| P-03 | analytics summary 90-day range | p95 < 800 ms with indexes |
| P-04 | upload 5 MB × 20 concurrent | all 201 or graceful 429, no 5xx |
| P-05 | SLA sweep job with 10 k trackers | completes < 30 s, DB connections stable |

## 10. Test data & environment
- Factories/helpers live beside the code they serve: `backend/src/**/*.test.ts` fixtures, `frontend/src/test/harness.tsx` (fetch stub + fixtures), `database/seeds/`. No hand-written long fixtures.
- `esrs_test` DB (compose port 5433) separated from dev; truncate strategy + `TRUNCATE … RESTART IDENTITY CASCADE` in harness; deterministic seed per suite.
- Demo seed (users): `admin@demo.corp / admin@hr.corp / it.agent1@demo.corp …`. **No password value is
  ever committed**: `seeds/002_demo_data.sql` contains a `{{DEMO_PASSWORD_HASH}}` token that
  `npm run db:seed` replaces with `bcrypt(SEED_DEMO_PASSWORD, 12)`, so the secret lives only in the
  local `.env` of whoever seeds a demo box (security-plan §2).

## 11. Flakiness & process rules
- No `sleep()`; fake/advance `TestClock` only. Poll helpers (`waitFor`) for async UI.
- Retries: max 1, and a flaky test gets an issue + quarantine label > 2 strikes = fix-or-delete decision by mentor.
- Every bug fix ships with a regression TC referencing the issue id (label `regression`).
- DoD per story: unit + integration TCs listed under the story, code coverage gate green, docs updated.

## 12. Traceability table (release gate)

| Acceptance criterion | Covering TCs |
|---|---|
| AC-1 auth | A-01..A-07, SEC-TC-01/08 |
| AC-2 submission | R-01, R-02, FE form tests §7 |
| AC-3 lifecycle | TC-SM-*, R-05..R-07, V-02 |
| AC-4 SLA | TC-SLA-*, TC-SLA-JOB, P-05 |
| AC-5 visibility | TC-VIS-*, SEC-TC-04 |
| AC-6 audit | TC-AUD, TC-DOM numbering |
| AC-7 analytics | TC-ANL + §5 oracle |
| AC-8 deploy | E2E smoke §8 on compose stack |
