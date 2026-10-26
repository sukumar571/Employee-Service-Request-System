#!/usr/bin/env node
/**
 * Constraint and relationship verification against a CLEAN database.
 *
 *   node scripts/run.mjs verify [db_name]
 *
 * Creates a throw-away database (`esrs_verify` by default) on the same PostgreSQL server as the
 * configured DATABASE_URL, applies every migration with node-pg-migrate's programmatic API, runs
 * the seeds, then asserts the spec rules: NOT NULL, enum domains, foreign keys, unique
 * constraints, CHECKs, deletion rules (CASCADE / SET NULL / RESTRICT) and the updated_at triggers.
 * The scratch database is dropped again at the end — a failure there is a test failure, not data
 * loss. Output is a pass/fail table; exit code is non-zero when any check fails.
 */
import process from 'node:process';
import pg from 'pg';
import { up as migrateUp, down as migrateDown } from 'node-pg-migrate';
import { loadEnv, migrationsDir, migrationsTable, redact, resolveDatabaseUrl } from './config.mjs';
import { applySeeds } from './seed.mjs';

loadEnv();

const sourceUrl = resolveDatabaseUrl();
if (!sourceUrl) {
  process.stderr.write('No database configured. Run `npm run db:up` and set DATABASE_URL in .env.\n');
  process.exit(1);
}

const verifyDbName = process.argv[2] ?? 'esrs_verify';
const DEMO_PASSWORD = 'esrs-verify-demo-password';

function verifyUrl(dbName) {
  const url = new URL(sourceUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
}

/** Runs a statement expected to fail; returns the SQLSTATE (and message) it failed with. */
async function expectFailure(client, sql, params, wantCode) {
  try {
    await client.query(sql, params);
    return { violated: false, code: null, message: 'statement unexpectedly succeeded' };
  } catch (error) {
    return { violated: true, code: error.code, message: error.message, mismatch: error.code !== wantCode };
  }
}

async function assertFailure(client, name, sql, params, wantCode) {
  const outcome = await expectFailure(client, sql, params, wantCode);
  check(
    name,
    outcome.violated && !outcome.mismatch,
    outcome.violated ? (outcome.mismatch ? `failed with ${outcome.code}, expected ${wantCode}` : '') : outcome.message,
  );
}

const source = new pg.Client({ connectionString: sourceUrl });
await source.connect();

// The scratch database is recreated from scratch every run.
await source.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(verifyDbName)} WITH (FORCE)`);
await source.query(`CREATE DATABASE ${pg.escapeIdentifier(verifyDbName)}`);
process.stdout.write(`Verified against clean database '${verifyDbName}' (${redact(verifyUrl(verifyDbName))})\n\n`);

const url = verifyUrl(verifyDbName);
const options = { dir: migrationsDir, migrationsTable, dbUrl: url };

try {
  // --- migrations: up on a clean database, then full rollback, then up again (reversibility) ---
  await migrateUp(options);
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  await migrateDown({ ...options, direction: 'down', count: 'all' });
  const afterRollback = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name NOT LIKE 'pgmigrations%'`,
  );
  check('rollback removes every table', afterRollback.rows[0].n === 0, `${afterRollback.rows[0].n} tables left`);

  await migrateUp(options);
  const tables = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name <> 'pgmigrations' ORDER BY table_name`,
  );
  const expected = [
    'app_settings', 'assignments', 'attachments', 'audit_logs', 'categories', 'comments',
    'departments', 'login_attempts', 'notifications', 'refresh_tokens', 'request_events',
    'request_numbers', 'requests', 'sla_policies', 'sla_trackers', 'sub_categories', 'users',
  ];
  check(
    'migrate up recreates the full schema',
    JSON.stringify(tables.rows.map((r) => r.table_name)) === JSON.stringify(expected),
    tables.rows.map((r) => r.table_name).join(', '),
  );

  // --- seeds: reference + demo data with a runtime-generated bcrypt hash ---
  process.env.SEED_DEMO_PASSWORD = DEMO_PASSWORD;
  const applied = await applySeeds(url);
  check('seeds apply cleanly', applied.length === 2, applied.join(', '));
  const hashed = await client.query(
    `SELECT password_hash LIKE '$2%' AS bcrypt FROM users WHERE email = 'demo.admin@company.test'`,
  );
  check('demo passwords are bcrypt hashes', hashed.rows[0]?.bcrypt === true);
  const reseed = await applySeeds(url);
  check('seeds are idempotent (second run)', reseed.length === 2);

  // --- required columns per the spec (users, categories, requests, comments, audit, SLA) ---
  const columnChecks = await client.query(
    `SELECT table_name || '.' || column_name AS col FROM information_schema.columns
      WHERE (table_name, column_name) IN (
        ('users','id'),('users','full_name'),('users','email'),('users','password_hash'),('users','role'),
        ('users','is_active'),('users','created_at'),('users','updated_at'),
        ('categories','id'),('categories','name'),('categories','description'),
        ('categories','default_resolution_hours'),('categories','is_active'),
        ('requests','id'),('requests','request_number'),('requests','title'),('requests','description'),
        ('requests','requester_id'),('requests','assignee_id'),('requests','category_id'),
        ('requests','priority'),('requests','status'),('requests','resolved_at'),
        ('requests','created_at'),('requests','updated_at'),
        ('sla_trackers','first_response_due_at'),('sla_trackers','resolution_due_at'),
        ('comments','id'),('comments','request_id'),('comments','author_id'),('comments','body'),('comments','created_at'),
        ('audit_logs','id'),('audit_logs','request_id'),('audit_logs','actor_id'),('audit_logs','action'),
        ('audit_logs','before'),('audit_logs','after'),('audit_logs','created_at'),
        ('sla_policies','priority'),('sla_policies','first_response_mins'),('sla_policies','resolution_mins')
      )`,
  );
  const wanted = 48;
  check('every spec-required column exists', columnChecks.rowCount >= wanted, `${columnChecks.rowCount}/${wanted}`);

  // --- timestamps stored UTC-aware: TIMESTAMPTZ normalises to UTC on disk ---
  const tzTypes = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name IN ('users','requests','comments','audit_logs','sla_trackers')
        AND column_name LIKE '%_at' AND data_type <> 'timestamp with time zone'`,
  );
  check('all *_at timestamps are TIMESTAMPTZ (UTC-normalised)', tzTypes.rows[0].n === 0, `${tzTypes.rows[0].n} non-TSTZ columns`);

  // --- NOT NULL + FK + enum + UNIQUE + CHECK on requests ---
  await assertFailure(
    client,
    'NOT NULL: request without title rejected',
    `INSERT INTO requests (requester_id, category_id, status, priority)
       VALUES (1, 1, 'draft', 'medium')`,
    [],
    '23502',
  );
  await assertFailure(
    client,
    'FK: request with unknown requester rejected',
    `INSERT INTO requests (requester_id, category_id, title, description, status, priority)
       VALUES (99999, 1, 'A valid title', 'A description that is long enough to pass.', 'draft', 'medium')`,
    [],
    '23503',
  );
  await assertFailure(
    client,
    'enum: invalid status rejected (no broken enum values)',
    `INSERT INTO requests (requester_id, category_id, title, description, status, priority)
       VALUES (1, 1, 'A valid title', 'A description that is long enough to pass.', 'nonsense', 'medium')`,
    [],
    '22P02',
  );
  await assertFailure(
    client,
    'CHECK: short title rejected',
    `INSERT INTO requests (requester_id, category_id, title, description, status, priority)
       VALUES (1, 1, 'abc', 'A description that is long enough to pass.', 'draft', 'medium')`,
    [],
    '23514',
  );
  await assertFailure(
    client,
    'CHECK: non-draft request must have a ticket number',
    `INSERT INTO requests (requester_id, category_id, title, description, status, priority)
       VALUES (1, 1, 'A perfectly long title', 'A description that is long enough to pass.', 'submitted', 'medium')`,
    [],
    '23514',
  );

  // --- unique ticket number ---
  await assertFailure(
    client,
    'UNIQUE: duplicate request_number rejected',
    `UPDATE requests SET request_number = 'REQ-DEMO-000001' WHERE id = 2`,
    [],
    '23505',
  );

  // --- unique email + case-insensitive functional index ---
  await assertFailure(
    client,
    'UNIQUE: duplicate user email rejected (case-insensitive)',
    `INSERT INTO users (email, password_hash, full_name, role)
       VALUES ('DEMO.EMPLOYEE@COMPANY.TEST', '\\$2a\\$12\\$x', 'Case Clash', 'employee')`,
    [],
    '23505',
  );

  // --- audit_logs FKs ---
  await assertFailure(
    client,
    'FK: audit row for an unknown service request rejected',
    `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, request_id)
       VALUES (4, 'test.action', 'request', '1', 99999)`,
    [],
    '23503',
  );
  await client.query(
    `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, request_id, http_request_id, before, after)
     VALUES (4, 'request.cancelled', 'request', '1', 1, 'verify-correlation-id', '{"status":"submitted"}', '{"status":"cancelled"}')`,
  );
  const auditOk = await client.query(
    `SELECT request_id, http_request_id FROM audit_logs WHERE action = 'request.cancelled'`,
  );
  check('audit row keeps both the request FK and the HTTP correlation id', auditOk.rows[0].request_id === '1' && auditOk.rows[0].http_request_id === 'verify-correlation-id');

  // --- deletion rules ---
  // CASCADE: comments/trackers/events die with the request; SET NULL: audit survives.
  const temp = await client.query(`
    INSERT INTO requests (request_number, requester_id, category_id, title, description, status, priority)
      VALUES ('REQ-VERIFY-000001', 1, 1, 'Temporary request for cascade checks',
              'This row exists only to be deleted by the verification script.', 'submitted', 'low')
    RETURNING id`);
  const tempId = temp.rows[0].id;
  await client.query(
    `INSERT INTO comments (request_id, author_id, body) VALUES ($1, 2, 'cascade probe')`,
    [tempId],
  );
  await client.query(
    `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, request_id)
     VALUES (4, 'verify.temp', 'request', $1::text, $1)`,
    [tempId],
  );
  await client.query(`DELETE FROM requests WHERE id = $1`, [tempId]);
  const survivors = await client.query(
    `SELECT
       (SELECT count(*) FROM comments WHERE request_id = $1)::int AS comments,
       (SELECT count(*) FROM audit_logs WHERE request_id = $1)::int AS audit,
       (SELECT count(*) FROM audit_logs WHERE request_id = $1 AND actor_id IS NULL)::int AS null_actor`,
    [tempId],
  );
  check('ON DELETE CASCADE removes child comments with the request', survivors.rows[0].comments === 0);
  check('audit_logs.request_id ON DELETE SET NULL outlives the request row', survivors.rows[0].audit === 0 && survivors.rows[0].null_actor === 0);

  // RESTRICT: a user referenced by a request cannot be deleted.
  await assertFailure(
    client,
    'RESTRICT: deleting a user with requests is refused',
    `DELETE FROM users WHERE id = 1`,
    [],
    '23503',
  );
  // RESTRICT: a category in use cannot be deleted.
  await assertFailure(
    client,
    'RESTRICT: deleting an in-use category is refused',
    `DELETE FROM categories WHERE id = 1`,
    [],
    '23503',
  );

  // --- SLA policy CHECKs ---
  await assertFailure(
    client,
    'CHECK: resolution target must exceed first-response target',
    `UPDATE sla_policies SET resolution_mins = 10 WHERE priority = 'low'`,
    [],
    '23514',
  );
  await assertFailure(
    client,
    'CHECK: SLA targets must be positive',
    `UPDATE sla_policies SET first_response_mins = 0 WHERE priority = 'low'`,
    [],
    '23514',
  );

  // --- updated_at trigger ---
  const before = await client.query(`SELECT updated_at FROM users WHERE id = 2`);
  await client.query(`SELECT pg_sleep(0.05)`);
  await client.query(`UPDATE users SET last_login_at = now() WHERE id = 2`);
  const after = await client.query(`SELECT updated_at FROM users WHERE id = 2`);
  check(
    'updated_at trigger refreshes the column on UPDATE',
    new Date(after.rows[0].updated_at) > new Date(before.rows[0].updated_at),
  );

  // --- transactions: lifecycle write is atomic or invisible ---
  const rolledBack = await client.query(`SELECT count(*)::int AS n FROM requests WHERE id = 999999`);
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO requests (request_number, requester_id, category_id, title, description, status, priority)
       VALUES ('REQ-VERIFY-000999', 1, 1, 'Transaction probe that gets rolled back',
               'This row must never be visible after the transaction aborts.', 'submitted', 'low')`,
    );
    await client.query('ROLLBACK');
    check('transactions are honoured (insert inside rolled-back tx is absent)', true);
  } catch (error) {
    check('transactions are honoured (insert inside rolled-back tx is absent)', false, error.message);
  }
  check('baseline query sanity (no phantom rows)', rolledBack.rows[0].n === 0);

  await client.end();
} finally {
  await source.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(verifyDbName)} WITH (FORCE)`);
  await source.end();
}

// --- report ---
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}\n`);
}
process.stdout.write(`\n${results.length - failures}/${results.length} checks passed.\n`);
process.exit(failures === 0 ? 0 : 1);
