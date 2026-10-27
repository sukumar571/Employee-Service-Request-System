import type { RequestHandler } from 'express';
import {
  apiCatalogSchema,
  apiErrorBodySchema,
  databaseHealthSchema,
  slaPolicyDtoSchema,
  type DatabaseHealth,
} from '@esrs/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config/env.js';
import { createDatabase, type Database } from './db/pool.js';
import type { RbacActor } from './domain/rbac/policy.js';
import { FixedClock } from './domain/ports/clock.js';
import { createSilentLogger } from './lib/logger.js';
import {
  InMemorySlaPolicyRepository,
  defaultRecords,
} from './modules/sla/sla.repository.memory.js';
import type { SlaPolicyRepository } from './modules/sla/sla.repository.js';
import { RecordingAuditSink } from './ports/audit.js';

/**
 * End-to-end HTTP tests for the scaffolded slice (docs/test-plan.md §3): response envelope,
 * error envelope, correlation header, CORS/security headers and the permission gates.
 *
 * Identity is injected by a test-only middleware because the real JWT gate arrives in Phase 5;
 * the shipped app therefore fails closed rather than trusting a header.
 */
const API = '/api/v1';
const MON_10 = new Date('2026-10-26T10:00:00+05:30');

const EMPLOYEE: RbacActor = { userId: 'user-100', role: 'employee' };
const AGENT: RbacActor = { userId: 'user-200', role: 'agent', teamCategoryId: 'cat-it' };
const MANAGER: RbacActor = { userId: 'user-900', role: 'manager', teamCategoryId: 'cat-it' };

const stubDatabase = (health: DatabaseHealth): Database => ({
  configured: health.state !== 'not_configured',
  query: () => Promise.reject(new Error('stub database cannot query')),
  transaction: () => Promise.reject(new Error('stub database cannot transact')),
  ping: () => Promise.resolve(health),
  close: () => Promise.resolve(),
});

function build(
  options: { actor?: RbacActor; database?: Database; policies?: SlaPolicyRepository } = {},
) {
  const config = loadConfig({ NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:5173' });
  const clock = new FixedClock(MON_10);
  const audit = new RecordingAuditSink();
  const identity: RequestHandler | undefined = options.actor
    ? (req, _res, next) => {
        req.auth = options.actor;
        next();
      }
    : undefined;

  const built = createApp({
    config,
    logger: createSilentLogger(),
    database: options.database ?? createDatabase(),
    clock,
    audit,
    // The sink belongs to the repository now: a policy audit row is written by the same operation
    // that writes the policy, so it can be rolled back with it.
    slaRepository:
      options.policies ?? new InMemorySlaPolicyRepository(clock, defaultRecords(), audit),
    identity,
  });

  return { ...built, audit, clock, config };
}

describe('GET /health/live', () => {
  it('answers 200 with the liveness envelope and never touches the database', async () => {
    const { app } = build({ database: stubDatabase({ state: 'down' }) });
    const response = await request(app).get(`${API}/health/live`).expect(200);

    expect(response.body).toEqual({
      data: expect.objectContaining({
        status: 'ok',
        service: 'esrs-api',
        environment: 'test',
      }),
    });
    expect(response.headers['x-request-id']).toBeTruthy();
  });
});

describe('GET /health/ready', () => {
  it('reports not_configured but stays 200 so the API can serve contracts without Postgres', async () => {
    const { app } = build();
    const response = await request(app).get(`${API}/health/ready`).expect(200);
    expect(response.body.data.status).toBe('degraded');
    expect(response.body.data.database).toEqual({ state: 'not_configured' });
  });

  it('answers 503 with a degraded status when the database is down', async () => {
    const { app } = build({ database: stubDatabase({ state: 'down', latency_ms: 12 }) });
    const response = await request(app).get(`${API}/health/ready`).expect(503);
    expect(response.body.data).toMatchObject({ status: 'degraded' });
    expect(databaseHealthSchema.parse(response.body.data.database)).toEqual({
      state: 'down',
      latency_ms: 12,
    });
  });

  it('answers 200 with status ok when the database answers', async () => {
    const { app } = build({ database: stubDatabase({ state: 'up', latency_ms: 3 }) });
    const response = await request(app).get(`${API}/health/ready`).expect(200);
    expect(response.body.data).toMatchObject({ status: 'ok', uptime_seconds: expect.any(Number) });
  });
});

describe('GET /meta — contract-driven catalogue', () => {
  it('returns a body that satisfies the published ApiCatalog schema', async () => {
    const { app } = build();
    const response = await request(app).get(`${API}/meta`).expect(200);
    const catalog = apiCatalogSchema.parse(response.body.data);

    expect(catalog.catalog.statuses).toHaveLength(8);
    expect(catalog.sla.default_policies.critical.resolution_minutes).toBe(240);
    // The lifecycle the UI renders from: reopening returns a request to its assignee.
    const reopen = catalog.transitions.find((rule) => rule.action === 'reopen');
    expect(reopen).toMatchObject({ from: 'resolved', to: 'assigned', reason_required: true });
  });
});

describe('authentication gate (fail closed until Phase 5)', () => {
  it('rejects an anonymous read of SLA policies with 401 in the error envelope', async () => {
    const { app } = build();
    const response = await request(app).get(`${API}/sla/policies`).expect(401);
    expect(apiErrorBodySchema.parse(response.body)).toMatchObject({
      error: { code: 'UNAUTHENTICATED', request_id: response.headers['x-request-id'] },
    });
  });

  it('lets any signed-in role read policies but only manager+ change them', async () => {
    const body = {
      first_response_minutes: 45,
      resolution_minutes: 360,
      reason: 'Capacity review Q1 OK',
    };

    for (const actor of [EMPLOYEE, AGENT]) {
      const { app } = build({ actor });
      await request(app).get(`${API}/sla/policies`).expect(200);
      const denied = await request(app).put(`${API}/sla/policies/critical`).send(body).expect(403);
      expect(denied.body.error.code).toBe('FORBIDDEN');
    }

    const { app, audit } = build({ actor: MANAGER });
    const allowed = await request(app).put(`${API}/sla/policies/critical`).send(body).expect(200);
    expect(slaPolicyDtoSchema.parse(allowed.body.data)).toMatchObject({
      priority: 'critical',
      first_response_minutes: 45,
      resolution_minutes: 360,
      updated_by: MANAGER.userId,
    });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.action).toBe('sla_policy.updated');
  });
});

describe('validation at the HTTP boundary', () => {
  it('rejects a short change reason with VALIDATION_ERROR and field details', async () => {
    const { app } = build({ actor: MANAGER });
    const response = await request(app)
      .put(`${API}/sla/policies/high`)
      .send({ first_response_minutes: 60, resolution_minutes: 480, reason: 'too short' })
      .expect(400);

    expect(apiErrorBodySchema.parse(response.body)).toMatchObject({
      error: { code: 'VALIDATION_ERROR', details: [{ path: 'reason' }] },
    });
  });

  it('rejects an unknown priority instead of inventing one', async () => {
    const { app } = build({ actor: MANAGER });
    const response = await request(app)
      .put(`${API}/sla/policies/urgent`)
      .send({
        first_response_minutes: 60,
        resolution_minutes: 480,
        reason: 'Retargeting the new level',
      })
      .expect(400);
    expect(response.body.error.details[0].path).toBe('priority');
  });

  it('enforces the service rule that resolution must exceed first response', async () => {
    const { app } = build({ actor: MANAGER });
    const response = await request(app)
      .put(`${API}/sla/policies/high`)
      .send({
        first_response_minutes: 900,
        resolution_minutes: 480,
        reason: 'Inverted targets on purpose',
      })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details).toEqual([
      {
        path: 'resolution_minutes',
        message: 'Resolution target must be longer than the first-response target',
      },
    ]);
  });

  it('rejects a malformed JSON body with BAD_REQUEST', async () => {
    const { app } = build({ actor: MANAGER });
    const response = await request(app)
      .put(`${API}/sla/policies/high`)
      .set('Content-Type', 'application/json')
      .send('{"reason": oops}')
      .expect(400);
    expect(response.body.error.message).toBe('Request body is not valid JSON');
  });

  it('rejects an oversized payload with FILE_TOO_LARGE', async () => {
    const { app } = build({ actor: MANAGER });
    const response = await request(app)
      .put(`${API}/sla/policies/high`)
      .send({
        first_response_minutes: 60,
        resolution_minutes: 480,
        reason: 'x'.repeat(90_000),
      })
      .expect(413);
    expect(response.body.error.code).toBe('FILE_TOO_LARGE');
  });
});

describe('centralized error handling', () => {
  it('turns an unknown route into the standard 404 envelope', async () => {
    const { app } = build();
    // Deliberately outside every mounted prefix: a path under `/requests` or `/sla` reaches the
    // business identity gate first and is correctly a 401, which is not what this test is about.
    const response = await request(app).get(`${API}/not-mounted`).expect(404);
    expect(apiErrorBodySchema.parse(response.body)).toMatchObject({
      error: { code: 'NOT_FOUND', request_id: response.headers['x-request-id'] },
    });
    expect(response.body.error.message).toContain(`${API}/not-mounted`);
  });

  it('converts an unexpected dependency failure into a leak-free 500', async () => {
    const exploding: SlaPolicyRepository = {
      list: () => Promise.reject(new Error('connection string postgres://secret:pw@internal')),
      find: () => Promise.reject(new Error('unexpected')),
      save: () => Promise.reject(new Error('unexpected')),
    };
    const { app } = build({ actor: EMPLOYEE, policies: exploding });
    const response = await request(app).get(`${API}/sla/policies`).expect(500);

    expect(response.body).toEqual({
      error: {
        code: 'INTERNAL',
        message: 'An unexpected error occurred',
        request_id: response.headers['x-request-id'],
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it('echoes a well-formed x-request-id and replaces an unsafe one', async () => {
    const { app } = build();
    const supplied = 'trace-2026-10-25-0001';
    const echoed = await request(app).get(`${API}/meta`).set('x-request-id', supplied).expect(200);
    expect(echoed.headers['x-request-id']).toBe(supplied);

    // A CRLF-bearing id never reaches us (Node rejects it while writing the request), so the
    // guard is exercised with an id that is legal header content but unsafe to echo: the spaces
    // and punctuation would corrupt structured log lines.
    const injected = await request(app)
      .get(`${API}/meta`)
      .set('x-request-id', 'evil injected; value')
      .expect(200);
    expect(injected.headers['x-request-id']).not.toBe('evil injected; value');
    expect(injected.headers['x-request-id']).toHaveLength(36); // a fresh UUID
  });
});

describe('transport hardening (docs/security-plan.md §6)', () => {
  it('sets security headers and hides the framework', async () => {
    const { app } = build();
    const response = await request(app).get(`${API}/health/live`).expect(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('answers CORS only for the allowlisted origin', async () => {
    const { app, config } = build();
    const allowed = await request(app)
      .get(`${API}/meta`)
      .set('Origin', config.corsOrigins[0] ?? '')
      .expect(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    const rejected = await request(app)
      .get(`${API}/meta`)
      .set('Origin', 'http://evil.example')
      .expect(200);
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lists the available endpoints at the API root', async () => {
    const { app } = build();
    const response = await request(app).get(API).expect(200);
    expect(response.body.data).toMatchObject({ base_path: API, api_version: '0.1.0' });
  });
});
