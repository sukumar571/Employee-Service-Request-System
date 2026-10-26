import { apiErrorBodySchema, loginResultSchema, safeUserSchema } from '@esrs/shared';
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp, type BuiltApp } from './app.js';
import { loadConfig, type AppConfig } from './config/env.js';
import { createDatabase } from './db/pool.js';
import { FixedClock } from './domain/ports/clock.js';
import { createSilentLogger } from './lib/logger.js';
import type { AuthService } from './modules/auth/auth.service.js';
import { hashPassword } from './modules/auth/passwords.js';
import { InMemoryRefreshTokenStore } from './modules/auth/refreshToken.store.memory.js';
import { InMemoryUserRepository } from './modules/auth/user.repository.memory.js';
import type { UserRecord } from './modules/auth/user.repository.js';
import { RecordingAuditSink } from './ports/audit.js';

/**
 * End-to-end HTTP tests for authentication & authorization over the real Express app: the JWT gate,
 * the httpOnly refresh cookie, the RBAC permission gate, active/inactive checks, token expiry and
 * login rate limiting. These exercise the shipped middleware chain (no injected identity), so a
 * broken gate fails here rather than in the unit tests.
 */

const API = '/api/v1';
const NOW = new Date('2026-10-26T10:00:00Z');
const PW = 'correct horse battery';

interface Harness {
  app: Express;
  auth: AuthService;
  clock: FixedClock;
  users: InMemoryUserRepository;
  audit: RecordingAuditSink;
  config: AppConfig;
}

async function makeUser(
  id: string,
  email: string,
  role: UserRecord['role'],
  overrides: Partial<UserRecord> = {},
): Promise<UserRecord> {
  const passwordHash = await hashPassword(PW, 4);
  return {
    id,
    email,
    passwordHash,
    fullName: email.split('@')[0] ?? 'User',
    role,
    departmentId: null,
    teamCategoryId: overrides.teamCategoryId ?? null,
    isActive: true,
    mustChangePassword: false,
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
    ...overrides,
  };
}

async function harness(
  seed: UserRecord[],
  options: { loginMax?: number } = {},
): Promise<Harness> {
  const config = loadConfig({
    NODE_ENV: 'test',
    CORS_ORIGINS: 'http://localhost:5173',
    JWT_ACCESS_SECRET: 'http-auth-test-secret-value-32-chars-x',
    BCRYPT_ROUNDS: '4',
    ACCESS_TOKEN_TTL_SECONDS: '900',
    RATE_LIMIT_LOGIN_MAX: String(options.loginMax ?? 1000),
    RATE_LIMIT_WINDOW_MS: '60000',
  });
  const clock = new FixedClock(NOW);
  const users = new InMemoryUserRepository(seed);
  const refresh = new InMemoryRefreshTokenStore(clock);
  const audit = new RecordingAuditSink();
  const built: BuiltApp = createApp({
    config,
    logger: createSilentLogger(),
    database: createDatabase(),
    clock,
    audit,
    userRepository: users,
    refreshStore: refresh,
  });
  return { app: built.app, auth: built.services.auth, clock, users, audit, config };
}

function loginAs(app: Express, email: string, password = PW) {
  return request(app).post(`${API}/auth/login`).send({ email, password });
}

describe('POST /auth/login', () => {
  it('returns a bearer session, sets an HttpOnly refresh cookie, and never returns the hash', async () => {
    const alice = await makeUser('100', 'alice@example.com', 'employee');
    const { app } = await harness([alice]);

    const response = await request(app)
      .post(`${API}/auth/login`)
      .send({ email: 'alice@example.com', password: PW })
      .expect(200);

    expect(loginResultSchema.parse(response.body.data)).toMatchObject({
      token_type: 'Bearer',
      user: { id: '100', role: 'employee' },
    });
    // The stored bcrypt hash must never appear anywhere in the response.
    expect(JSON.stringify(response.body)).not.toContain(alice.passwordHash);

    const cookie = String(response.headers['set-cookie'] ?? '');
    expect(cookie).toMatch(/esrs_refresh=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('gives the same generic 401 for an unknown email and a wrong password', async () => {
    const alice = await makeUser('100', 'alice@example.com', 'employee');
    const { app } = await harness([alice]);

    const unknown = await loginAs(app, 'ghost@example.com', PW).expect(401);
    const wrong = await loginAs(app, 'alice@example.com', 'totally-wrong-password').expect(401);

    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('refuses a deactivated account with 403 after the password is correct', async () => {
    const off = await makeUser('101', 'off@example.com', 'employee', { isActive: false });
    const { app } = await harness([off]);
    const response = await loginAs(app, 'off@example.com').expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('validates the body with Zod (missing password ⇒ 400)', async () => {
    const { app } = await harness([]);
    const response = await request(app)
      .post(`${API}/auth/login`)
      .send({ email: 'not-an-email' })
      .expect(400);
    expect(apiErrorBodySchema.parse(response.body).error.code).toBe('VALIDATION_ERROR');
  });

  it('rate-limits repeated login attempts from one client', async () => {
    const alice = await makeUser('100', 'alice@example.com', 'employee');
    const { app } = await harness([alice], { loginMax: 3 });

    for (let i = 0; i < 3; i += 1) {
      await loginAs(app, 'alice@example.com', 'wrong wrong wrong wrong').expect(401);
    }
    const blocked = await loginAs(app, 'alice@example.com').expect(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('protected routes require a valid access token', () => {
  it('rejects a missing token with 401 UNAUTHENTICATED', async () => {
    const { app } = await harness([]);
    const response = await request(app).get(`${API}/auth/me`).expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a malformed/forged token with 401', async () => {
    const { app } = await harness([]);
    await request(app)
      .get(`${API}/auth/me`)
      .set('Authorization', 'Bearer not.a.real.token')
      .expect(401);
  });

  it('rejects an expired token with 401 TOKEN_EXPIRED', async () => {
    const alice = await makeUser('100', 'alice@example.com', 'employee');
    const { app, clock, config } = await harness([alice]);
    const login = await loginAs(app, 'alice@example.com').expect(200);
    const token = login.body.data.access_token as string;

    await request(app).get(`${API}/auth/me`).set('Authorization', `Bearer ${token}`).expect(200);

    clock.advanceMinutes(Math.ceil(config.auth.accessTokenTtlSeconds / 60) + 1);
    const expired = await request(app)
      .get(`${API}/auth/me`)
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expect(expired.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('serves /auth/me as the caller only (no id ⇒ no IDOR)', async () => {
    const alice = await makeUser('100', 'alice@example.com', 'employee');
    const admin = await makeUser('999', 'admin@example.com', 'admin');
    const { app } = await harness([alice, admin]);
    const login = await loginAs(app, 'alice@example.com').expect(200);
    const token = login.body.data.access_token as string;

    // Even a client-supplied ?id= is ignored: the subject comes from the token.
    const response = await request(app)
      .get(`${API}/auth/me`)
      .query({ id: '999' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(safeUserSchema.parse(response.body.data)).toMatchObject({ id: '100', email: 'alice@example.com' });
  });
});

describe('RBAC: never trust a client-supplied role', () => {
  it('blocks a non-admin from the admin user directory (403)', async () => {
    const agent = await makeUser('200', 'agent@example.com', 'agent', { teamCategoryId: '5' });
    const { app } = await harness([agent]);
    const login = await loginAs(app, 'agent@example.com').expect(200);
    const token = login.body.data.access_token as string;

    await request(app)
      .get(`${API}/users`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    // Asserting an admin role in the body does not change the outcome: identity is from the token.
    await request(app)
      .post(`${API}/users`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'evil@example.com', full_name: 'Evil Admin', role: 'admin', initial_password: PW })
      .expect(403);
  });

  it('lets an admin provision a user that must change its password', async () => {
    const admin = await makeUser('999', 'admin@example.com', 'admin');
    const { app } = await harness([admin]);
    const login = await loginAs(app, 'admin@example.com').expect(200);
    const token = login.body.data.access_token as string;

    const created = await request(app)
      .post(`${API}/users`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'newbie@example.com', full_name: 'New Bie', role: 'employee', initial_password: PW })
      .expect(201);
    expect(safeUserSchema.parse(created.body.data)).toMatchObject({
      email: 'newbie@example.com',
      role: 'employee',
      must_change_password: true,
    });
    expect(JSON.stringify(created.body)).not.toContain(admin.passwordHash);

    // The provisioned user is gated until it rotates its temporary password.
    const firstLogin = await loginAs(app, 'newbie@example.com').expect(200);
    const tempToken = firstLogin.body.data.access_token as string;
    const blocked = await request(app)
      .get(`${API}/auth/me`)
      .set('Authorization', `Bearer ${tempToken}`)
      .expect(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });
});

describe('refresh rotation & logout over HTTP', () => {
  it('refreshes using the httpOnly cookie and rotates it', async () => {
    const alice = await makeUser('100', 'alice@example.com', 'employee');
    const { app } = await harness([alice]);
    const login = await loginAs(app, 'alice@example.com').expect(200);
    const cookie = String(login.headers['set-cookie'] ?? '');

    const refreshed = await request(app)
      .post(`${API}/auth/refresh`)
      .set('Cookie', cookie)
      .expect(200);
    expect(loginResultSchema.parse(refreshed.body.data).access_token).toBeTruthy();
    const rotated = String(refreshed.headers['set-cookie'] ?? '');
    expect(rotated).toMatch(/esrs_refresh=/);
  });

  it('logs out idempotently and clears the cookie', async () => {
    const { app } = await harness([]);
    await request(app).post(`${API}/auth/logout`).expect(204);

    const alice = await makeUser('100', 'alice@example.com', 'employee');
    const authed = await harness([alice]);
    const login = await loginAs(authed.app, 'alice@example.com').expect(200);
    const cookie = String(login.headers['set-cookie'] ?? '');
    const logout = await request(authed.app)
      .post(`${API}/auth/logout`)
      .set('Cookie', cookie)
      .expect(204);
    expect(String(logout.headers['set-cookie'] ?? '')).toMatch(/esrs_refresh=;/);
  });

  it('changes the password and invalidates the session', async () => {
    const alice = await makeUser('100', 'alice@example.com', 'employee');
    const { app } = await harness([alice]);
    const login = await loginAs(app, 'alice@example.com').expect(200);
    const token = login.body.data.access_token as string;

    await request(app)
      .post(`${API}/auth/change-password`)
      .set('Authorization', `Bearer ${token}`)
      .send({ current_password: PW, new_password: 'a brand new passphrase' })
      .expect(200);

    await loginAs(app, 'alice@example.com').expect(401);
    await loginAs(app, 'alice@example.com', 'a brand new passphrase').expect(200);
  });
});
