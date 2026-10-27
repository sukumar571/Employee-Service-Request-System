import type {
  CreateUserBody,
  LoginBody,
  LoginResult,
  SafeUser,
  UpdateUserBody,
} from '@esrs/shared';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/env.js';
import type { Clock } from '../../domain/ports/clock.js';
import { AppError } from '../../lib/errors/appError.js';
import { forbidden, notFound, unauthorized } from '../../lib/errors/httpErrors.js';
import type { AuditSink } from '../../ports/audit.js';
import { burnPasswordCompare, hashPassword, verifyPassword } from './passwords.js';
import {
  hashRefreshToken,
  newRefreshToken,
  newTokenFamilyId,
  signAccessToken,
  verifyAccessToken,
  type AccessClaims,
  type TokenConfig,
} from './auth.tokens.js';
import type { RefreshRecord, RefreshTokenStore } from './refreshToken.store.js';
import type { UserListFilter, UserRecord, UserRepository } from './user.repository.js';

/** A completed login/refresh: the JSON body plus the raw refresh token for the Set-Cookie header. */
export interface SessionTokens {
  readonly result: LoginResult;
  readonly refreshToken: string;
}

export interface AuthServiceDeps {
  readonly users: UserRepository;
  readonly refresh: RefreshTokenStore;
  readonly clock: Clock;
  readonly audit: AuditSink;
  readonly config: AppConfig;
  /** Rotation race tolerance (docs/api-specification.md §3 refresh; requirements risk §"refresh race"). */
  readonly reuseGraceMs?: number;
}

const REFRESH_COOKIE_GRACE_MS = 10_000;

/**
 * Authentication & user-management service (docs/requirements.md FR-1/FR-2/FR-4/FR-5, ST-101…105).
 * This is the orchestration layer: it owns the credential checks, token issuing/verification,
 * lockout, refresh rotation with reuse detection and the audit trail. It never touches Express and
 * reaches persistence only through ports, so the whole flow is unit-testable against in-memory
 * adapters and a FixedClock.
 */
export class AuthService {
  private readonly users: UserRepository;
  private readonly refreshStore: RefreshTokenStore;
  private readonly clock: Clock;
  private readonly audit: AuditSink;
  private readonly config: AppConfig;
  private readonly graceMs: number;

  constructor(deps: AuthServiceDeps) {
    this.users = deps.users;
    this.refreshStore = deps.refresh;
    this.clock = deps.clock;
    this.audit = deps.audit;
    this.config = deps.config;
    this.graceMs = deps.reuseGraceMs ?? REFRESH_COOKIE_GRACE_MS;
  }

  /** Pure JWT verification used by the authenticate middleware (no I/O, no user lookup). */
  verifyAccessToken(token: string): AccessClaims {
    return verifyAccessToken(token, this.tokenConfig());
  }

  async login(body: LoginBody): Promise<SessionTokens> {
    const email = normalizeEmail(body.email);
    const now = this.clock.now();
    const record = await this.users.findByEmail(email);

    // Always run a bcrypt compare (real, or against the dummy hash) so the response time never
    // reveals whether the account exists (docs/security-plan.md §2, §4.2).
    if (!record) {
      await burnPasswordCompare(body.password);
      await this.recordAuthEvent('auth.login.failed', 'unknown', email, {
        reason: 'no_such_account',
      });
      throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password');
    }

    if (record.lockedUntil && record.lockedUntil.getTime() > now.getTime()) {
      throw new AppError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
    }

    const passwordOk = await verifyPassword(body.password, record.passwordHash);
    if (!passwordOk) {
      await this.users.onLoginFailure(
        record.id,
        now,
        this.config.auth.loginMaxFailures,
        this.config.auth.loginLockoutMinutes,
      );
      await this.recordAuthEvent('auth.login.failed', record.id, record.email, {
        reason: 'bad_password',
      });
      throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password');
    }

    // Active check runs only after a correct password, so a wrong-password probe cannot enumerate
    // disabled accounts. A deactivated user with the right password gets an explicit 403.
    if (!record.isActive) {
      await this.recordAuthEvent('auth.login.blocked', record.id, record.email, {
        reason: 'inactive',
      });
      throw forbidden('This account has been deactivated. Contact an administrator.');
    }

    await this.users.onLoginSuccess(record.id, now);
    await this.recordAuthEvent('auth.login.success', record.id, record.email, {});
    return this.issueSession(record, now);
  }

  async refresh(rawRefreshToken: string | undefined): Promise<SessionTokens> {
    if (!rawRefreshToken) throw unauthorized('No active session to refresh');
    const now = this.clock.now();
    const presented = await this.refreshStore.findByHash(hashRefreshToken(rawRefreshToken));
    if (!presented) throw unauthorized('Session is no longer valid');

    if (presented.expiresAt.getTime() <= now.getTime()) {
      await this.refreshStore.revokeFamily(presented.familyId, 'expired');
      throw unauthorized('Session expired, please sign in again');
    }

    const record = await this.users.findById(presented.userId);
    if (!record) throw unauthorized('Session is no longer valid');

    if (presented.revokedReason) {
      // A rotated token presented inside the grace window is an in-flight race (double submit):
      // mint a replacement from the same family instead of tearing the session down.
      const withinGrace =
        presented.revokedReason === 'rotated' &&
        presented.replacedAt !== null &&
        now.getTime() - presented.replacedAt.getTime() <= this.graceMs;
      if (withinGrace) return this.rotateInto(presented, record, now, false);
      if (presented.revokedReason === 'rotated') {
        // A rotated token replayed after the grace window means the chain leaked: poison the family.
        await this.refreshStore.revokeFamily(presented.familyId, 'reuse_detected');
        await this.recordAuthEvent('auth.refresh.reuse_detected', record.id, record.email, {
          family: presented.familyId,
        });
        throw new AppError('REFRESH_REUSE', 'Session reuse detected; please sign in again');
      }
      // Revoked by logout / password change / expiry: an invalid session, not a reuse signal.
      throw unauthorized('Session is no longer valid');
    }

    return this.rotateInto(presented, record, now, true);
  }

  /** Logout is idempotent: revoking an unknown/absent family is a no-op success. */
  async logout(rawRefreshToken: string | undefined): Promise<void> {
    if (!rawRefreshToken) return;
    const presented = await this.refreshStore.findByHash(hashRefreshToken(rawRefreshToken));
    if (!presented) return;
    await this.refreshStore.revokeFamily(presented.familyId, 'logged_out');
    await this.recordAuthEvent('auth.logout', presented.userId, '', { family: presented.familyId });
  }

  async changePassword(
    claims: AccessClaims,
    body: { current_password?: string; new_password: string },
  ): Promise<SafeUser> {
    const record = await this.users.findById(claims.userId);
    if (!record) throw unauthorized();

    // A first-login forced change (must_change_password) may omit current_password because the
    // holder of a freshly issued access token already proved the initial credential. Otherwise the
    // current password is mandatory.
    const requiresCurrent = !record.mustChangePassword;
    if (requiresCurrent && !body.current_password) {
      throw new AppError('VALIDATION_ERROR', 'Current password is required', {
        details: [{ path: 'current_password', message: 'Required to change an existing password' }],
      });
    }
    if (body.current_password !== undefined) {
      const ok = await verifyPassword(body.current_password, record.passwordHash);
      if (!ok) throw new AppError('INVALID_CREDENTIALS', 'Current password is incorrect');
    }

    const passwordHash = await hashPassword(body.new_password, this.config.auth.bcryptRounds);
    await this.users.updatePassword(record.id, passwordHash);
    // Password change invalidates every other session (docs/security-plan.md §2).
    await this.refreshStore.revokeAllForUser(record.id, 'admin_revoked');
    await this.recordAuthEvent('password.changed', record.id, record.email, {});

    const updated = await this.users.findById(record.id);
    return toSafeUser(updated ?? record);
  }

  /** `GET /auth/me` — always the caller's own record; there is no id parameter to abuse (IDOR-safe). */
  async me(userId: string): Promise<SafeUser> {
    const record = await this.users.findById(userId);
    if (!record) throw unauthorized();
    return toSafeUser(record);
  }

  // --- admin provisioning (ST-105): the route applies requirePermission('user.manage') ---

  async provisionUser(body: CreateUserBody, actor: AccessClaims): Promise<SafeUser> {
    const email = normalizeEmail(body.email);
    const existing = await this.users.findByEmail(email);
    if (existing) {
      throw new AppError('CONFLICT', 'A user with that email already exists');
    }
    const passwordHash = await hashPassword(body.initial_password, this.config.auth.bcryptRounds);
    const created = await this.users.create({
      email,
      passwordHash,
      fullName: body.full_name,
      role: body.role,
      departmentId: toIdOrNull(body.department_id),
      teamCategoryId: toIdOrNull(body.team_category_id),
    });
    await this.audit.record({
      actorId: actor.userId,
      actorRole: actor.role,
      action: 'user.created',
      entityType: 'user',
      entityId: created.id,
      after: { role: created.role, email },
    });
    return toSafeUser(created);
  }

  async listUsers(filter: UserListFilter): Promise<SafeUser[]> {
    const records = await this.users.list(filter);
    return records.map(toSafeUser);
  }

  async updateUser(id: string, patch: UpdateUserBody, actor: AccessClaims): Promise<SafeUser> {
    const target = await this.users.findById(id);
    if (!target) throw notFound('User');

    const demotesAdmin =
      target.role === 'admin' &&
      target.isActive &&
      ((patch.role !== undefined && patch.role !== 'admin') || patch.is_active === false);
    if (demotesAdmin && (await this.users.countActiveAdmins()) <= 1) {
      throw new AppError(
        'LAST_ADMIN_GUARD',
        'Cannot remove or deactivate the last active administrator',
      );
    }

    const updated = await this.users.update(id, {
      ...(patch.full_name !== undefined ? { fullName: patch.full_name } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.department_id !== undefined
        ? { departmentId: toIdOrNull(patch.department_id) }
        : {}),
      ...(patch.team_category_id !== undefined
        ? { teamCategoryId: toIdOrNull(patch.team_category_id) }
        : {}),
      ...(patch.is_active !== undefined ? { isActive: patch.is_active } : {}),
    });
    if (!updated) throw notFound('User');

    if (patch.role !== undefined || patch.is_active !== undefined) {
      await this.audit.record({
        actorId: actor.userId,
        actorRole: actor.role,
        action: patch.role !== undefined ? 'role.changed' : 'user.updated',
        entityType: 'user',
        entityId: id,
        before: { role: target.role, is_active: target.isActive },
        after: { role: updated.role, is_active: updated.isActive },
      });
    }
    return toSafeUser(updated);
  }

  // --- internals ---

  private async issueSession(record: UserRecord, now: Date): Promise<SessionTokens> {
    const familyId = newTokenFamilyId();
    const expiresAt = addDays(now, this.config.auth.refreshTokenTtlDays);
    const raw = newRefreshToken();
    await this.refreshStore.insert({
      userId: record.id,
      familyId,
      tokenHash: hashRefreshToken(raw),
      expiresAt,
    });
    return { result: this.buildResult(record), refreshToken: raw };
  }

  private async rotateInto(
    parent: RefreshRecord,
    record: UserRecord,
    now: Date,
    markOldRotated: boolean,
  ): Promise<SessionTokens> {
    const raw = newRefreshToken();
    const hash = hashRefreshToken(raw);
    // Inherit the family expiry so rotation cannot extend a session forever.
    await this.refreshStore.insert({
      userId: record.id,
      familyId: parent.familyId,
      tokenHash: hash,
      parentTokenHash: parent.tokenHash,
      expiresAt: parent.expiresAt,
    });
    if (markOldRotated) await this.refreshStore.markRotated(parent.id, hash, now);
    return { result: this.buildResult(record), refreshToken: raw };
  }

  private buildResult(record: UserRecord): LoginResult {
    const access = signAccessToken(
      {
        userId: record.id,
        role: record.role,
        teamCategoryId: record.teamCategoryId,
        mustChangePassword: record.mustChangePassword,
        jti: randomUUID(),
      },
      this.tokenConfig(),
    );
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: this.config.auth.accessTokenTtlSeconds,
      user: toSafeUser(record),
    };
  }

  private tokenConfig(): TokenConfig {
    return {
      secret: this.config.auth.jwtSecret,
      issuer: this.config.auth.jwtIssuer,
      audience: this.config.auth.jwtAudience,
      accessTtlSeconds: this.config.auth.accessTokenTtlSeconds,
      clock: this.clock,
    };
  }

  private async recordAuthEvent(
    action: string,
    actorId: string,
    entityId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      actorId,
      action,
      entityType: 'auth',
      entityId,
      after: detail,
    });
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toSafeUser(record: UserRecord): SafeUser {
  return {
    id: record.id,
    email: record.email,
    full_name: record.fullName,
    role: record.role,
    department_id: record.departmentId,
    team_category_id: record.teamCategoryId,
    is_active: record.isActive,
    must_change_password: record.mustChangePassword,
  };
}

function toIdOrNull(value: string | number | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}
