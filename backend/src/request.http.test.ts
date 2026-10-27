import {
  apiErrorBodySchema,
  COMMENT_BODY_MAX,
  commentListResponseSchema,
  commentResponseSchema,
  requestDetailResponseSchema,
  requestEventListResponseSchema,
  requestListResponseSchema,
  requestTimelineListResponseSchema,
  type CommentDto,
  type RequestDetail,
} from '@esrs/shared';
import type { Express, RequestHandler } from 'express';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config/env.js';
import { createDatabase, type Database } from './db/pool.js';
import { FixedClock } from './domain/ports/clock.js';
import { createSilentLogger } from './lib/logger.js';
import { InMemoryUserRepository } from './modules/auth/user.repository.memory.js';
import type { UserRecord } from './modules/auth/user.repository.js';
import { InMemoryRequestRepository } from './modules/request/request.repository.memory.js';
import type { TaxonomySeed } from './modules/request/request.repository.memory.js';
import {
  mapDatabaseError,
  PostgresRequestRepository,
} from './modules/request/request.repository.pg.js';
import type { RequestRepository } from './modules/request/request.repository.js';
import { RecordingAuditSink } from './ports/audit.js';

/**
 * Integration tests for the service-request API (docs/test-plan.md §3–§4).
 *
 * These drive the real Express app over HTTP — middleware chain, Zod boundary, RBAC gate, service
 * rules, repository write semantics. Identity comes from a test-only middleware so the permission
 * matrix can be exercised without minting tokens; the JWT gate itself is covered by
 * `auth.http.test.ts`. The in-memory repository is used because it implements the same scope,
 * filter, version and multi-record-write semantics as the Postgres adapter; the database-failure
 * cases swap in a deliberately broken adapter to prove SQLSTATE translation reaches the wire.
 */

const API = '/api/v1';
const START = new Date('2026-10-26T10:00:00Z');

const EMPLOYEE = '10';
const COLLEAGUE = '11';
const AGENT_IT = '20';
const AGENT_IT_SECOND = '23';
const AGENT_FACILITIES = '21';
const AGENT_INACTIVE = '22';
const MANAGER = '30';
const ADMIN = '40';

const TITLE = 'Laptop will not boot after Tuesday patch';
const DESCRIPTION =
  'My laptop loops at the vendor logo after the patch. I need it working before the client demo on Friday.';
const REASON = 'Blocked from the client demo rehearsal';
const NOTE = 'Replaced the failed SSD and re-imaged from the golden build.';

const ROSTER: UserRecord[] = (
  [
    ['10', 'ade@corp.example', 'employee', null, '1', true],
    ['11', 'bern@corp.example', 'employee', null, '1', true],
    ['20', 'carl@corp.example', 'agent', '1', '1', true],
    ['21', 'dina@corp.example', 'agent', '3', '1', true],
    ['23', 'hugo@corp.example', 'agent', '1', '1', true],
    ['22', 'evan@corp.example', 'agent', '1', '1', false],
    ['30', 'fred@corp.example', 'manager', null, '1', true],
    ['40', 'gina@corp.example', 'admin', null, '1', true],
  ] as const
).map(([id, email, role, teamCategoryId, departmentId, isActive]) => ({
  id,
  email,
  passwordHash: 'not-used-by-this-suite',
  fullName: email.split('@')[0] ?? 'User',
  role,
  teamCategoryId,
  departmentId,
  isActive,
  mustChangePassword: false,
  failedLoginCount: 0,
  lockedUntil: null,
  lastLoginAt: null,
}));

/** Names real taxonomy ids instead of relying on the adapter's own seed, and adds the dead ones. */
const TAXONOMY: TaxonomySeed = {
  categories: [
    { id: '1', name: 'IT', isActive: true },
    { id: '2', name: 'Human Resources', isActive: true },
    { id: '3', name: 'Facilities', isActive: true },
    { id: '9', name: 'Archived', isActive: false },
  ],
  subCategories: [
    { id: '11', name: 'Network & VPN', categoryId: '1', isActive: true },
    { id: '12', name: 'Hardware', categoryId: '1', isActive: true },
    { id: '31', name: 'Office Access', categoryId: '3', isActive: true },
  ],
  departments: [
    { id: '1', name: 'Engineering', isActive: true },
    { id: '2', name: 'People Ops', isActive: true },
    { id: '3', name: 'Operations', isActive: false },
  ],
};

interface Harness {
  readonly app: Express;
  readonly clock: FixedClock;
  readonly audit: RecordingAuditSink;
}

/**
 * Test-only identity gate. The header names a subject; the role always comes from the seeded roster,
 * never from anything the client controls (docs/security-plan.md §4).
 */
function identityFromRoster(): RequestHandler {
  return (req, _res, next) => {
    const seeded = ROSTER.find((candidate) => candidate.id === req.header('x-test-user'));
    if (seeded) {
      req.auth = { userId: seeded.id, role: seeded.role, teamCategoryId: seeded.teamCategoryId };
    }
    next();
  };
}

function harness(options: { repository?: RequestRepository } = {}): Harness {
  const clock = new FixedClock(START);
  const audit = new RecordingAuditSink();
  const users = new InMemoryUserRepository(ROSTER);

  const built = createApp({
    config: loadConfig({ NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:5173' }),
    logger: createSilentLogger(),
    database: createDatabase(),
    clock,
    audit,
    userRepository: users,
    // The same sink is handed to the app *and* to the request repository: in memory mode the
    // repository is what runs the transaction, so it is what stamps the audit rows.
    requestRepository:
      options.repository ??
      new InMemoryRequestRepository({ clock, directory: users, taxonomy: TAXONOMY, audit }),
    identity: identityFromRoster(),
  });

  return { app: built.app, clock, audit };
}

const as = (userId: string) => ({ 'x-test-user': userId });

type Verb = 'get' | 'post' | 'patch';

/** Verb + path + acting user + body, in the order the tests read best. */
function send(app: Express, verb: Verb, path: string, actor?: string, body?: object) {
  const chain = request(app)[verb](`${API}${path}`);
  if (actor) chain.set(as(actor));
  // A GET body is not a thing the contract defines, and supertest would only be confused by one.
  if (body !== undefined && verb !== 'get') chain.send(body);
  return chain;
}

/** Creates a submitted ticket through the API and returns the parsed detail. */
async function create(
  app: Express,
  actor: string,
  overrides: Record<string, unknown> = {},
): Promise<RequestDetail> {
  const response = await send(app, 'post', '/requests', actor, {
    title: TITLE,
    description: DESCRIPTION,
    category_id: '1',
    ...overrides,
  });
  if (response.status !== 201) {
    throw new Error(`create failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return requestDetailResponseSchema.parse(response.body).data;
}

function detailOf(response: { body: unknown }): RequestDetail {
  return requestDetailResponseSchema.parse(response.body).data;
}

function idsOf(response: { body: unknown }): string[] {
  return requestListResponseSchema.parse(response.body).data.map((row) => row.id);
}

function totalOf(response: { body: unknown }): number {
  return requestListResponseSchema.parse(response.body).meta.total;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

describe('POST /requests — creation', () => {
  it('runs the full submit pipeline: number, SLA clock, allowed actions, ETag and audit', async () => {
    const { app, audit } = harness();
    const response = await send(app, 'post', '/requests', EMPLOYEE, {
      title: TITLE,
      description: DESCRIPTION,
      category_id: '1',
      sub_category_id: '12',
      priority: 'high',
    });

    expect(response.status).toBe(201);
    const ticket = detailOf(response);
    expect(ticket).toMatchObject({
      status: 'submitted',
      priority: 'high',
      title: TITLE,
      request_number: 'REQ-2026-000001',
      requester: { id: EMPLOYEE, full_name: 'ade' },
      assignee: null,
      category: { id: '1', name: 'IT' },
      sub_category: { id: '12', name: 'Hardware' },
      // The requester's own department is snapshotted onto the ticket (docs/database-design.md §2.3).
      department: { id: '1', name: 'Engineering' },
      reopen_count: 0,
    });
    expect(ticket.sla?.resolution_due_at).not.toBeNull();
    expect(ticket.allowed_actions).toEqual(['cancel']);
    expect(response.headers.etag).toBe(`"${ticket.version}"`);

    expect(audit.entries.at(-1)).toMatchObject({
      actorId: EMPLOYEE,
      actorRole: 'employee',
      action: 'request.submitted',
      entityType: 'request',
      serviceRequestId: ticket.id,
    });
  });

  it('allocates gapless numbers, and does not burn one on a draft', async () => {
    const { app } = harness();
    expect((await create(app, EMPLOYEE)).request_number).toBe('REQ-2026-000001');
    expect((await create(app, COLLEAGUE)).request_number).toBe('REQ-2026-000002');
    expect((await create(app, EMPLOYEE, { draft: true })).request_number).toBeNull();
    expect((await create(app, EMPLOYEE)).request_number).toBe('REQ-2026-000003');
  });

  it('saves a draft with no number and no SLA clock', async () => {
    const { app } = harness();
    const draft = await create(app, EMPLOYEE, { draft: true });
    expect(draft).toMatchObject({ status: 'draft', request_number: null, sla: null });
    expect(draft.allowed_actions).toEqual(['submit', 'cancel']);
  });

  it('rejects a title below the minimum length with field-level detail', async () => {
    const { app } = harness();
    const response = await send(app, 'post', '/requests', EMPLOYEE, {
      title: 'help',
      description: DESCRIPTION,
      category_id: '1',
    });
    expect(response.status).toBe(400);
    expect(apiErrorBodySchema.parse(response.body).error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details).toEqual([expect.objectContaining({ path: 'title' })]);
  });

  it('rejects an unknown category and a sub-category from the wrong category', async () => {
    const { app } = harness();
    const unknown = await send(app, 'post', '/requests', EMPLOYEE, {
      title: TITLE,
      description: DESCRIPTION,
      category_id: '404',
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details).toEqual([expect.objectContaining({ path: 'category_id' })]);

    const mismatched = await send(app, 'post', '/requests', EMPLOYEE, {
      title: TITLE,
      description: DESCRIPTION,
      category_id: '1',
      sub_category_id: '31',
    });
    expect(mismatched.status).toBe(400);
    expect(mismatched.body.error.details).toEqual([
      expect.objectContaining({ path: 'sub_category_id' }),
    ]);
  });

  it('rejects a deactivated category and a deactivated department', async () => {
    const { app } = harness();
    const category = await send(app, 'post', '/requests', EMPLOYEE, {
      title: TITLE,
      description: DESCRIPTION,
      category_id: '9',
    });
    expect(category.status).toBe(400);
    expect(category.body.error.details).toEqual([expect.objectContaining({ path: 'category_id' })]);

    const department = await send(app, 'post', '/requests', EMPLOYEE, {
      title: TITLE,
      description: DESCRIPTION,
      category_id: '1',
      department_id: '3',
    });
    expect(department.status).toBe(400);
    expect(department.body.error.details).toEqual([
      expect.objectContaining({ path: 'department_id' }),
    ]);
  });

  it.each([
    ['status', 'closed'],
    ['assignee_id', AGENT_IT],
    ['request_number', 'REQ-2026-999999'],
    ['version', 42],
    ['resolution_note', 'employee-authored closure'],
  ])('refuses the protected workflow field %s on creation', async (field, value) => {
    const { app } = harness();
    const response = await send(app, 'post', '/requests', EMPLOYEE, {
      title: TITLE,
      description: DESCRIPTION,
      category_id: '1',
      [field]: value,
    });
    // `.strict()` turns an impossible field into a 400 that names the key, not a silently dropped one.
    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([expect.objectContaining({ path: field })]);
  });

  it('rejects a non-numeric identifier instead of coercing it', async () => {
    const { app } = harness();
    const response = await send(app, 'post', '/requests', EMPLOYEE, {
      title: TITLE,
      description: DESCRIPTION,
      category_id: 'not-a-number',
    });
    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([expect.objectContaining({ path: 'category_id' })]);
  });

  it('rejects an unknown priority rather than inventing one', async () => {
    const { app } = harness();
    const response = await send(app, 'post', '/requests', EMPLOYEE, {
      title: TITLE,
      description: DESCRIPTION,
      category_id: '1',
      priority: 'urgent',
    });
    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([expect.objectContaining({ path: 'priority' })]);
  });

  it('defaults to a submitted medium-priority request', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    expect(ticket).toMatchObject({ status: 'submitted', priority: 'medium' });
  });
});

// ---------------------------------------------------------------------------
// Retrieval and row scope
// ---------------------------------------------------------------------------

describe('GET /requests — retrieval and row scope', () => {
  it('returns only the employee’s own rows', async () => {
    const { app } = harness();
    const mine = await create(app, EMPLOYEE);
    await create(app, COLLEAGUE);

    const response = await send(app, 'get', '/requests', EMPLOYEE);
    expect(response.status).toBe(200);
    expect(requestListResponseSchema.parse(response.body).meta).toEqual({
      page: 1,
      page_size: 20,
      total: 1,
    });
    expect(idsOf(response)).toEqual([mine.id]);
  });

  it('hides another employee’s ticket as a 404, not a 403, so ids cannot be probed', async () => {
    const { app } = harness();
    const theirs = await create(app, COLLEAGUE);
    const response = await send(app, 'get', `/requests/${theirs.id}`, EMPLOYEE);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('lets an agent see their own team’s queue but not another team’s', async () => {
    const { app } = harness();
    const itTicket = await create(app, COLLEAGUE, { category_id: '1' });
    const facilitiesTicket = await create(app, COLLEAGUE, {
      category_id: '3',
      title: 'Badge reader on floor four is offline',
      description:
        'The badge reader at the floor-four fire door does not respond. Facilities to fix.',
    });

    const itAgent = await send(app, 'get', `/requests/${itTicket.id}`, AGENT_IT);
    expect(itAgent.status).toBe(200);
    // Neither requester nor holder yet, so the honest surface is exactly one action.
    expect(itAgent.body.data.allowed_actions).toEqual(['claim']);

    expect((await send(app, 'get', `/requests/${facilitiesTicket.id}`, AGENT_IT)).status).toBe(404);
    expect(
      (await send(app, 'get', `/requests/${facilitiesTicket.id}`, AGENT_FACILITIES)).status,
    ).toBe(200);
  });

  it('gives a manager every team’s ticket but still not another author’s draft', async () => {
    const { app } = harness();
    const draft = await create(app, COLLEAGUE, { draft: true });
    const submitted = await create(app, COLLEAGUE);

    expect((await send(app, 'get', `/requests/${submitted.id}`, MANAGER)).status).toBe(200);
    expect((await send(app, 'get', `/requests/${draft.id}`, MANAGER)).status).toBe(404);
    expect(totalOf(await send(app, 'get', '/requests', ADMIN))).toBe(1);
  });

  it('keeps full-text out of the queue projection', async () => {
    const { app } = harness();
    await create(app, EMPLOYEE);
    const response = await send(app, 'get', '/requests', EMPLOYEE);
    expect(response.body.data[0]).not.toHaveProperty('description');
    expect(JSON.stringify(response.body)).not.toContain(DESCRIPTION);
  });

  it('serves the append-only lifecycle trail', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    await send(app, 'post', `/requests/${ticket.id}/claim`, AGENT_IT, {});
    await send(app, 'post', `/requests/${ticket.id}/resolve`, AGENT_IT, {
      resolution_note: NOTE,
      reason: REASON,
    });

    const response = await send(app, 'get', `/requests/${ticket.id}/events`, EMPLOYEE);
    expect(response.status).toBe(200);
    const events = requestEventListResponseSchema.parse(response.body).data;
    expect(events.map((row) => row.event_type)).toEqual([
      'created',
      'submitted',
      'claimed',
      'resolved',
    ]);
    expect(events[2]).toMatchObject({
      actor: { id: AGENT_IT, full_name: 'carl' },
      actor_role: 'agent',
      from_status: 'submitted',
      to_status: 'assigned',
    });
  });

  it('bounds the history feed with the contract’s limit', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    expect((await send(app, 'get', `/requests/${ticket.id}/events?limit=2`, EMPLOYEE)).status).toBe(
      200,
    );
    expect(
      (await send(app, 'get', `/requests/${ticket.id}/events?limit=5000`, EMPLOYEE)).status,
    ).toBe(400);
  });

  /**
   * The visibility rule of §7 applies to the lifecycle trail as well, because a `comment_added` marker
   * is not a lifecycle fact: it is a comment's metadata — that a note exists, who left it, how long it
   * was. Serving it to the requester would disclose the staff-only note they cannot read.
   */
  it('hides an internal note’s marker from the requester in the lifecycle trail too', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    await send(app, 'post', `/requests/${ticket.id}/claim`, AGENT_IT, {});
    await send(app, 'post', `/requests/${ticket.id}/comments`, AGENT_IT, {
      body: 'Do not tell the user yet: the whole SSD batch is faulty.',
      visibility: 'internal',
    });

    const mine = requestEventListResponseSchema.parse(
      (await send(app, 'get', `/requests/${ticket.id}/events`, EMPLOYEE)).body,
    ).data;
    expect(mine.map((row) => row.event_type)).toEqual(['created', 'submitted', 'claimed']);

    const staff = requestEventListResponseSchema.parse(
      (await send(app, 'get', `/requests/${ticket.id}/events`, MANAGER)).body,
    ).data;
    expect(staff.map((row) => row.event_type)).toEqual([
      'created',
      'submitted',
      'claimed',
      'comment_added',
    ]);
    expect(staff.at(-1)?.detail).toMatchObject({ visibility: 'internal' });
    expect(JSON.stringify(staff)).not.toContain('faulty');
  });

  it('returns the sla state derived from the tracker so a queue can filter on urgency', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE, { priority: 'critical' });
    expect(ticket.sla).toMatchObject({ state: 'safe' });
    expect(totalOf(await send(app, 'get', '/requests?sla=safe', EMPLOYEE))).toBe(1);
    expect(totalOf(await send(app, 'get', '/requests?sla=breached', EMPLOYEE))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Filtering, sorting, pagination, search
// ---------------------------------------------------------------------------

async function seededQueue() {
  const context = harness();
  const ids = {
    criticalHardware: (
      await create(context.app, EMPLOYEE, { priority: 'critical', sub_category_id: '12' })
    ).id,
    lowNetwork: (
      await create(context.app, EMPLOYEE, {
        priority: 'low',
        title: 'VPN certificate expires every morning',
        sub_category_id: '11',
      })
    ).id,
    hrTicket: (
      await create(context.app, EMPLOYEE, {
        category_id: '2',
        title: 'Payslip for September is missing the overtime line',
        description: 'The September payslip omits the overtime hours I worked. Please restate it.',
      })
    ).id,
    draft: (await create(context.app, EMPLOYEE, { draft: true })).id,
  };
  return { ...context, ids };
}

describe('GET /requests — filtering, sorting, pagination and search', () => {
  it('filters by one status, by a CSV list and by a repeated key', async () => {
    const { app, ids } = await seededQueue();
    expect(idsOf(await send(app, 'get', '/requests?status=draft', EMPLOYEE))).toEqual([ids.draft]);
    expect(totalOf(await send(app, 'get', '/requests?status=draft,submitted', EMPLOYEE))).toBe(4);
    expect(
      totalOf(await send(app, 'get', '/requests?status=submitted&status=draft', EMPLOYEE)),
    ).toBe(4);
  });

  it('rejects an unknown filter value instead of quietly ignoring the filter', async () => {
    const { app } = await seededQueue();
    const response = await send(app, 'get', '/requests?status=pending', EMPLOYEE);
    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([
      expect.objectContaining({ path: expect.stringMatching(/^status/) }),
    ]);
  });

  it('rejects a bracketed filter object instead of stringifying it', async () => {
    const { app } = await seededQueue();
    // `?status[0]=draft` reaches the server as an object, which can never name an enum value; the old
    // `String(value)` would have compared `[object Object]` against the enum and called that validation.
    const response = await send(app, 'get', '/requests?status%5B0%5D=draft', EMPLOYEE);
    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([
      expect.objectContaining({ path: expect.stringMatching(/^status/) }),
    ]);
  });

  it('filters by priority, category, sub-category, requester and free text', async () => {
    const { app, ids } = await seededQueue();
    // Deterministic order regardless of the frozen clock: always ask for id ascending.
    const only = async (query: string, expected: string[]) => {
      const response = await send(app, 'get', `/requests?${query}&sort=id&direction=asc`, EMPLOYEE);
      expect(idsOf(response), query).toEqual(expected);
    };

    await only('priority=critical', [ids.criticalHardware]);
    await only('priority=low,critical', [ids.criticalHardware, ids.lowNetwork]);
    await only('category_id=2', [ids.hrTicket]);
    await only('sub_category_id=11', [ids.lowNetwork]);
    await only('department_id=1', [ids.criticalHardware, ids.lowNetwork, ids.hrTicket, ids.draft]);
    await only('requester_id=11', []);
    await only('q=payslip', [ids.hrTicket]);
    await only('q=REQ-2026-000002', [ids.lowNetwork]);
    await only('assignee_id=unassigned', [
      ids.criticalHardware,
      ids.lowNetwork,
      ids.hrTicket,
      ids.draft,
    ]);
    await only('status=submitted&priority=critical', [ids.criticalHardware]);
  });

  it('resolves assignee_id=me to the caller’s own queue', async () => {
    const { app } = harness();
    const mine = await create(app, EMPLOYEE);
    await create(app, COLLEAGUE);
    await send(app, 'post', `/requests/${mine.id}/claim`, AGENT_IT, {});

    const response = await send(app, 'get', '/requests?assignee_id=me', AGENT_IT);
    expect(idsOf(response)).toEqual([mine.id]);
    expect(totalOf(response)).toBe(1);
    expect(requestListResponseSchema.parse(response.body).meta.page_size).toBe(20);
  });

  it('orders by business priority and honours an explicit direction', async () => {
    const { app, ids } = await seededQueue();
    const ascending = await send(
      app,
      'get',
      '/requests?priority=critical,low&sort=priority&direction=asc',
      EMPLOYEE,
    );
    expect(idsOf(ascending)).toEqual([ids.criticalHardware, ids.lowNetwork]);

    const descending = await send(
      app,
      'get',
      '/requests?priority=critical,low&sort=-priority',
      EMPLOYEE,
    );
    expect(idsOf(descending)).toEqual([ids.lowNetwork, ids.criticalHardware]);
  });

  it('defaults date keys to newest-first', async () => {
    const { app } = harness();
    const first = await create(app, EMPLOYEE);
    const second = await create(app, EMPLOYEE, { title: 'Second ticket raised after the first' });
    expect(idsOf(await send(app, 'get', '/requests', EMPLOYEE))).toEqual([second.id, first.id]);

    const oldestFirst = await send(
      app,
      'get',
      '/requests?sort=submitted_at&direction=asc',
      EMPLOYEE,
    );
    expect(idsOf(oldestFirst)).toEqual([first.id, second.id]);
  });

  it('rejects a sort key that is not on the whitelist', async () => {
    const { app } = await seededQueue();
    const response = await send(app, 'get', '/requests?sort=description', EMPLOYEE);
    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([expect.objectContaining({ path: 'sort' })]);
  });

  it('paginates with an accurate total and clamps an oversized page size', async () => {
    const { app, ids } = await seededQueue();
    const page = await send(
      app,
      'get',
      '/requests?sort=id&direction=asc&page=2&page_size=2',
      EMPLOYEE,
    );
    expect(requestListResponseSchema.parse(page.body).meta).toEqual({
      page: 2,
      page_size: 2,
      total: 4,
    });
    expect(idsOf(page)).toEqual([ids.hrTicket, ids.draft]);

    // An oversized `page_size` is a UI accident, so the contract clamps it instead of rejecting it.
    const oversized = await send(app, 'get', '/requests?page_size=5000', EMPLOYEE);
    expect(oversized.status).toBe(200);
    expect(requestListResponseSchema.parse(oversized.body).meta.page_size).toBe(100);

    const beyond = await send(app, 'get', '/requests?page=9', EMPLOYEE);
    expect(idsOf(beyond)).toEqual([]);
    expect(totalOf(beyond)).toBe(4);
  });

  it('treats a search string as a literal, not a wildcard', async () => {
    const { app } = harness();
    await create(app, EMPLOYEE, { title: '100% of the monitors flicker' });
    await create(app, EMPLOYEE, { title: 'Docking station loses the second display' });
    // `%` must not behave like `LIKE '%'`: only the literal title contains it.
    expect(totalOf(await send(app, 'get', '/requests?q=%25', EMPLOYEE))).toBe(1);
  });

  it('refuses an unknown query key instead of ignoring it', async () => {
    const { app } = await seededQueue();
    expect((await send(app, 'get', '/requests?nonexistent=1', EMPLOYEE)).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

describe('PATCH /requests/{id} — editing', () => {
  it('lets the owner rewrite their own draft', async () => {
    const { app } = harness();
    const draft = await create(app, EMPLOYEE, { draft: true });
    const response = await send(app, 'patch', `/requests/${draft.id}`, EMPLOYEE, {
      title: 'Laptop needs a battery replacement before travel',
      sub_category_id: '11',
    });

    expect(response.status).toBe(200);
    const updated = detailOf(response);
    expect(updated.title).toBe('Laptop needs a battery replacement before travel');
    expect(updated.sub_category).toEqual({ id: '11', name: 'Network & VPN' });
    expect(updated.version).toBe(draft.version + 1);
    expect(response.headers.etag).toBe(`"${updated.version}"`);
  });

  it('refuses to edit a ticket that is no longer a draft', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    const response = await send(app, 'patch', `/requests/${ticket.id}`, EMPLOYEE, {
      title: 'Rewriting a submitted ticket',
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');
  });

  it('answers 404 when a colleague tries to edit someone else’s draft', async () => {
    const { app } = harness();
    const draft = await create(app, EMPLOYEE, { draft: true });
    const response = await send(app, 'patch', `/requests/${draft.id}`, COLLEAGUE, {
      title: 'Not my ticket at all',
    });
    expect(response.status).toBe(404);
  });

  it('rejects protected workflow fields by name', async () => {
    const { app } = harness();
    const draft = await create(app, EMPLOYEE, { draft: true });
    for (const field of ['status', 'assignee_id', 'request_number', 'version', 'closed_at']) {
      const response = await send(app, 'patch', `/requests/${draft.id}`, EMPLOYEE, {
        [field]: 'x',
      });
      expect(response.status, field).toBe(400);
      // Two issues arrive: the unrecognized key, and the patch that is therefore left empty.
      expect(response.body.error.details, field).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: field }),
          expect.objectContaining({ path: '(root)' }),
        ]),
      );
    }
  });

  it('rejects an empty patch instead of bumping the version for nothing', async () => {
    const { app } = harness();
    const draft = await create(app, EMPLOYEE, { draft: true });
    const response = await send(app, 'patch', `/requests/${draft.id}`, EMPLOYEE, {});
    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([expect.objectContaining({ path: '(root)' })]);
  });

  it('restricts priority changes to managers and above', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);

    for (const actor of [EMPLOYEE, AGENT_IT]) {
      const response = await send(app, 'patch', `/requests/${ticket.id}`, actor, {
        priority: 'critical',
        reason: REASON,
      });
      expect(response.status, actor).toBe(403);
    }

    const withoutReason = await send(app, 'patch', `/requests/${ticket.id}`, MANAGER, {
      priority: 'critical',
    });
    expect(withoutReason.status).toBe(400);
    expect(withoutReason.body.error.details).toEqual([expect.objectContaining({ path: 'reason' })]);

    const byManager = await send(app, 'patch', `/requests/${ticket.id}`, MANAGER, {
      priority: 'critical',
      reason: 'Client demo is blocked; escalated per the account plan',
    });
    expect(byManager.status).toBe(200);
    expect(detailOf(byManager).priority).toBe('critical');
    expect((await send(app, 'get', `/requests/${ticket.id}`, EMPLOYEE)).body.data.priority).toBe(
      'critical',
    );
  });

  it('does not re-stamp the SLA clock when a manager reprioritises (ST-404)', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE, { priority: 'low' });
    const before = ticket.sla?.resolution_due_at;

    const after = detailOf(
      await send(app, 'patch', `/requests/${ticket.id}`, ADMIN, {
        priority: 'critical',
        reason: REASON,
      }),
    );
    expect(after.priority).toBe('critical');
    expect(after.sla?.resolution_due_at).toBe(before);
  });

  it('refuses to reprioritise a closed ticket', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    await send(app, 'post', `/requests/${ticket.id}/claim`, AGENT_IT, {});
    await send(app, 'post', `/requests/${ticket.id}/resolve`, AGENT_IT, {
      resolution_note: NOTE,
      reason: REASON,
    });
    await send(app, 'post', `/requests/${ticket.id}/close`, EMPLOYEE, {});

    const response = await send(app, 'patch', `/requests/${ticket.id}`, MANAGER, {
      priority: 'low',
      reason: REASON,
    });
    expect(response.status).toBe(409);
  });

  it('rejects a stale If-Match with 409 instead of overwriting the newer edit', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    const first = await send(app, 'patch', `/requests/${ticket.id}`, MANAGER, {
      priority: 'high',
      reason: REASON,
    });
    expect(first.status).toBe(200);

    const stale = await request(app)
      .patch(`${API}/requests/${ticket.id}`)
      .set(as(MANAGER))
      .set('If-Match', `"${ticket.version}"`)
      .send({ priority: 'low', reason: REASON });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT');
    expect(stale.body.error.details).toEqual([expect.objectContaining({ path: 'version' })]);
    // The newer value survives the rejected write.
    expect(detailOf(first).priority).toBe('high');
  });

  it('rejects a malformed If-Match rather than silently ignoring the precondition', async () => {
    const { app } = harness();
    const draft = await create(app, EMPLOYEE, { draft: true });
    const response = await request(app)
      .patch(`${API}/requests/${draft.id}`)
      .set(as(EMPLOYEE))
      .set('If-Match', 'not-a-version')
      .send({ title: 'Rewriting with a bad precondition' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

describe('assignment', () => {
  it('keeps assignment out of employee and agent hands', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);

    for (const actor of [EMPLOYEE, AGENT_IT]) {
      const response = await send(app, 'post', `/requests/${ticket.id}/assign`, actor, {
        assignee_id: AGENT_IT,
        reason: REASON,
      });
      expect(response.status, actor).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    }

    // …and the generic endpoint cannot be used to smuggle that action past the route gate.
    const smuggled = await send(app, 'post', `/requests/${ticket.id}/transition`, EMPLOYEE, {
      action: 'assign',
      assignee_id: AGENT_IT,
    });
    expect(smuggled.status).toBe(403);
  });

  it('assigns to a team agent and reports the workload in the audit trail', async () => {
    const { app, audit } = harness();
    const ticket = await create(app, EMPLOYEE);
    const response = await send(app, 'post', `/requests/${ticket.id}/assign`, MANAGER, {
      assignee_id: AGENT_IT,
      reason: 'Carl owns the hardware queue this week',
    });

    expect(response.status).toBe(200);
    const assigned = detailOf(response);
    expect(assigned).toMatchObject({ status: 'assigned', assignee: { id: AGENT_IT } });
    expect(assigned.allowed_actions).toEqual(expect.arrayContaining(['start', 'hold', 'resolve']));

    expect(audit.entries.at(-2)).toMatchObject({
      action: 'request.assign',
      after: { status: 'assigned', assignee_id: AGENT_IT },
    });
    expect(audit.entries.at(-1)).toMatchObject({
      action: 'request.assigned',
      // Counted *before* the transition, so the row can be written inside the same transaction.
      after: { assignee_id: AGENT_IT, assignee_open_tickets_before: 0, reason: expect.any(String) },
    });
  });

  it('lets an agent claim work without a manager', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    const response = await send(app, 'post', `/requests/${ticket.id}/claim`, AGENT_IT, {});

    expect(response.status).toBe(200);
    expect(detailOf(response)).toMatchObject({
      status: 'assigned',
      assignee: { id: AGENT_IT, full_name: 'carl' },
    });
  });

  it.each([
    ['the requester', EMPLOYEE],
    ['an employee-role account', COLLEAGUE],
    ['a deactivated agent', AGENT_INACTIVE],
  ])('refuses to assign to %s', async (_label, target) => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    const response = await send(app, 'post', `/requests/${ticket.id}/assign`, ADMIN, {
      assignee_id: target,
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('INVALID_ASSIGNEE');
  });

  it('refuses an agent from another team and an unknown user id', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);

    const wrongTeam = await send(app, 'post', `/requests/${ticket.id}/assign`, MANAGER, {
      assignee_id: AGENT_FACILITIES,
    });
    expect(wrongTeam.status).toBe(422);
    expect(wrongTeam.body.error.message).toContain('different team');

    const unknown = await send(app, 'post', `/requests/${ticket.id}/assign`, MANAGER, {
      assignee_id: '999999',
    });
    // A bad assignee reads as 422 about the assignee, never as a 404 that confirms user ids.
    expect(unknown.status).toBe(422);
  });

  it('requires an assignee_id on the assign endpoint', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    const response = await send(app, 'post', `/requests/${ticket.id}/assign`, MANAGER, {
      reason: REASON,
    });
    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([expect.objectContaining({ path: 'assignee_id' })]);
  });

  it('leaves the holder in place across resolve and reopen', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    await send(app, 'post', `/requests/${ticket.id}/assign`, MANAGER, { assignee_id: AGENT_IT });

    const resolved = await send(app, 'post', `/requests/${ticket.id}/resolve`, AGENT_IT, {
      resolution_note: NOTE,
      reason: REASON,
    });
    expect(detailOf(resolved).assignee).toEqual({ id: AGENT_IT, full_name: 'carl' });

    const reopened = await send(app, 'post', `/requests/${ticket.id}/reopen`, EMPLOYEE, {
      reason: 'The laptop failed again the next morning',
    });
    expect(reopened.body.data).toMatchObject({ status: 'assigned', reopen_count: 1 });
    expect(reopened.body.data.assignee).toEqual({ id: AGENT_IT, full_name: 'carl' });
    // A reopen must not leave the row stamped as resolved.
    expect(reopened.body.data.resolved_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle legality
// ---------------------------------------------------------------------------

describe('status transitions', () => {
  it('walks the whole documented lifecycle', async () => {
    const { app } = harness();
    const draft = await create(app, EMPLOYEE, { draft: true });

    const submitted = await send(app, 'post', `/requests/${draft.id}/submit`, EMPLOYEE, {});
    expect(submitted.status).toBe(200);
    expect(submitted.body.data).toMatchObject({
      status: 'submitted',
      request_number: 'REQ-2026-000001',
    });
    const id = submitted.body.data.id as string;

    const steps: [string, string, object, string][] = [
      [AGENT_IT, 'claim', {}, 'assigned'],
      [AGENT_IT, 'start', {}, 'in_progress'],
      [AGENT_IT, 'hold', { reason: 'Waiting for the vendor to ship the part' }, 'on_hold'],
      [AGENT_IT, 'resume', {}, 'in_progress'],
      [AGENT_IT, 'resolve', { resolution_note: NOTE, reason: REASON }, 'resolved'],
      [EMPLOYEE, 'close', {}, 'closed'],
      [EMPLOYEE, 'reopen', { reason: 'The same fault returned two days later' }, 'assigned'],
    ];

    for (const [actor, name, body, expected] of steps) {
      const response = await send(app, 'post', `/requests/${id}/${name}`, actor, body);
      expect(response.status, name).toBe(200);
      expect(response.body.data.status, name).toBe(expected);
    }
  });

  it('stamps the closure times the lifecycle is supposed to record', async () => {
    const { app, clock } = harness();
    const ticket = await create(app, EMPLOYEE);
    await send(app, 'post', `/requests/${ticket.id}/claim`, AGENT_IT, {});
    clock.set('2026-10-27T09:00:00Z');
    const resolved = await send(app, 'post', `/requests/${ticket.id}/resolve`, AGENT_IT, {
      resolution_note: NOTE,
      reason: REASON,
    });
    expect(resolved.body.data.resolved_at).toBe('2026-10-27T09:00:00.000Z');

    clock.set('2026-10-28T09:00:00Z');
    const closed = await send(app, 'post', `/requests/${ticket.id}/close`, EMPLOYEE, {});
    expect(closed.body.data.closed_at).toBe('2026-10-28T09:00:00.000Z');
  });

  // Every case starts from the ticket `create()` yields, so the refusal must come from the state
  // machine rather than from visibility or permissions. `source` is the status the message names.
  const ILLEGAL: [string, string, string, object, string][] = [
    ['start a ticket nobody holds', 'start', AGENT_IT, {}, 'submitted'],
    ['hold a ticket nobody holds', 'hold', AGENT_IT, { reason: REASON }, 'submitted'],
    [
      'resolve a ticket nobody holds',
      'resolve',
      AGENT_IT,
      { resolution_note: NOTE, reason: REASON },
      'submitted',
    ],
    ['close a ticket that was never resolved', 'close', EMPLOYEE, {}, 'submitted'],
    [
      'reopen a ticket that was never resolved',
      'reopen',
      EMPLOYEE,
      { reason: REASON },
      'submitted',
    ],
    ['submit an already submitted ticket', 'submit', EMPLOYEE, {}, 'submitted'],
    ['resume a ticket that is not on hold', 'resume', AGENT_IT, {}, 'submitted'],
  ];

  it.each(ILLEGAL)('refuses to %s', async (_label, action, actor, body, source) => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    const response = await send(app, 'post', `/requests/${ticket.id}/${action}`, actor, body);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INVALID_TRANSITION');
    expect(response.body.error.message).toContain(source);
  });

  it('never lets a draft be claimed, because no role that may claim one can see it', async () => {
    const { app } = harness();
    const draft = await create(app, EMPLOYEE, { draft: true });
    // The author holds no claim permission, and staff cannot see another person's draft, so the
    // illegal `draft → claimed` move is unreachable from HTTP rather than merely refused (404/403).
    expect((await send(app, 'post', `/requests/${draft.id}/claim`, EMPLOYEE, {})).status).toBe(403);
    expect((await send(app, 'post', `/requests/${draft.id}/claim`, AGENT_IT, {})).status).toBe(404);
    expect((await send(app, 'post', `/requests/${draft.id}/claim`, MANAGER, {})).status).toBe(404);
  });

  it('refuses to submit someone else’s draft', async () => {
    const { app } = harness();
    const draft = await create(app, EMPLOYEE, { draft: true });
    // Invisible to a colleague, so the answer is 404 rather than confirming the id exists.
    expect((await send(app, 'post', `/requests/${draft.id}/submit`, COLLEAGUE, {})).status).toBe(
      404,
    );
    expect((await send(app, 'post', `/requests/${draft.id}/submit`, MANAGER, {})).status).toBe(404);
  });

  it('requires a justified reason where the lifecycle demands one', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    await send(app, 'post', `/requests/${ticket.id}/claim`, AGENT_IT, {});

    const missing = await send(app, 'post', `/requests/${ticket.id}/resolve`, AGENT_IT, {
      resolution_note: NOTE,
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details).toEqual([expect.objectContaining({ path: 'reason' })]);

    const tooShort = await send(app, 'post', `/requests/${ticket.id}/cancel`, EMPLOYEE, {
      reason: 'nope',
    });
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.error.details).toEqual([expect.objectContaining({ path: 'reason' })]);
  });

  it('requires a resolution note long enough to be useful', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    await send(app, 'post', `/requests/${ticket.id}/claim`, AGENT_IT, {});
    const response = await send(app, 'post', `/requests/${ticket.id}/resolve`, AGENT_IT, {
      resolution_note: 'fixed it',
      reason: REASON,
    });
    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([
      expect.objectContaining({ path: 'resolution_note' }),
    ]);
  });

  it('closes the loop on cancellation and blocks anything after it', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    const cancelled = await send(app, 'post', `/requests/${ticket.id}/cancel`, EMPLOYEE, {
      reason: 'Resolved it myself by reconnecting the dock',
    });
    expect(detailOf(cancelled)).toMatchObject({ status: 'cancelled' });
    expect(detailOf(cancelled).allowed_actions).toEqual([]);
    expect(detailOf(cancelled).cancelled_at).not.toBeNull();

    const reopen = await send(app, 'post', `/requests/${ticket.id}/reopen`, EMPLOYEE, {
      reason: 'Actually I still need this done',
    });
    expect(reopen.status).toBe(409);
    expect(reopen.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('honours the seven-day reopen window', async () => {
    const { app, clock } = harness();
    const ticket = await create(app, EMPLOYEE);
    await send(app, 'post', `/requests/${ticket.id}/claim`, AGENT_IT, {});
    await send(app, 'post', `/requests/${ticket.id}/resolve`, AGENT_IT, {
      resolution_note: NOTE,
      reason: REASON,
    });

    clock.advanceMinutes(8 * 24 * 60);
    const response = await send(app, 'post', `/requests/${ticket.id}/reopen`, EMPLOYEE, {
      reason: 'The fault came back after the window closed',
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('REOPEN_WINDOW_EXPIRED');
  });

  it('applies the generic transition endpoint for a legal action', async () => {
    const { app } = harness();
    const draft = await create(app, EMPLOYEE, { draft: true });
    const response = await send(app, 'post', `/requests/${draft.id}/transition`, EMPLOYEE, {
      action: 'submit',
    });
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('submitted');
  });

  it('refuses an action the caller’s role may never perform', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    const response = await send(app, 'post', `/requests/${ticket.id}/transition`, EMPLOYEE, {
      action: 'resolve',
      resolution_note: NOTE,
      reason: REASON,
    });
    expect(response.status).toBe(403);
  });

  it('rejects an unknown action name on the generic endpoint', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    const response = await send(app, 'post', `/requests/${ticket.id}/transition`, ADMIN, {
      action: 'escalate',
    });
    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([expect.objectContaining({ path: 'action' })]);
  });

  it('rejects a stale version on a transition with 409', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    const response = await request(app)
      .post(`${API}/requests/${ticket.id}/claim`)
      .set(as(AGENT_IT))
      .set('If-Match', '"99"')
      .send({});
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');
    expect(response.body.error.details).toEqual([expect.objectContaining({ path: 'version' })]);
  });

  it('serialises two agents who read the same version, so only one claim lands', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    // Both writers present the same `ETag` they read. Optimistic locking plus the row lock means
    // exactly one may land; the other is told the ticket moved under it (docs/requirements.md §16.4).
    const first = await request(app)
      .post(`${API}/requests/${ticket.id}/claim`)
      .set(as(AGENT_IT))
      .set('If-Match', `"${ticket.version}"`)
      .send({});
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`${API}/requests/${ticket.id}/claim`)
      .set(as(AGENT_IT_SECOND))
      .set('If-Match', `"${ticket.version}"`)
      .send({});
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT');

    // The winner keeps the ticket; the loser’s identity did not become the assignee.
    expect(detailOf(first).assignee).toEqual({ id: AGENT_IT, full_name: 'carl' });
  });
});

// ---------------------------------------------------------------------------
// Nonexistent identifiers
// ---------------------------------------------------------------------------

describe('unknown identifiers', () => {
  const MISSING: [Verb, string, object | undefined][] = [
    ['get', '/requests/999999', undefined],
    ['get', '/requests/999999/events', undefined],
    ['patch', '/requests/999999', { title: TITLE }],
    ['post', '/requests/999999/resolve', { resolution_note: NOTE, reason: REASON }],
    ['post', '/requests/999999/reopen', { reason: REASON }],
    ['post', '/requests/999999/assign', { assignee_id: AGENT_IT }],
  ];

  it.each(MISSING)(
    '%s %s answers 404 for a resource that is not there',
    async (verb, path, body) => {
      const { app } = harness();
      const response = await send(app, verb, path, ADMIN, body);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    },
  );

  it('answers 404 for an id that exists but is not yours', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    const response = await send(app, 'get', `/requests/${ticket.id}`, COLLEAGUE);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  const ID_CASES: [string, number][] = [
    ['abc', 400],
    ['-5', 400],
    ['1.5', 400],
    ['99999999999999999999999', 400],
    ['0', 404],
    ['20', 404],
  ];

  it.each(ID_CASES)('treats the path id %s as %i', async (id, status) => {
    const { app } = harness();
    const response = await send(app, 'get', `/requests/${id}`, ADMIN);
    expect(response.status).toBe(status);
  });

  it('reports the same 404 for a missing id whether or not the caller is scoped to see it', async () => {
    const { app } = harness();
    await create(app, COLLEAGUE);
    // A probing employee and an all-seeing admin get byte-identical failures for a bogus id.
    const probe = await send(app, 'get', '/requests/999999', EMPLOYEE);
    const admin = await send(app, 'get', '/requests/999999', ADMIN);
    expect(probe.body.error.message).toBe(admin.body.error.message);
  });
});

// ---------------------------------------------------------------------------
// Authentication and the permission matrix
// ---------------------------------------------------------------------------

describe('permission gates', () => {
  const ROUTES: [Verb, string][] = [
    ['get', '/requests'],
    ['get', '/requests/1'],
    ['get', '/requests/1/events'],
    ['post', '/requests'],
    ['patch', '/requests/1'],
    ['post', '/requests/1/submit'],
    ['post', '/requests/1/claim'],
    ['post', '/requests/1/assign'],
    ['post', '/requests/1/start'],
    ['post', '/requests/1/hold'],
    ['post', '/requests/1/resume'],
    ['post', '/requests/1/resolve'],
    ['post', '/requests/1/close'],
    ['post', '/requests/1/reopen'],
    ['post', '/requests/1/cancel'],
    ['post', '/requests/1/transition'],
  ];

  it.each(ROUTES)('%s %s fails closed without an identity', async (verb, path) => {
    const { app } = harness();
    const response = await send(app, verb, path, undefined, {});
    expect(response.status).toBe(401);
    expect(apiErrorBodySchema.parse(response.body).error.code).toBe('UNAUTHENTICATED');
  });

  it('never trusts a role the client claims', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    // `role` is not a field the contract accepts anywhere, and the gate runs before the parser.
    const response = await send(app, 'post', `/requests/${ticket.id}/claim`, EMPLOYEE, {
      role: 'admin',
    });
    expect(response.status).toBe(403);
  });

  it('reports allowed_actions per caller for the same ticket', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    const actions = async (actor: string) =>
      (await send(app, 'get', `/requests/${ticket.id}`, actor)).body.data.allowed_actions;

    expect(await actions(EMPLOYEE)).toEqual(['cancel']);
    expect(await actions(AGENT_IT)).toEqual(['claim']);
    expect(await actions(MANAGER)).toEqual(['claim', 'assign']);
    expect(await actions(ADMIN)).toEqual(['claim', 'assign']);
  });

  it('denies an employee the staff-only surface even on their own ticket', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    for (const action of ['claim', 'start', 'hold', 'resume', 'resolve']) {
      const response = await send(
        app,
        'post',
        `/requests/${ticket.id}/${action}`,
        EMPLOYEE,
        action === 'hold' ? { reason: REASON } : {},
      );
      expect(response.status, action).toBe(403);
    }
  });

  it('stops a deactivated account from writing, even on a still-valid token', async () => {
    const { app } = harness();
    // `authenticate` verifies the JWT without a user lookup, so the request service re-reads the
    // actor (docs/security-plan.md §3) and refuses the write.
    const ticket = await create(app, EMPLOYEE);
    for (const [verb, path, body] of [
      ['post', '/requests', { title: TITLE, description: DESCRIPTION, category_id: '1' }],
      ['post', `/requests/${ticket.id}/claim`, {}],
    ] as [Verb, string, object][]) {
      const response = await send(app, verb, path, AGENT_INACTIVE, body);
      expect(response.status, path).toBe(403);
      expect(response.body.error.code, path).toBe('FORBIDDEN');
    }
  });
});

// ---------------------------------------------------------------------------
// Comments (docs/api-specification.md §7)
// ---------------------------------------------------------------------------

const COMMENT_TEXT = 'The patch rolled back on its own. Investigating the SSD now.';

function commentOf(response: { body: unknown }): CommentDto {
  return commentResponseSchema.parse(response.body).data;
}

describe('POST /requests/:id/comments', () => {
  it('stamps the acting author and the clock instant, neither of which the client supplies', async () => {
    const { app, clock } = harness();
    const ticket = await create(app, EMPLOYEE);
    clock.set('2026-10-26T12:34:56.000Z');
    const response = await send(app, 'post', `/requests/${ticket.id}/comments`, AGENT_IT, {
      body: COMMENT_TEXT,
    });

    expect(response.status).toBe(201);
    expect(commentOf(response)).toEqual({
      id: expect.any(String),
      request_id: ticket.id,
      author: { id: AGENT_IT, full_name: 'carl' },
      body: COMMENT_TEXT,
      visibility: 'public',
      is_post_closure: false,
      created_at: '2026-10-26T12:34:56.000Z',
      updated_at: '2026-10-26T12:34:56.000Z',
    });
    expect(response.headers['content-type']).toContain('application/json');
  });

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['only a tab and a newline', '\t\n '],
  ])('rejects content that is %s before anything is stored', async (_label, body) => {
    const { app, audit } = harness();
    const ticket = await create(app, EMPLOYEE);
    const response = await send(app, 'post', `/requests/${ticket.id}/comments`, EMPLOYEE, { body });

    expect(response.status).toBe(400);
    expect(apiErrorBodySchema.parse(response.body).error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ path: 'body' }],
    });
    // Rejected at the boundary, so the thread was never opened and nothing was audited.
    expect((await send(app, 'get', `/requests/${ticket.id}/comments`, EMPLOYEE)).body.data).toEqual(
      [],
    );
    expect(audit.entries.some((entry) => entry.action === 'comment.added')).toBe(false);
  });

  it('accepts exactly the longest body the column CHECK allows and refuses one more character', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    const longest = 'x'.repeat(COMMENT_BODY_MAX);

    expect(
      (await send(app, 'post', `/requests/${ticket.id}/comments`, EMPLOYEE, { body: longest }))
        .status,
    ).toBe(201);
    const tooLong = await send(app, 'post', `/requests/${ticket.id}/comments`, EMPLOYEE, {
      body: `${longest}x`,
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.details[0].path).toBe('body');
  });

  it('will not let the caller supply an author, a timestamp or a BR-8 flag', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    for (const extra of [
      { author_id: AGENT_IT },
      { created_at: '2020-01-01T00:00:00.000Z' },
      { is_post_closure: true },
    ]) {
      const response = await send(app, 'post', `/requests/${ticket.id}/comments`, EMPLOYEE, {
        body: 'Nice try',
        ...extra,
      });
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it('gates an internal note on the staff-only permission, not on the request', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    const response = await send(app, 'post', `/requests/${ticket.id}/comments`, EMPLOYEE, {
      body: 'Should not be able to hide a note from myself',
      visibility: 'internal',
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('flags a comment left after the request was resolved (BR-8)', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    await send(app, 'post', `/requests/${ticket.id}/claim`, AGENT_IT, {});
    await send(app, 'post', `/requests/${ticket.id}/resolve`, AGENT_IT, {
      resolution_note: NOTE,
      reason: REASON,
    });

    const after = await send(app, 'post', `/requests/${ticket.id}/comments`, EMPLOYEE, {
      body: 'Thank you — the laptop has been stable all week.',
    });
    expect(after.status).toBe(201);
    expect(commentOf(after).is_post_closure).toBe(true);
  });

  it('inherits the parent request’s scope, so another employee’s ticket is a 404', async () => {
    const { app } = harness();
    const theirs = await create(app, COLLEAGUE);
    expect(
      (await send(app, 'post', `/requests/${theirs.id}/comments`, EMPLOYEE, { body: 'Hello?' }))
        .status,
    ).toBe(404);
    expect((await send(app, 'get', `/requests/${theirs.id}/comments`, EMPLOYEE)).status).toBe(404);
    expect((await send(app, 'get', `/requests/${theirs.id}/timeline`, EMPLOYEE)).status).toBe(404);
  });

  it('fails closed for an anonymous caller and refuses a deactivated account', async () => {
    const { app } = harness();
    const ticket = await create(app, EMPLOYEE);
    expect(
      (await send(app, 'post', `/requests/${ticket.id}/comments`, undefined, { body: 'anon' }))
        .status,
    ).toBe(401);
    const inactive = await send(app, 'post', `/requests/${ticket.id}/comments`, AGENT_INACTIVE, {
      body: 'still got a token',
    });
    expect(inactive.status).toBe(403);
  });
});

describe('GET /requests/:id/comments', () => {
  const thread = [
    ['2026-10-26T11:00:00.000Z', EMPLOYEE, 'It is happening again this morning.'],
    ['2026-10-26T12:00:00.000Z', AGENT_IT, 'Reproduced on the same build. Swapping the drive.'],
    ['2026-10-26T13:00:00.000Z', MANAGER, 'Please log the part number for finance.'],
  ] as const;

  /** A ticket with the three-message thread above, written at the instants given. */
  async function seeded(app: Express, clock: FixedClock): Promise<string> {
    const ticket = await create(app, EMPLOYEE);
    for (const [at, actor, body] of thread) {
      clock.set(at);
      const response = await send(app, 'post', `/requests/${ticket.id}/comments`, actor, { body });
      expect(response.status).toBe(201);
    }
    return ticket.id;
  }

  it('reads the thread oldest first with every author and timestamp preserved', async () => {
    const { app, clock } = harness();
    const id = await seeded(app, clock);
    const response = await send(app, 'get', `/requests/${id}/comments`, EMPLOYEE);

    expect(response.status).toBe(200);
    const parsed = commentListResponseSchema.parse(response.body);
    expect(parsed.data.map((row) => row.body)).toEqual(thread.map(([, , body]) => body));
    expect(parsed.data.map((row) => row.author.id)).toEqual([EMPLOYEE, AGENT_IT, MANAGER]);
    expect(parsed.data.map((row) => row.created_at)).toEqual(thread.map(([at]) => at));
    expect(parsed.meta).toMatchObject({ total: 3 });
  });

  it('pages through the thread with the total describing the whole thread', async () => {
    const { app, clock } = harness();
    const id = await seeded(app, clock);
    const second = commentListResponseSchema.parse(
      (await send(app, 'get', `/requests/${id}/comments?page=2&page_size=2`, EMPLOYEE)).body,
    );

    expect(second.data.map((row) => row.created_at)).toEqual([thread[2][0]]);
    expect(second.meta).toMatchObject({ page: 2, page_size: 2, total: 3 });
  });

  it('filters internal notes out of the query for a requester and keeps them for staff', async () => {
    const { app, clock } = harness();
    const id = await seeded(app, clock);
    clock.set('2026-10-26T14:00:00.000Z');
    const note = await send(app, 'post', `/requests/${id}/comments`, AGENT_IT, {
      body: 'Vendor has already shipped the replacement under RMA.',
      visibility: 'internal',
    });
    expect(note.status).toBe(201);

    const visible = commentListResponseSchema.parse(
      (await send(app, 'get', `/requests/${id}/comments`, EMPLOYEE)).body,
    );
    // Filtered in SQL, so the total counts what the caller may read — not what exists.
    expect(visible.data).toHaveLength(3);
    expect(visible.meta.total).toBe(3);
    expect(JSON.stringify(visible.data)).not.toContain('RMA');

    const staff = commentListResponseSchema.parse(
      (await send(app, 'get', `/requests/${id}/comments`, MANAGER)).body,
    );
    expect(staff.data).toHaveLength(4);
    expect(staff.meta.total).toBe(4);
    expect(staff.data.at(-1)).toMatchObject({ visibility: 'internal', author: { id: AGENT_IT } });
  });
});

// ---------------------------------------------------------------------------
// Activity timeline (docs/api-specification.md §6.9)
// ---------------------------------------------------------------------------

describe('GET /requests/:id/timeline', () => {
  /** submitted → assigned → started → comment → resolved, one hour apart. */
  async function walk(app: Express, clock: FixedClock): Promise<string> {
    const ticket = await create(app, EMPLOYEE);
    clock.set('2026-10-26T11:00:00.000Z');
    await send(app, 'post', `/requests/${ticket.id}/assign`, MANAGER, {
      assignee_id: AGENT_IT,
      reason: 'Carl owns the hardware queue this week',
    });
    clock.set('2026-10-26T12:00:00.000Z');
    await send(app, 'post', `/requests/${ticket.id}/start`, AGENT_IT, {});
    clock.set('2026-10-26T13:00:00.000Z');
    await send(app, 'post', `/requests/${ticket.id}/comments`, AGENT_IT, {
      body: 'Drive swapped and re-imaged from the golden build.',
    });
    clock.set('2026-10-26T14:00:00.000Z');
    await send(app, 'post', `/requests/${ticket.id}/resolve`, AGENT_IT, {
      resolution_note: NOTE,
      reason: REASON,
    });
    return ticket.id;
  }

  it('merges lifecycle activity and comments into one chronological feed', async () => {
    const { app, clock } = harness();
    const id = await walk(app, clock);
    const response = await send(app, 'get', `/requests/${id}/timeline`, EMPLOYEE);

    expect(response.status).toBe(200);
    const feed = requestTimelineListResponseSchema.parse(response.body).data;
    expect(feed.map((entry) => entry.event_type)).toEqual([
      'created',
      'submitted',
      'assigned',
      'started',
      'comment_added',
      'resolved',
    ]);
    expect(feed.map((entry) => entry.kind)).toEqual([
      'event',
      'event',
      'event',
      'event',
      'comment',
      'event',
    ]);
    expect(feed.map((entry) => entry.created_at)).toEqual([
      START.toISOString(),
      START.toISOString(),
      '2026-10-26T11:00:00.000Z',
      '2026-10-26T12:00:00.000Z',
      '2026-10-26T13:00:00.000Z',
      '2026-10-26T14:00:00.000Z',
    ]);
  });

  it('names the actor behind every entry, with the role snapshot taken at the time', async () => {
    const { app, clock } = harness();
    const id = await walk(app, clock);
    const feed = requestTimelineListResponseSchema.parse(
      (await send(app, 'get', `/requests/${id}/timeline`, ADMIN)).body,
    ).data;

    expect(feed.map((entry) => entry.actor?.id)).toEqual([
      EMPLOYEE,
      EMPLOYEE,
      MANAGER,
      AGENT_IT,
      AGENT_IT,
      AGENT_IT,
    ]);
    expect(feed.map((entry) => entry.actor_role)).toEqual([
      'employee',
      'employee',
      'manager',
      'agent',
      'agent',
      'agent',
    ]);
    // Never a decreasing instant, whatever the order of the underlying tables.
    const instants = feed.map((entry) => Date.parse(entry.created_at));
    expect(instants).toEqual([...instants].sort((a, b) => a - b));
  });

  it('carries the comment text on the comment entry and the transition pair on the event', async () => {
    const { app, clock } = harness();
    const id = await walk(app, clock);
    const feed = requestTimelineListResponseSchema.parse(
      (await send(app, 'get', `/requests/${id}/timeline`, AGENT_IT)).body,
    ).data;

    const comment = feed.find((entry) => entry.kind === 'comment');
    expect(comment?.detail).toMatchObject({
      visibility: 'public',
      is_post_closure: false,
      body: 'Drive swapped and re-imaged from the golden build.',
    });
    expect(comment?.from_status).toBeNull();
    expect(feed[2]).toMatchObject({ from_status: 'submitted', to_status: 'assigned' });
  });

  it('lists a comment once, not as both a marker and a row', async () => {
    const { app, clock } = harness();
    const id = await walk(app, clock);
    const feed = requestTimelineListResponseSchema.parse(
      (await send(app, 'get', `/requests/${id}/timeline`, AGENT_IT)).body,
    ).data;

    expect(feed.filter((entry) => entry.event_type === 'comment_added')).toHaveLength(1);
    // The lifecycle feed still shows the marker, which is the point of keeping them separate.
    const events = requestEventListResponseSchema.parse(
      (await send(app, 'get', `/requests/${id}/events`, AGENT_IT)).body,
    ).data;
    const markers = events.filter((event) => event.event_type === 'comment_added');
    expect(markers).toHaveLength(1);
    expect(markers[0]?.detail).toMatchObject({
      characters: 'Drive swapped and re-imaged from the golden build.'.length,
      visibility: 'public',
    });
    expect(JSON.stringify(markers)).not.toContain('re-imaged');
  });

  it('hides an internal note from the requester and shows it to staff', async () => {
    const { app, clock } = harness();
    const id = await walk(app, clock);
    clock.set('2026-10-26T15:00:00.000Z');
    await send(app, 'post', `/requests/${id}/comments`, AGENT_IT, {
      body: 'Do not tell the user yet: the whole SSD batch is faulty.',
      visibility: 'internal',
    });

    const mine = requestTimelineListResponseSchema.parse(
      (await send(app, 'get', `/requests/${id}/timeline`, EMPLOYEE)).body,
    ).data;
    expect(JSON.stringify(mine)).not.toContain('faulty');
    expect(mine.filter((entry) => entry.kind === 'comment')).toHaveLength(1);

    const staff = requestTimelineListResponseSchema.parse(
      (await send(app, 'get', `/requests/${id}/timeline`, MANAGER)).body,
    ).data;
    expect(staff.filter((entry) => entry.kind === 'comment')).toHaveLength(2);
  });

  it.each([
    ['limit=2', 2],
    ['limit=5', 5],
  ])('honours %s without reordering what it returns', async (query, expected) => {
    const { app, clock } = harness();
    const id = await walk(app, clock);
    const feed = requestTimelineListResponseSchema.parse(
      (await send(app, 'get', `/requests/${id}/timeline?${query}`, ADMIN)).body,
    ).data;

    expect(feed).toHaveLength(expected);
    const instants = feed.map((entry) => Date.parse(entry.created_at));
    expect(instants).toEqual([...instants].sort((a, b) => a - b));
  });

  it('rejects a limit outside the contract instead of turning the read unbounded', async () => {
    const { app, clock } = harness();
    const id = await walk(app, clock);
    for (const limit of ['0', '201', 'abc']) {
      const response = await send(app, 'get', `/requests/${id}/timeline?limit=${limit}`, ADMIN);
      expect(response.status, limit).toBe(400);
      expect(response.body.error.code, limit).toBe('VALIDATION_ERROR');
    }
  });
});

// ---------------------------------------------------------------------------
// Database failures
// ---------------------------------------------------------------------------

/** A configured database whose driver always fails, as PostgreSQL does during a real outage. */
function failingDatabase(sqlState: string): Database {
  const message = 'connection to server failed user=svc password=s3cret host=10.0.0.5';
  const fail = () => Promise.reject(Object.assign(new Error(message), { code: sqlState }));
  return {
    configured: true,
    query: fail,
    transaction: fail,
    ping: () => Promise.resolve({ state: 'down' }),
    close: () => Promise.resolve(),
  };
}

/** The same HTTP surface, but backed by the Postgres adapter against a broken driver. */
function outages(sqlState: string): Harness {
  const clock = new FixedClock(START);
  const audit = new RecordingAuditSink();
  const database = failingDatabase(sqlState);
  const built = createApp({
    config: loadConfig({ NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:5173' }),
    logger: createSilentLogger(),
    database,
    clock,
    audit,
    userRepository: new InMemoryUserRepository(ROSTER),
    requestRepository: new PostgresRequestRepository(database),
    identity: identityFromRoster(),
  });
  return { app: built.app, clock, audit };
}

describe('database failures', () => {
  it('reads a driver outage as 503 on a query', async () => {
    const { app } = outages('08006');
    const response = await send(app, 'get', '/requests', ADMIN);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toContain('s3cret');
    expect(JSON.stringify(response.body)).not.toContain('10.0.0.5');
  });

  it('reads a driver outage as 503 on a write that runs inside a transaction', async () => {
    const { app } = outages('57P01');
    const response = await send(app, 'post', '/requests', EMPLOYEE, {
      title: TITLE,
      description: DESCRIPTION,
      category_id: '1',
    });
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain('password');
  });

  it.each([
    ['23505', 'CONFLICT', 409],
    ['23503', 'VALIDATION_ERROR', 400],
    ['23514', 'VALIDATION_ERROR', 400],
    ['23502', 'VALIDATION_ERROR', 400],
    ['40001', 'CONFLICT', 409],
    ['53300', 'SERVICE_UNAVAILABLE', 503],
    ['53200', 'SERVICE_UNAVAILABLE', 503],
    ['57014', 'SERVICE_UNAVAILABLE', 503],
    ['XX001', 'INTERNAL', 500],
  ])('maps SQLSTATE %s to %s (%i)', async (sqlState, code, status) => {
    const error = mapDatabaseError(Object.assign(new Error('driver said no'), { code: sqlState }));
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
  });

  it('passes an AppError through the mapper unchanged instead of flattening it to 500', () => {
    const mapped = mapDatabaseError(new Error('deadlock detected'));
    expect(mapped.code).toBe('INTERNAL');
    expect(mapDatabaseError(mapped)).toBe(mapped);
  });

  it('never leaks the driver message through an unexpected failure', async () => {
    const refuse = () => Promise.reject(new Error('unexpected'));
    const broken: RequestRepository = {
      list: () => Promise.reject(new Error('relation "requests" does not exist at 10.0.0.5')),
      find: refuse,
      create: refuse,
      edit: refuse,
      transition: refuse,
      events: refuse,
      addComment: refuse,
      listComments: refuse,
      timeline: refuse,
      findCategory: refuse,
      findSubCategory: refuse,
      findDepartment: refuse,
      countOpenForAssignee: refuse,
    };
    const { app } = harness({ repository: broken });
    const response = await send(app, 'get', '/requests', ADMIN);

    expect(response.status).toBe(500);
    expect(response.body.error).toEqual({
      code: 'INTERNAL',
      message: 'An unexpected error occurred',
      request_id: expect.any(String),
    });
    expect(JSON.stringify(response.body)).not.toContain('10.0.0.5');
  });

  it('rolls back the whole multi-record write when a related row fails', async () => {
    // A transition writes the parent row, the assignment history, the activity event and the SLA
    // tracker in one transaction. `database.transaction` here does exactly what the real pool does:
    // ROLLBACK on throw. So a failure at the assignment insert must leave the ticket untouched.
    const calls: string[] = [];
    const database: Database = {
      configured: true,
      query: () => Promise.reject(new Error('not used by this path')),
      async transaction<R>(work: (client: PoolClient) => Promise<R>): Promise<R> {
        calls.push('begin');
        const client = {
          query: (sql: string) => {
            if (sql.includes('INSERT INTO assignments')) {
              return Promise.reject(new Error('deadlock detected'));
            }
            const isSelect = sql.trimStart().toUpperCase().startsWith('SELECT');
            return Promise.resolve({
              rows: isSelect ? [{ version: 3, assignee_id: null, id: '5' }] : [],
              rowCount: 1,
              command: '',
              fields: [],
              oid: 0,
            });
          },
        } as unknown as PoolClient;
        try {
          const result = await work(client);
          calls.push('commit');
          return result;
        } catch (error) {
          calls.push('rollback');
          throw error;
        }
      },
      ping: () => Promise.resolve({ state: 'up' }),
      close: () => Promise.resolve(),
    };

    await expect(
      new PostgresRequestRepository(database).transition({
        id: '5',
        expectedVersion: null,
        fromStatus: 'submitted',
        toStatus: 'assigned',
        assigneeId: AGENT_IT,
        statusReason: null,
        resolutionNote: null,
        timestamps: {},
        clearTimestamps: [],
        incrementReopen: false,
        allocateNumberYear: null,
        event: { eventType: 'assigned', detail: {} },
        closeOpenAssignment: true,
        assignment: { agentId: AGENT_IT, reason: 'manager_assign' },
        tracker: null,
        actorId: MANAGER,
        actorRole: 'manager',
        audit: [],
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    // Nothing after the failing statement ran, and the transaction was rolled back, not committed.
    expect(calls).toEqual(['begin', 'rollback']);
  });
});

// ---------------------------------------------------------------------------
// Audit trail — what a lifecycle walk leaves behind
// ---------------------------------------------------------------------------

describe('audit trail — actor, action, request, instant and before/after', () => {
  it('records one row per change, each pointing at the request it describes', async () => {
    const { app, clock, audit } = harness();
    const ticket = await create(app, EMPLOYEE);
    clock.set('2026-10-26T11:00:00.000Z');
    await send(app, 'post', `/requests/${ticket.id}/assign`, MANAGER, {
      assignee_id: AGENT_IT,
      reason: 'Carl owns the hardware queue this week',
    });
    clock.set('2026-10-26T12:00:00.000Z');
    const escalation = await send(app, 'patch', `/requests/${ticket.id}`, MANAGER, {
      priority: 'critical',
      reason: 'Client demo is blocked; escalated per the account plan',
    });
    expect(escalation.status).toBe(200);
    clock.set('2026-10-26T13:00:00.000Z');
    await send(app, 'post', `/requests/${ticket.id}/start`, AGENT_IT, {});
    clock.set('2026-10-26T14:00:00.000Z');
    await send(app, 'post', `/requests/${ticket.id}/resolve`, AGENT_IT, {
      resolution_note: NOTE,
      reason: REASON,
    });
    clock.set('2026-10-26T15:00:00.000Z');
    await send(app, 'post', `/requests/${ticket.id}/reopen`, EMPLOYEE, {
      reason: 'The same fault returned the next morning',
    });

    const rows = audit.entries.filter((entry) => entry.entityType === 'request');
    expect(rows.map((entry) => entry.action)).toEqual([
      'request.submitted',
      'request.assign',
      'request.assigned',
      'request.updated',
      'request.start',
      'request.resolve',
      'request.reopen',
    ]);

    for (const entry of rows) {
      expect(entry.actorId).toBeTruthy();
      expect(entry.actorRole).toBeTruthy();
      // `serviceRequestId` is the FK column: every request row is tied to its ticket.
      expect(entry.serviceRequestId).toBe(ticket.id);
      expect(entry.entityId).toBe(ticket.id);
      expect(entry.at).toBeTruthy();
      expect(entry.requestId).toEqual(expect.any(String));
    }

    // The instant is the write's own, so the trail and the audit row can never disagree.
    expect(rows.map((entry) => entry.at)).toEqual([
      START.toISOString(),
      '2026-10-26T11:00:00.000Z',
      '2026-10-26T11:00:00.000Z',
      '2026-10-26T12:00:00.000Z',
      '2026-10-26T13:00:00.000Z',
      '2026-10-26T14:00:00.000Z',
      '2026-10-26T15:00:00.000Z',
    ]);

    const byAction = new Map(rows.map((entry) => [entry.action, entry]));
    expect(byAction.get('request.assign')).toMatchObject({
      actorId: MANAGER,
      actorRole: 'manager',
      before: { status: 'submitted', assignee_id: null },
      after: { status: 'assigned', assignee_id: AGENT_IT },
    });
    expect(byAction.get('request.updated')?.before).toMatchObject({ priority: 'medium' });
    expect(byAction.get('request.updated')?.after).toMatchObject({ priority: 'critical' });
    expect(byAction.get('request.resolve')).toMatchObject({
      actorId: AGENT_IT,
      before: { status: 'in_progress' },
      after: { status: 'resolved' },
    });
    expect(byAction.get('request.reopen')).toMatchObject({
      actorId: EMPLOYEE,
      before: { status: 'resolved' },
      after: { status: 'assigned' },
    });
    // Workload is reported as the figure taken before the ticket landed in the queue.
    expect(byAction.get('request.assigned')?.after).toMatchObject({
      assignee_id: AGENT_IT,
      assignee_open_tickets_before: 0,
    });
  });

  it('describes a comment without copying it, keeping the trail distinct from the thread', async () => {
    const { app, clock, audit } = harness();
    const ticket = await create(app, EMPLOYEE);
    clock.set('2026-10-26T11:00:00.000Z');
    const secret = 'The pin for the server room door is 1234';
    await send(app, 'post', `/requests/${ticket.id}/comments`, AGENT_IT, { body: secret });

    const entry = audit.entries.find((candidate) => candidate.action === 'comment.added');
    expect(entry).toMatchObject({
      actorId: AGENT_IT,
      actorRole: 'agent',
      entityType: 'comment',
      serviceRequestId: ticket.id,
      at: '2026-10-26T11:00:00.000Z',
    });
    // Length and visibility only: the trail points at the comment, it does not duplicate it.
    expect(entry?.after).toEqual({
      request_id: ticket.id,
      request_number: ticket.request_number,
      author_id: AGENT_IT,
      visibility: 'public',
      characters: secret.length,
      is_post_closure: false,
    });
    expect(JSON.stringify(entry)).not.toContain(secret);
    expect(JSON.stringify(entry)).not.toContain('1234');

    // The activity marker behaves the same way, so the user-visible feed is not a copy either.
    const events = requestEventListResponseSchema.parse(
      (await send(app, 'get', `/requests/${ticket.id}/events`, AGENT_IT)).body,
    ).data;
    expect(events.at(-1)?.detail).toMatchObject({ characters: secret.length });
    expect(JSON.stringify(events)).not.toContain('1234');
  });

  it('keeps audit rows out of the timeline, which is the user-visible feed', async () => {
    const { app, audit } = harness();
    const ticket = await create(app, EMPLOYEE);
    await send(app, 'post', `/requests/${ticket.id}/claim`, AGENT_IT, {});

    const feed = requestTimelineListResponseSchema.parse(
      (await send(app, 'get', `/requests/${ticket.id}/timeline`, ADMIN)).body,
    ).data;
    expect(feed.map((entry) => entry.event_type)).toEqual(['created', 'submitted', 'claimed']);
    // The feed has no before/after images and no audit vocabulary: it is derived from
    // `request_events` + `comments`, and `audit_logs` has no read endpoint at all.
    expect(JSON.stringify(feed)).not.toContain('before');
    expect(feed.some((entry) => JSON.stringify(entry).includes('request.claim'))).toBe(false);
    expect(audit.entries.some((entry) => entry.action === 'request.claim')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Audit trail — written inside the transaction it describes
// ---------------------------------------------------------------------------

/**
 * A driver that runs a whole transaction and then fails one named statement. The claim under test is
 * that an audit row is *part of* the change, so the proof is that a failed audit insert undoes the
 * business write instead of logging around it — which only a transaction can show.
 */
function scriptedDatabase(rejectOn: string): {
  readonly database: Database;
  readonly calls: string[];
  readonly statements: string[];
} {
  const calls: string[] = [];
  const statements: string[] = [];
  // One generous row answers every SELECT the path runs: the row mappers read the keys they know and
  // ignore the rest, so the same object can be a request row, a number row and a comment row.
  const row = {
    id: '5',
    request_id: '5',
    request_number: 'REQ-2026-000005',
    version: 3,
    status: 'submitted',
    priority: 'medium',
    title: TITLE,
    description: DESCRIPTION,
    status_reason: null,
    resolution_note: null,
    requester_id: EMPLOYEE,
    requester_name: 'ade',
    assignee_id: AGENT_IT,
    assignee_name: 'carl',
    category_id: '1',
    category_name: 'IT',
    sub_category_id: null,
    sub_category_name: null,
    department_id: '1',
    department_name: 'Engineering',
    submitted_at: new Date(START),
    resolved_at: null,
    closed_at: null,
    created_at: new Date(START),
    updated_at: new Date(START),
    reopen_count: 0,
    tracker_id: null,
    last_seq: '1',
    // comment projection
    body: 'a comment body',
    visibility: 'public',
    is_post_closure: false,
    author_id: AGENT_IT,
    author_name: 'carl',
  };

  const database = {
    configured: true,
    query: (sql: string) => {
      statements.push(sql);
      if (sql.includes(rejectOn)) return Promise.reject(new Error('statement refused'));
      return Promise.resolve({ rows: [row], rowCount: 1, command: '', fields: [], oid: 0 });
    },
    async transaction<R>(work: (client: PoolClient) => Promise<R>): Promise<R> {
      calls.push('begin');
      const client = {
        query: (sql: string) => {
          statements.push(sql);
          if (sql.includes(rejectOn)) return Promise.reject(new Error('statement refused'));
          return Promise.resolve({ rows: [row], rowCount: 1, command: '', fields: [], oid: 0 });
        },
      } as unknown as PoolClient;
      try {
        const result = await work(client);
        calls.push('commit');
        return result;
      } catch (error) {
        calls.push('rollback');
        throw error;
      }
    },
    ping: () => Promise.resolve({ state: 'up' }),
    close: () => Promise.resolve(),
    // The same cast the transaction client above uses: a test double is described, not implemented.
  } as unknown as Database;
  return { database, calls, statements };
}

const transitionAudit = {
  audit: [
    ({ entityId, version }: { entityId: string; version?: number }) => ({
      actorId: MANAGER,
      actorRole: 'manager',
      action: 'request.assign',
      entityType: 'request',
      entityId,
      serviceRequestId: entityId,
      after: { status: 'assigned', version },
    }),
  ],
};

describe('audit trail — rollback when the transaction fails', () => {
  it('undoes a transition whose audit row could not be written', async () => {
    const { database, calls, statements } = scriptedDatabase('INSERT INTO audit_logs');
    const repository = new PostgresRequestRepository(database);

    await expect(
      repository.transition({
        id: '5',
        expectedVersion: null,
        fromStatus: 'submitted',
        toStatus: 'assigned',
        assigneeId: AGENT_IT,
        statusReason: null,
        resolutionNote: null,
        timestamps: {},
        clearTimestamps: [],
        incrementReopen: false,
        allocateNumberYear: null,
        event: { eventType: 'assigned', detail: {} },
        closeOpenAssignment: true,
        assignment: { agentId: AGENT_IT, reason: 'manager_assign' },
        tracker: null,
        actorId: MANAGER,
        actorRole: 'manager',
        ...transitionAudit,
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });

    // The ticket row, the assignment history and the activity event all ran first — and none of them
    // survived, because the audit insert is inside the same transaction rather than after it.
    expect(statements.some((sql) => sql.includes('UPDATE requests'))).toBe(true);
    expect(statements.some((sql) => sql.includes('INSERT INTO assignments'))).toBe(true);
    expect(statements.some((sql) => sql.includes('INSERT INTO request_events'))).toBe(true);
    expect(calls).toEqual(['begin', 'rollback']);
  });

  it('undoes a comment and its activity marker when the comment audit row fails', async () => {
    const { database, calls, statements } = scriptedDatabase('INSERT INTO audit_logs');
    const repository = new PostgresRequestRepository(database);

    await expect(
      repository.addComment({
        requestId: '5',
        authorId: AGENT_IT,
        authorRole: 'agent',
        body: 'Swapping the drive now.',
        visibility: 'public',
        isPostClosure: false,
        at: '2026-10-26T11:00:00.000Z',
        event: { eventType: 'comment_added', detail: { characters: 21 } },
        audit: [
          ({ entityId }: { entityId: string }) => ({
            actorId: AGENT_IT,
            actorRole: 'agent',
            action: 'comment.added',
            entityType: 'comment',
            entityId,
            serviceRequestId: '5',
            after: { characters: 21 },
          }),
        ],
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });

    expect(statements.some((sql) => sql.includes('INSERT INTO comments'))).toBe(true);
    expect(statements.some((sql) => sql.includes('INSERT INTO request_events'))).toBe(true);
    expect(calls).toEqual(['begin', 'rollback']);
  });

  it('never writes the audit row when the comment itself fails first', async () => {
    const { database, calls, statements } = scriptedDatabase('INSERT INTO comments');
    const repository = new PostgresRequestRepository(database);

    await expect(
      repository.addComment({
        requestId: '5',
        authorId: AGENT_IT,
        authorRole: 'agent',
        body: 'This one does not get stored.',
        visibility: 'internal',
        isPostClosure: false,
        at: '2026-10-26T11:00:00.000Z',
        event: { eventType: 'comment_added', detail: { characters: 29 } },
        audit: transitionAudit.audit,
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });

    // An audit entry for a change that did not happen would be worse than no entry at all.
    expect(statements.some((sql) => sql.includes('INSERT INTO audit_logs'))).toBe(false);
    expect(calls).toEqual(['begin', 'rollback']);
  });

  it('commits once, and only once, when every statement in the transaction succeeds', async () => {
    const { database, calls, statements } = scriptedDatabase('a statement that never appears');
    const repository = new PostgresRequestRepository(database);

    await expect(
      repository.addComment({
        requestId: '5',
        authorId: AGENT_IT,
        authorRole: 'agent',
        body: 'Stored, marked and audited together.',
        visibility: 'public',
        isPostClosure: false,
        at: '2026-10-26T11:00:00.000Z',
        event: { eventType: 'comment_added', detail: { characters: 33 } },
        audit: transitionAudit.audit,
      }),
    ).resolves.toMatchObject({
      visibility: 'public',
      // The row is re-read from the database projection, which the scripted driver stamps at START.
      createdAt: START.toISOString(),
    });

    expect(calls).toEqual(['begin', 'commit']);
    // Comment, activity marker and audit row — in that order, all before the commit.
    const indexOf = (needle: string) => statements.findIndex((sql) => sql.includes(needle));
    const [comment, event, audited] = [
      indexOf('INSERT INTO comments'),
      indexOf('INSERT INTO request_events'),
      indexOf('INSERT INTO audit_logs'),
    ];
    expect(comment).toBeGreaterThanOrEqual(0);
    expect(comment).toBeLessThan(event);
    expect(event).toBeLessThan(audited);
  });
});
