import { loginResultSchema, type SafeUser } from '@esrs/shared';
import { describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../../config/env.js';
import { FixedClock } from '../../domain/ports/clock.js';
import { AppError } from '../../lib/errors/appError.js';
import { RecordingAuditSink } from '../../ports/audit.js';
import { AuthService } from './auth.service.js';
import { hashPassword } from './passwords.js';
import { InMemoryRefreshTokenStore } from './refreshToken.store.memory.js';
import { InMemoryUserRepository } from './user.repository.memory.js';
import type { UserRecord } from './user.repository.js';

/**
 * Unit tests for the authentication service (docs/test-plan.md §6 SEC-TC-*). The whole flow runs
 * against in-memory adapters and a `FixedClock`, so no database or HTTP layer is involved — the same
 * port/adapter split the SLA service is tested with.
 */

const NOW = new Date('2026-10-26T10:00:00Z');
const PLAINTEXT = 'correct horse battery'; // 22 chars, satisfies the 12-char policy

function testConfig(): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    JWT_ACCESS_SECRET: 'unit-test-secret-please-never-in-prod!!',
    BCRYPT_ROUNDS: '4',
    ACCESS_TOKEN_TTL_SECONDS: '900',
    LOGIN_MAX_FAILURES: '3',
    LOGIN_LOCKOUT_MINUTES: '15',
  });
}

async function record(
  overrides: Partial<UserRecord> & Pick<UserRecord, 'id' | 'email' | 'role'>,
  password = PLAINTEXT,
): Promise<UserRecord> {
  const passwordHash = await hashPassword(password, 4);
  return {
    passwordHash,
    fullName: 'Test User',
    departmentId: null,
    teamCategoryId: null,
    isActive: true,
    mustChangePassword: false,
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
    ...overrides,
  };
}

function build(seed: UserRecord[], reuseGraceMs = 10_000) {
  const config = testConfig();
  const clock = new FixedClock(NOW);
  const users = new InMemoryUserRepository(seed);
  const refresh = new InMemoryRefreshTokenStore(clock);
  const audit = new RecordingAuditSink();
  const service = new AuthService({ users, refresh, clock, audit, config, reuseGraceMs });
  return { service, users, refresh, clock, audit, config };
}

describe('AuthService.login', () => {
  it('issues a verifiable access token + safe user and never leaks the hash', async () => {
    const alice = await record({ id: '100', email: 'alice@corp', role: 'employee' });
    const { service, audit } = build([alice]);

    const session = await service.login({ email: 'ALICE@corp ', password: PLAINTEXT });

    // loginResultSchema has no password field, so a successful parse proves the hash is absent.
    expect(loginResultSchema.parse(session.result)).toMatchObject({
      token_type: 'Bearer',
      expires_in: 900,
      user: { id: '100', email: 'alice@corp', role: 'employee' },
    });
    expect(JSON.stringify(session.result)).not.toContain(alice.passwordHash);

    const claims = service.verifyAccessToken(session.result.access_token);
    expect(claims).toMatchObject({ userId: '100', role: 'employee', mustChangePassword: false });
    expect(audit.entries.some((e) => e.action === 'auth.login.success')).toBe(true);
  });

  it('rejects an unknown email with the SAME generic message as a wrong password (no enumeration)', async () => {
    const alice = await record({ id: '100', email: 'alice@corp', role: 'employee' });
    const { service } = build([alice]);

    const unknown = await service
      .login({ email: 'ghost@corp', password: PLAINTEXT })
      .catch((e: unknown) => e);
    const wrong = await service
      .login({ email: 'alice@corp', password: 'not-the-password-at-all' })
      .catch((e: unknown) => e);

    expect(unknown).toBeInstanceOf(AppError);
    expect((unknown as AppError).code).toBe('INVALID_CREDENTIALS');
    expect(wrong).toBeInstanceOf(AppError);
    // Identical message ⇒ a caller cannot tell "no such account" from "bad password".
    expect((unknown as AppError).message).toBe((wrong as AppError).message);
  });

  it('rejects a deactivated account only after the password is proven correct', async () => {
    const dormant = await record({ id: '1', email: 'dormant@corp', role: 'employee', isActive: false });
    const { service } = build([dormant]);

    const badPw = await service
      .login({ email: 'dormant@corp', password: 'wrong wrong wrong wrong' })
      .catch((e: unknown) => e);
    expect((badPw as AppError).code).toBe('INVALID_CREDENTIALS');

    const inactive = await service
      .login({ email: 'dormant@corp', password: PLAINTEXT })
      .catch((e: unknown) => e);
    expect((inactive as AppError).code).toBe('FORBIDDEN');
    expect((inactive as AppError).message).toContain('deactivated');
  });

  it('locks the account once failures reach the threshold', async () => {
    const alice = await record({ id: '100', email: 'alice@corp', role: 'employee' });
    const { service } = build([alice]);
    const bad = { email: 'alice@corp', password: 'wrong wrong wrong wrong' };

    for (let i = 0; i < 3; i += 1) {
      await expect(service.login(bad)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    }
    // 4th attempt, even with the correct password, is refused until the lockout window elapses.
    await expect(service.login({ email: 'alice@corp', password: PLAINTEXT })).rejects.toMatchObject({
      code: 'ACCOUNT_LOCKED',
    });
  });
});

describe('AuthService.refresh (rotation + reuse detection)', () => {
  it('rotates the token and revokes the whole family on out-of-grace reuse', async () => {
    const alice = await record({ id: '100', email: 'alice@corp', role: 'employee' });
    const { service, clock } = build([alice]);

    const first = await service.login({ email: 'alice@corp', password: PLAINTEXT });
    const rotated = await service.refresh(first.refreshToken);
    expect(rotated.refreshToken).not.toBe(first.refreshToken);

    // Moving past the grace window turns a replay of the old token into reuse detection.
    clock.advanceMinutes(1);
    await expect(service.refresh(first.refreshToken)).rejects.toMatchObject({
      code: 'REFRESH_REUSE',
    });
    // The family is now dead: even the legitimate latest token no longer works.
    await expect(service.refresh(rotated.refreshToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('rejects an expired refresh token', async () => {
    const alice = await record({ id: '100', email: 'alice@corp', role: 'employee' });
    const { service, clock, config } = build([alice]);
    const session = await service.login({ email: 'alice@corp', password: PLAINTEXT });

    clock.set(new Date(NOW.getTime() + (config.auth.refreshTokenTtlDays + 1) * 86_400_000));
    await expect(service.refresh(session.refreshToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('rejects a missing refresh token', async () => {
    const { service } = build([]);
    await expect(service.refresh(undefined)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('AuthService.changePassword', () => {
  it('requires the current password for an established account and re-hashes with bcrypt', async () => {
    const alice = await record({ id: '100', email: 'alice@corp', role: 'employee' });
    const { service, users } = build([alice]);
    const session = await service.login({ email: 'alice@corp', password: PLAINTEXT });
    const claims = service.verifyAccessToken(session.result.access_token);

    await expect(
      service.changePassword(claims, { new_password: 'brand new passphrase' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const updated = await service.changePassword(claims, {
      current_password: PLAINTEXT,
      new_password: 'brand new passphrase',
    });
    expect(updated).toMatchObject({ id: '100' });

    const stored = await users.findById('100');
    expect(stored?.passwordHash).not.toBe(alice.passwordHash);
    expect(stored?.passwordHash).not.toContain('brand new');
    // Old credential no longer authenticates.
    await expect(service.login({ email: 'alice@corp', password: PLAINTEXT })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    await expect(
      service.login({ email: 'alice@corp', password: 'brand new passphrase' }),
    ).resolves.toBeTruthy();
  });

  it('lets a first-login (must_change_password) account skip the current password', async () => {
    const newbie = await record(
      { id: '200', email: 'new@corp', role: 'employee', mustChangePassword: true },
      'initial-temp-password',
    );
    const { service } = build([newbie]);
    const session = await service.login({ email: 'new@corp', password: 'initial-temp-password' });
    const claims = service.verifyAccessToken(session.result.access_token);
    expect(claims.mustChangePassword).toBe(true);

    const result: SafeUser = await service.changePassword(claims, {
      new_password: 'settled passphrase',
    });
    expect(result.must_change_password).toBe(false);
  });

  it('invalidates every session after a password change', async () => {
    const alice = await record({ id: '100', email: 'alice@corp', role: 'employee' });
    const { service } = build([alice]);
    const session = await service.login({ email: 'alice@corp', password: PLAINTEXT });
    const claims = service.verifyAccessToken(session.result.access_token);

    await service.changePassword(claims, { current_password: PLAINTEXT, new_password: 'a different one' });
    await expect(service.refresh(session.refreshToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });
});

describe('AuthService provisioning & admin guards', () => {
  const adminClaims = (id = '999') => ({
    userId: id,
    role: 'admin' as const,
    teamCategoryId: null,
    mustChangePassword: false,
    jti: 'admin-jti',
  });

  it('provisions an account that must change its temporary password', async () => {
    const admin = await record({ id: '999', email: 'admin@corp', role: 'admin' });
    const { service } = build([admin]);

    const created = await service.provisionUser(
      { email: 'fresh@corp', full_name: 'Fresh User', role: 'agent', initial_password: PLAINTEXT },
      adminClaims(),
    );
    expect(created).toMatchObject({ email: 'fresh@corp', role: 'agent', must_change_password: true });

    await expect(
      service.provisionUser(
        { email: 'FRESH@corp', full_name: 'Dup Name', role: 'employee', initial_password: PLAINTEXT },
        adminClaims(),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses to deactivate or demote the last active admin', async () => {
    const soloAdmin = await record({ id: '999', email: 'admin@corp', role: 'admin' });
    const { service } = build([soloAdmin]);

    await expect(service.updateUser('999', { is_active: false }, adminClaims())).rejects.toMatchObject({
      code: 'LAST_ADMIN_GUARD',
    });
    await expect(service.updateUser('999', { role: 'employee' }, adminClaims())).rejects.toMatchObject({
      code: 'LAST_ADMIN_GUARD',
    });
  });

  it('me() returns the caller record and unauthorized for an unknown subject', async () => {
    const alice = await record({ id: '100', email: 'alice@corp', role: 'employee' });
    const { service } = build([alice]);
    await expect(service.me('100')).resolves.toMatchObject({ id: '100', email: 'alice@corp' });
    await expect(service.me('does-not-exist')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
