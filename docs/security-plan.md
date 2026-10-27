# ESRS — Security Plan

Scope: MVP threat model + controls, mapped to OWASP ASVS L1 (leaning L2 on auth).
Owner: whoever opens a security-relevant PR must check the relevant § and add tests from `test-plan.md` §6.

---

## 1. Assets & threat overview

| Asset | Threat examples |
|---|---|
| User accounts / sessions | credential stuffing, token theft, session fixation |
| Request data (may contain HR-sensitive text) | IDOR across teams, leaked internal notes, dump via search |
| Attachments | malicious upload, path traversal, exfil via unauth download |
| Audit trail | tampering/erasure to hide actions |
| Availability | brute force, upload floods, expensive queries |

STRIDE walkthrough per module is a living table in each module README; the plan below is the control baseline.

## 2. Authentication (aligns FR-1/2, ST-101–104)

- Passwords: **bcrypt**, cost factor 12, policy: min 12 chars, no breached-common list (MVP: Zod denylist), re-hash on cost change at login (transparent upgrade).
- **No self-registration**; accounts created by admin with `must_change_password` flag.
- Login timing parity: on unknown email still run bcrypt verify against a baked dummy hash.
- Lockout: 5 failures / 15 min per email (DB-backed, survives restart); IP rate limit on top; successful login resets counter; lockout events → `login_attempts` + audit.
- Password change revokes all other sessions (refresh families).

## 3. Session & token design (JWT + rotating refresh)

| Token | Where | Lifetime | Notes |
|---|---|---|---|
| Access JWT | memory (SPA), `Authorization: Bearer` | 15 min | HS256 MVP w/ 256-bit secret from env; RS256 documented upgrade path if multiple verifiers appear |
| Refresh | `httpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` cookie | 7 days | opaque 256-bit random, stored **sha256-hashed**, rotation with family lineage (`refresh_token_families`) |

- **Rotation + reuse detection:** presenting a replaced token revokes the entire family, forces re-login, security notification + audit entry (edge §16.12). 10 s grace on rotation to survive in-flight races.
- JWT claims: `sub, role, team, jti, iat, exp`; `iss/aud` checked; signature verified before anything else; `alg` pinned (reject `none`/others).
- Logout = server-side family revoke + cookie clear. Access tokens short-lived ⇒ no denylist needed (documented accepted risk).
- Storage rules: nothing auth-related in `localStorage`/`sessionStorage`; CSP forbids inline scripts (mitigates token theft via XSS).

## 4. Authorization (RBAC + object-level checks)

1. Middleware authenticates → `AuthContext`.
2. `domain/rbac/policy.ts` — pure `can(actor, action, resourceContext)`; **default-deny**; action list versioned in `shared`.
3. **Visibility is a query constraint**, applied inside repository SQL (team scoping, owner-only drafts, internal-comment exclusion) — UI hiding is convenience, not control (AC-5). The exclusion covers *metadata* too: a `comment_added` marker in `request_events` carries a comment's visibility and length, so it is filtered out of the `events` trail for anyone below `agent` as well as out of the thread and the timeline — otherwise a staff-only note would announce its existence on a ticket it was written to keep private.
4. Object-level checks on every single-resource path (IDOR tests: employee requests another's ticket from a different team ⇒ 403/404 — 404 chosen for existence-hiding on cross-team reads). One documented ordering exception: the comment-write role gate (`comment.internal`) is evaluated **before** the row is read, so an employee trying to leave an internal note on a ticket outside their scope gets a 403 that names only their role. It reveals no row data, but it does not answer with the 404 the rest of the API uses (`api-specification.md` §7).
5. Role change / deactivation guards: last-admin rule, open-ticket rule (transactional check).
6. Forced password-change gate: middleware blocks everything except `/auth/*` when `must_change_password`.

Permission-matrix integration tests (requirements §7 table → test-plan §6 SEC-TC-04) run on **every** endpoint × role combination using a generated matrix — new endpoints fail CI until declared.

## 5. Input validation & output safety

- **Zod everywhere** (body/query/params); unknown keys stripped (`strict()`); query length caps (q ≤ 200, page_size ≤ 100).
- SQL: `pg` parameterized only; every statement in the repository adapters is a fixed string with `$n` placeholders and a separate params array, so request data never reaches the text of a query. `ORDER BY` is the one place a column cannot be bound, so the sort key is matched against a whitelist and mapped to a fixed SQL fragment; ILIKE wildcards escaped (`%`,`_`,`\`).
- XSS: React escapes by default; `dangerouslySetInnerHTML` is banned by ESLint (`no-restricted-syntax` on `JSXAttribute[name.name="dangerouslySetInnerHTML"]`, frontend files), and a component test asserts a markup-bearing comment body produces no element in the DOM; description rendering keeps newlines via CSS, not HTML.
- Uploads: extension allowlist **and** magic-byte check (`file-type`); size caps (10 MB/file, 20 MB body); filename stored sanitized, served from `Content-Disposition` with original name escaped; files **never** executed (volume mounted `noexec` where host allows) and not served inline.
- CSV export: prefix spreadsheet formula injection (`=`,`+`,`-`,`@`) with `'`; row cap.
- Logs: email/IP partial-mask in logs at INFO; full only at DEBUG in non-prod.

## 6. Transport, headers, CORS

- helmet: `contentSecurityPolicy` (`default-src 'self'; connect-src 'self'` + web origin), `frameguard DENY`, `noSniff`, HSTS in prod, `Referrer-Policy: same-origin`.
- CORS: exact-origin allowlist (`WEB_ORIGIN` env), credentials true, methods/F preflight cached 10 min.
- Prod behind TLS-terminating reverse proxy (runbook: Caddy/Nginx + cert); HTTP → HTTPS redirect. Dev over plain http allowed (cookie `Secure` flag env-gated).

## 7. Secrets & configuration

- All secrets via env (`config` zod-validated at boot; fail-fast with names of missing vars — never values). `.env*` gitignored; `.env.example` with placeholders only.
- JWT secret rotation documented (dual-secret window); bcrypt dummy hash committed is public-test value.
- Least-privilege DB role for app (`esrs_app`: DML on public schema, no DDL — migrations run as separate `esrs_migrator` role).
- No secrets/PII in fixtures; demo seed uses fake identities.

## 8. Security logging & monitoring

- `audit_logs` for: login success/fail summary (daily rollup to avoid noise), role/user changes, SLA policy edits, priority changes, assignment changes, permission-denied (403) events with actor+route.
- **History is append-only.** Rows describing a request change are written in the same transaction as the change (a failed audit insert rolls the operation back), and migration 017 blocks `UPDATE`/`DELETE`/`TRUNCATE` on `audit_logs` and `request_events` plus re-attribution of a comment's author or instant. There is no read, update or delete route for audit rows at all — `GET /audit-logs` is not mounted and the resulting 404 is captured in `evidence/`, not merely asserted (`api-specification.md` §12).
- **Nothing sensitive is recorded.** Passwords, tokens and full comment bodies never enter `audit_logs`; a comment write stores a summary (length, visibility, id) and credentials are redacted at the sink. The known gap: an actor who can read the database directly also has `GRANT ALL` on it today, so the trigger tier is defence against application bugs and honest about not being tamper-proof.
- Alerting (MVP): notification to admins on ≥ 20 failed logins/hour; refresh-reuse events always notify affected user.
- Log retention: stdout → host rotation (size-based), 30 days.

## 9. Data protection

- PII minimization: name, email, department only; HR free-text may contain sensitive content ⇒ internal-note exclusion from employee payloads + no full-text index on comments (documented).
- Rest: DB + attachment volume encrypted at rest **assumed at host level** (VM disk) — MVP accepted risk; app-level encryption deferred.
- Deletion: users are deactivated, never hard-deleted (audit integrity); a documented right-to-erase procedure (anonymize `full_name`/`email`, cascade nulls) for future policy.
- Backups contain PII ⇒ access restricted, retention 7/4 (database-design §7).

## 10. Dependency & supply chain

- `npm audit` (high/critical break CI; `npm ci` currently reports 0 vulnerabilities) + Dependabot/renovate weekly; lockfile committed; Docker base images pinned by tag+digest updated via PR only; node:22-alpine, postgres:16-alpine. Every dependency is checked for the npm `deprecated` banner before it is added — ESLint was moved to the supported 10.x line for exactly that reason (ADR-001 §2.1 as-built revisions).

## 11. Hardening checklist per phase (embed in PR template)

- [ ] new endpoint declares RBAC action + added to matrix test
- [ ] new query = parameterized; new search = escaped
- [ ] new upload/type = allowlist + magic bytes reviewed
- [ ] secrets only through config; no values in logs/errors
- [ ] 403/404 semantics match §4.4 (no existence leaks)
- [ ] rate-limit class assigned (auth/write/read)

## 12. Accepted risks (MVP) & revisit triggers

| Risk | Why accepted | Revisit when |
|---|---|---|
| HS256 shared-secret JWT | single verifier service | multi-service/verifier appears |
| No account recovery flow (admin reset only) | internal users, admin exists | self-service org |
| At-rest encryption delegated to host | single small VM assumption A-1 | move to managed cloud DB |
| No MFA | scope + no identity provider | production rollout |
| In-app notifications only (no email) | no SMTP dependency | real org rollout |

## 13. Pre-launch security review (Phase 20 gate)

Threat-model walkthrough of new modules · matrix test green · `npm audit` clean · manual
IDOR spot-check (10 endpoints as low-priv user) · rate-limit load probe (autocannon against login) ·
header scan (securityheaders.com on staging) · CSP violation console check on all FE pages.
