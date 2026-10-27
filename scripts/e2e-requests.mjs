/**
 * Live end-to-end driver for the service-request API.
 *
 * Talks to a running backend over real HTTP with PostgreSQL behind it, walks the whole lifecycle as
 * five seeded identities, and records every response into evidence/api-responses/. Any call whose
 * status differs from the expectation is collected and reported at the end with a non-zero exit code,
 * so a silent regression cannot pass as "the script finished".
 *
 *   npm run db:up                 # Postgres on the port in .env
 *   npm run dev                   # API on 4000, portal on 5173 (backend/.env PORT)
 *   npm run e2e:requests          # override the target with E2E_BASE=http://host:port/api/v1
 *
 * It is deliberately repeatable: demo credentials are restored and the tickets from the previous run
 * are deleted first, so the year's numbering restarts at 000001 and the captures stay comparable.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const API = process.env.E2E_BASE ?? 'http://localhost:4000/api/v1';
const OUT = join(process.cwd(), 'evidence', 'api-responses');
mkdirSync(OUT, { recursive: true });

const rootEnv = readFileSync(join(process.cwd(), '.env'), 'utf8');
const demo = /^SEED_DEMO_PASSWORD=(.+)$/m.exec(rootEnv)?.[1]?.trim();
const databaseUrl = /^DATABASE_URL=(.+)$/m.exec(rootEnv)?.[1]?.trim();
if (!demo || !databaseUrl) throw new Error('SEED_DEMO_PASSWORD / DATABASE_URL missing from .env');

// The seeded demo accounts carry the ST-104 first-login flag, which the forced-change gate enforces
// on every business endpoint; that flow is covered by auth.http.test.ts. `npm run db:seed` uses
// `ON CONFLICT DO NOTHING`, so an account whose password was changed by an earlier manual run keeps
// that password. Both states are restored here (the same thing a first login does) to make this
// driver reproducible against whatever is already in the local development database.
const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();
await db.query(
  `UPDATE users SET password_hash = $1, must_change_password = false,
          failed_login_count = 0, locked_until = NULL
     WHERE email LIKE '%@company.test'`,
  [await bcrypt.hash(demo, 12)],
);

// The captured evidence has to be reproducible, so the tickets this driver creates are removed before
// the run and the year's counter is reset — a re-run then allocates the same numbers and writes the
// same history. Seeded `REQ-DEMO-*` rows are left alone; child rows cascade with the ticket.
//
// That cascade is exactly why this cleanup runs as a maintenance transaction: `request_events` and
// `audit_logs` are append-only since migration 017, and PostgreSQL fires their row triggers for a
// cascading delete too (`docs/database-design.md` §8). `SET LOCAL` scopes the exception to this
// transaction and is revoked by the COMMIT — the only path by which demo data is ever purged.
const year = new Date().getUTCFullYear();
await db.query('BEGIN');
await db.query("SET LOCAL esrs.allow_history_mutation = 'on'");
const removed = await db.query('DELETE FROM requests WHERE request_number LIKE $1', [
  `REQ-${year}-%`,
]);
await db.query('DELETE FROM request_numbers WHERE year = $1', [year]);
await db.query('COMMIT');

// Deleting the tickets does not rewind the identity counters, so the second run would capture the same
// payloads under different surrogate ids and every id quoted in `docs/api-specification.md` would drift.
// Realigning each counter with the rows that survived makes a re-run byte-for-byte comparable: the
// request ids, event ids and assignment ids come out identical every time.
await db.query(`
  DO $realign$
  DECLARE record_with_sequence record;
  BEGIN
    FOR record_with_sequence IN
      SELECT c.table_schema, c.table_name,
             pg_get_serial_sequence(c.table_schema || '.' || c.table_name, 'id') AS sequence_name
        FROM information_schema.columns AS c
       WHERE c.table_schema = 'public'
         AND c.column_name = 'id'
         AND c.table_name IN ('requests', 'request_events', 'assignments', 'sla_trackers', 'comments',
                              'attachments', 'notifications', 'audit_logs')
    LOOP
      IF record_with_sequence.sequence_name IS NOT NULL THEN
        EXECUTE format(
          'SELECT setval(%L, (SELECT COALESCE(MAX(id), 0) + 1 FROM %I.%I), false)',
          record_with_sequence.sequence_name,
          record_with_sequence.table_schema,
          record_with_sequence.table_name
        );
      END IF;
    END LOOP;
  END
  $realign$;
`);

console.log(
  `prep: demo credentials restored, ${removed.rowCount} earlier driver tickets cleared, identity counters realigned\n`,
);
await db.end();

const mismatches = [];
const log = [];

async function call(key, verb, path, { token, body, headers = {}, expect, brief = false } = {}) {
  let response;
  let parsed;
  // `/auth/*` is rate limited per IP, and this driver logs in five identities back to back, so a
  // burst from a previous run can still be inside the window. Waiting it out is the honest fix — the
  // limiter working is not something the request API should paper over.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    response = await fetch(`${API}${path}`, {
      method: verb,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status !== 429) break;
    const waitSeconds = Number(response.headers.get('retry-after') ?? '61');
    console.log(`    rate limited, waiting ${waitSeconds}s …`);
    await new Promise((resolve) => setTimeout(resolve, (waitSeconds + 1) * 1000));
  }
  const text = await response.text();
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  const status = response.status;
  log.push({ key, verb, path, status, etag: response.headers.get('etag') });
  if (!brief) {
    writeFileSync(join(OUT, `req-${key}.json`), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  }
  if (expect !== undefined && expect !== status) {
    mismatches.push(`${key}: ${verb} ${path} -> ${status}, expected ${expect}`);
  }
  const flag = expect === undefined || expect === status ? 'ok  ' : 'FAIL';
  console.log(`${flag} ${verb.padEnd(6)} ${path} -> ${status}`);
  return parsed;
}

const data = (payload) => payload.data;

// --- identities (seeded demo users) -----------------------------------------
// 1 employee (dept 1) · 2 agent team 1 IT · 3 manager team 1 · 4 admin · 5 agent team 2 HR
const tokens = {};
for (const [role, email] of [
  ['employee', 'demo.employee@company.test'],
  ['agent', 'demo.agent@company.test'],
  ['hrAgent', 'demo.hr-agent@company.test'],
  ['manager', 'demo.manager@company.test'],
  ['admin', 'demo.admin@company.test'],
]) {
  const payload = await call(`login-${role}`, 'POST', '/auth/login', {
    body: { email, password: demo },
    expect: 200,
    brief: true,
  });
  tokens[role] = data(payload).access_token;
}
for (const [role, value] of Object.entries(tokens)) {
  if (!value) throw new Error(`login as '${role}' produced no access_token`);
}

// --- creation ---------------------------------------------------------------
const created = data(
  await call('create', 'POST', '/requests', {
    token: tokens.employee,
    expect: 201,
    body: {
      title: 'Laptop will not boot after Tuesday patch',
      description:
        'My laptop loops at the vendor logo after the patch. I need it working before the client demo on Friday.',
      category_id: '1',
      sub_category_id: '1',
      priority: 'high',
    },
  }),
);
console.log(`    created ${created.request_number} status=${created.status} v=${created.version}`);

await call('reject-short-title', 'POST', '/requests', {
  token: tokens.employee,
  expect: 400,
  body: { title: 'Fix', description: 'x'.repeat(30), category_id: '1' },
});
await call('reject-unknown-category', 'POST', '/requests', {
  token: tokens.employee,
  expect: 400,
  body: {
    title: 'Badge reader on floor four is offline',
    description: 'The reader at the fire door does not respond, so the door is propped open.',
    category_id: '999',
  },
});
await call('reject-cross-category-sub', 'POST', '/requests', {
  token: tokens.employee,
  expect: 400,
  body: {
    title: 'Badge reader on floor four is offline',
    description: 'The reader at the fire door does not respond, so the door is propped open.',
    category_id: '1',
    sub_category_id: '11',
  },
});
await call('reject-protected-field', 'POST', '/requests', {
  token: tokens.employee,
  expect: 400,
  body: {
    title: 'Badge reader on floor four is offline',
    description: 'The reader at the fire door does not respond, so the door is propped open.',
    category_id: '1',
    status: 'closed',
  },
});

// --- draft pipeline ---------------------------------------------------------
const draft = data(
  await call('create-draft', 'POST', '/requests', {
    token: tokens.employee,
    expect: 201,
    body: {
      title: 'Needs a second monitor for the finance reconciliation',
      description: 'Two-factor spreadsheet work needs a second screen. Requesting one from IT.',
      category_id: '1',
      draft: true,
    },
  }),
);
console.log(
  `    draft id=${draft.id} number=${draft.request_number} actions=${draft.allowed_actions}`,
);
await call('patch-draft', 'PATCH', `/requests/${draft.id}`, {
  token: tokens.employee,
  expect: 200,
  body: { sub_category_id: '5' },
});
// Priority is a management decision, not a content field: the schema accepts it, the service gates it.
await call('patch-draft-priority-as-employee', 'PATCH', `/requests/${draft.id}`, {
  token: tokens.employee,
  expect: 403,
  body: { priority: 'critical', reason: 'Escalating my own draft' },
});
// A manager may reprioritise, but never on someone else's draft: drafts are invisible outside their
// author, and an out-of-scope row is a 404 so ticket ids cannot be probed.
await call('patch-draft-priority-as-manager', 'PATCH', `/requests/${draft.id}`, {
  token: tokens.manager,
  expect: 404,
  body: { priority: 'high', reason: 'Finance month-end depends on this screen' },
});
await call('patch-draft-protected-field', 'PATCH', `/requests/${draft.id}`, {
  token: tokens.employee,
  expect: 400,
  body: { status: 'submitted' },
});
await call('submit-draft', 'POST', `/requests/${draft.id}/submit`, {
  token: tokens.employee,
  expect: 200,
  body: {},
});
await call('reject-edit-submitted', 'PATCH', `/requests/${draft.id}`, {
  token: tokens.employee,
  expect: 409,
  body: { title: 'Rewriting a ticket that is no longer a draft' },
});

// --- reads, scope and query validation --------------------------------------
await call('list-own', 'GET', '/requests?page=1&page_size=5&sort=-submitted_at', {
  token: tokens.employee,
  expect: 200,
});
await call('list-filter', 'GET', '/requests?status=submitted&priority=high&q=laptop', {
  token: tokens.employee,
  expect: 200,
});
await call('list-team-queue', 'GET', '/requests?assignee_id=me&sort=priority', {
  token: tokens.agent,
  expect: 200,
  brief: true,
});
await call('list-manager-all', 'GET', '/requests?status=submitted,assigned&page=1', {
  token: tokens.manager,
  expect: 200,
  brief: true,
});
await call('detail', 'GET', `/requests/${created.id}`, { token: tokens.employee, expect: 200 });
await call('read-anonymous', 'GET', '/requests', { expect: 401 });
await call('read-out-of-scope-404', 'GET', `/requests/${created.id}`, {
  token: tokens.hrAgent,
  expect: 404,
});
await call('missing-id', 'GET', '/requests/999999', { token: tokens.admin, expect: 404 });
await call('bad-id', 'GET', '/requests/not-a-number', { token: tokens.admin, expect: 400 });
await call('bad-filter', 'GET', '/requests?status=pending', {
  token: tokens.employee,
  expect: 400,
});
await call('bad-sort', 'GET', '/requests?sort=description', {
  token: tokens.employee,
  expect: 400,
});
await call('unknown-query-key', 'GET', '/requests?nonexistent=1', {
  token: tokens.employee,
  expect: 400,
});
await call('clamped-page-size', 'GET', '/requests?page_size=5000', {
  token: tokens.employee,
  expect: 200,
  brief: true,
});

// --- permission gates -------------------------------------------------------
await call('employee-assign-forbidden', 'POST', `/requests/${created.id}/assign`, {
  token: tokens.employee,
  expect: 403,
  body: { assignee_id: '2', reason: 'Trying to route it myself' },
});
await call('employee-transition-assign-forbidden', 'POST', `/requests/${created.id}/transition`, {
  token: tokens.employee,
  expect: 403,
  body: { action: 'assign', assignee_id: '2' },
});
await call('employee-priority-forbidden', 'PATCH', `/requests/${created.id}`, {
  token: tokens.employee,
  expect: 403,
  body: { priority: 'critical', reason: 'Escalating it myself' },
});
await call('agent-cancel-forbidden', 'POST', `/requests/${created.id}/cancel`, {
  token: tokens.agent,
  expect: 403,
  body: { reason: 'Not the requester, so this must not succeed' },
});

// --- assignment by a manager ------------------------------------------------
const assigned = data(
  await call('assign', 'POST', `/requests/${created.id}/assign`, {
    token: tokens.manager,
    expect: 200,
    headers: { 'if-match': `"${created.version}"` },
    body: { assignee_id: '2', reason: 'Hardware queue owner this week' },
  }),
);
console.log(`    assigned to ${assigned.assignee?.full_name} v=${assigned.version}`);
await call('assign-unknown-user', 'POST', `/requests/${created.id}/assign`, {
  token: tokens.manager,
  expect: 422,
  body: { assignee_id: '999999' },
});
await call('assign-employee-role', 'POST', `/requests/${created.id}/assign`, {
  token: tokens.manager,
  expect: 422,
  body: { assignee_id: '1' },
});
await call('assign-wrong-team', 'POST', `/requests/${created.id}/assign`, {
  token: tokens.manager,
  expect: 422,
  body: { assignee_id: '5' },
});
await call('stale-if-match', 'POST', `/requests/${created.id}/start`, {
  token: tokens.agent,
  expect: 409,
  headers: { 'if-match': `"${created.version}"` },
  body: {},
});
await call('bad-if-match', 'POST', `/requests/${created.id}/start`, {
  token: tokens.agent,
  expect: 400,
  headers: { 'if-match': 'not-a-version' },
  body: {},
});

// --- comments while the ticket is open --------------------------------------
await call('comment-anonymous', 'POST', `/requests/${created.id}/comments`, {
  expect: 401,
  body: { body: 'No token, no comment.' },
});
await call('comment-empty', 'POST', `/requests/${created.id}/comments`, {
  token: tokens.employee,
  expect: 400,
  body: { body: '   \n  ' },
});
await call('comment-oversized', 'POST', `/requests/${created.id}/comments`, {
  token: tokens.employee,
  expect: 400,
  body: { body: 'x'.repeat(5001) },
});
// Author and timestamp are stamped by the server, so the create schema is `.strict()`.
await call('comment-smuggled-author', 'POST', `/requests/${created.id}/comments`, {
  token: tokens.employee,
  expect: 400,
  body: {
    body: 'Let me choose who wrote this.',
    author_id: '9',
    created_at: '2020-01-01T00:00:00Z',
  },
});
await call('comment-internal-by-employee', 'POST', `/requests/${created.id}/comments`, {
  token: tokens.employee,
  expect: 403,
  body: { body: 'An employee cannot write an internal note.', visibility: 'internal' },
});
await call('comment-public', 'POST', `/requests/${created.id}/comments`, {
  token: tokens.employee,
  expect: 201,
  body: { body: 'The boot loop came back this morning after the second reboot.' },
});
await call('comment-internal', 'POST', `/requests/${created.id}/comments`, {
  token: tokens.agent,
  expect: 201,
  body: {
    body: 'Vendor RMA 4471 is open; the replacement part ships Thursday.',
    visibility: 'internal',
  },
});

// --- lifecycle --------------------------------------------------------------
await call('patch-priority-by-manager', 'PATCH', `/requests/${created.id}`, {
  token: tokens.manager,
  expect: 200,
  body: { priority: 'critical', reason: 'Client demo is blocked; escalated per the account plan' },
});
const started = data(
  await call('start', 'POST', `/requests/${created.id}/start`, {
    token: tokens.agent,
    expect: 200,
    body: {},
  }),
);
await call('claim-assigned-illegal', 'POST', `/requests/${started.id}/claim`, {
  token: tokens.agent,
  expect: 409,
  body: {},
});
await call('hold', 'POST', `/requests/${started.id}/hold`, {
  token: tokens.agent,
  expect: 200,
  body: { reason: 'Waiting for the vendor to ship the part' },
});
await call('hold-without-reason', 'POST', `/requests/${started.id}/hold`, {
  token: tokens.agent,
  expect: 400,
  body: { reason: 'short' },
});
await call('resume', 'POST', `/requests/${started.id}/resume`, {
  token: tokens.agent,
  expect: 200,
  body: {},
});
await call('resolve-short-note', 'POST', `/requests/${started.id}/resolve`, {
  token: tokens.agent,
  expect: 400,
  body: { resolution_note: 'Done', reason: 'Blocked from the client demo rehearsal' },
});
const resolved = data(
  await call('resolve', 'POST', `/requests/${started.id}/resolve`, {
    token: tokens.agent,
    expect: 200,
    body: {
      resolution_note: 'Replaced the failed SSD and re-imaged from the golden build.',
      reason: 'Blocked from the client demo rehearsal',
    },
  }),
);
await call('close', 'POST', `/requests/${resolved.id}/close`, {
  token: tokens.employee,
  expect: 200,
  body: {},
});
await call('staff-close-forbidden', 'POST', `/requests/${resolved.id}/reopen`, {
  token: tokens.agent,
  expect: 403,
  body: { reason: 'Not the requester' },
});
const reopened = data(
  await call('reopen', 'POST', `/requests/${resolved.id}/reopen`, {
    token: tokens.employee,
    expect: 200,
    body: { reason: 'The same fault returned the next morning' },
  }),
);
console.log(`    reopened status=${reopened.status} assignee=${reopened.assignee?.full_name}`);
const finalised = data(
  await call('transition-generic', 'POST', `/requests/${reopened.id}/transition`, {
    token: tokens.agent,
    expect: 200,
    body: {
      action: 'resolve',
      resolution_note: 'Seated the SSD and re-ran the firmware update; the boot loop is gone.',
      reason: 'Second attempt after the reopen',
    },
  }),
);
await call('close-again', 'POST', `/requests/${finalised.id}/close`, {
  token: tokens.employee,
  expect: 200,
  body: { reason: 'Verified working over two days' },
});
await call('cancel-closed-illegal', 'POST', `/requests/${finalised.id}/cancel`, {
  token: tokens.employee,
  expect: 409,
  body: { reason: 'The ticket is already closed' },
});
// BR-8: the requester may still speak after closure, and the flag is derived, never supplied.
await call('comment-post-closure', 'POST', `/requests/${finalised.id}/comments`, {
  token: tokens.employee,
  expect: 201,
  body: { body: 'Confirmed stable over two days of normal use. Thank you.' },
});

// --- history ----------------------------------------------------------------
await call('events', 'GET', `/requests/${resolved.id}/events?limit=50`, {
  token: tokens.employee,
  expect: 200,
});
// Same ticket, same query, staff identity: the requester's trail is missing the internal note's
// `comment_added` marker, because that marker is the note's metadata (docs/api-specification.md §7).
await call('events-staff', 'GET', `/requests/${resolved.id}/events?limit=50`, {
  token: tokens.manager,
  expect: 200,
});
await call('events-over-limit', 'GET', `/requests/${resolved.id}/events?limit=5000`, {
  token: tokens.employee,
  expect: 400,
});
await call('events-anonymous', 'GET', `/requests/${resolved.id}/events`, { expect: 401 });

// --- thread & activity timeline ---------------------------------------------
// Same request, two callers: the internal note must be absent from the employee's payload entirely,
// `total` included, because the visibility filter lives in the SQL and not after it.
await call('thread-employee', 'GET', `/requests/${created.id}/comments`, {
  token: tokens.employee,
  expect: 200,
});
await call('thread-agent', 'GET', `/requests/${created.id}/comments`, {
  token: tokens.agent,
  expect: 200,
});
await call('thread-paged', 'GET', `/requests/${created.id}/comments?page=2&page_size=2`, {
  token: tokens.manager,
  expect: 200,
});
await call('thread-other-request', 'GET', '/requests/999999/comments', {
  token: tokens.employee,
  expect: 404,
});
await call('thread-anonymous', 'GET', `/requests/${created.id}/comments`, { expect: 401 });
await call('timeline-employee', 'GET', `/requests/${created.id}/timeline?limit=50`, {
  token: tokens.employee,
  expect: 200,
});
await call('timeline-manager', 'GET', `/requests/${created.id}/timeline?limit=50`, {
  token: tokens.manager,
  expect: 200,
});
await call('timeline-over-limit', 'GET', `/requests/${created.id}/timeline?limit=5000`, {
  token: tokens.employee,
  expect: 400,
});
await call('timeline-anonymous', 'GET', `/requests/${created.id}/timeline`, { expect: 401 });
// The audit trail is written and frozen, but deliberately has no read endpoint at all.
await call('audit-logs-not-exposed', 'GET', '/audit-logs', { token: tokens.admin, expect: 404 });

// --- summary ----------------------------------------------------------------
writeFileSync(join(OUT, 'req-index.json'), `${JSON.stringify(log, null, 2)}\n`, 'utf8');
console.log(`\n${log.length} calls recorded in evidence/api-responses/`);
if (mismatches.length > 0) {
  console.log(`\n${mismatches.length} MISMATCHES:`);
  for (const line of mismatches) console.log(`  - ${line}`);
  process.exitCode = 1;
} else {
  console.log('all statuses matched the expectations');
}
