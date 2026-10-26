import { createHash, randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { UserRole } from '@esrs/shared';
import type { Clock } from '../../domain/ports/clock.js';
import { AppError } from '../../lib/errors/appError.js';

/**
 * Token primitives (docs/security-plan.md §3). Kept free of Express and the database so the service
 * orchestrates flows while these stay directly unit-testable against a `FixedClock`.
 *
 * Access = short-lived HS256 JWT carried in `Authorization: Bearer` (kept in SPA memory, never in
 * localStorage). Refresh = opaque 256-bit random string, stored only as a SHA-256 hash, delivered in
 * an httpOnly cookie and rotated on every use with family-based reuse detection.
 */

export interface TokenConfig {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly accessTtlSeconds: number;
  readonly clock: Clock;
}

/** The claims the API trusts. `role`/`team` come from the signed token, never from the client body. */
export interface AccessClaims {
  readonly userId: string;
  readonly role: UserRole;
  readonly teamCategoryId: string | null;
  readonly mustChangePassword: boolean;
  readonly jti: string;
}

export function signAccessToken(claims: AccessClaims, cfg: TokenConfig): string {
  // Pin `iat` to the injected clock (and suppress the library default) so `exp` is derived from the
  // test clock and an expired token is reproducible without sleeping.
  const issuedAtSeconds = Math.floor(cfg.clock.now().getTime() / 1000);
  return jwt.sign(
    {
      role: claims.role,
      team: claims.teamCategoryId,
      mcp: claims.mustChangePassword,
      iat: issuedAtSeconds,
    },
    cfg.secret,
    {
      algorithm: 'HS256',
      subject: claims.userId,
      jwtid: claims.jti,
      issuer: cfg.issuer,
      audience: cfg.audience,
      expiresIn: cfg.accessTtlSeconds,
      noTimestamp: true,
    },
  );
}

/** Decoded claim set, typed at the boundary so downstream field reads are not `any`. */
interface DecodedClaims {
  readonly sub?: string;
  readonly jti?: string;
  readonly role?: unknown;
  readonly team?: unknown;
  readonly mcp?: unknown;
}

export function verifyAccessToken(token: string, cfg: TokenConfig): AccessClaims {
  let decoded: DecodedClaims;
  try {
    decoded = jwt.verify(token, cfg.secret, {
      // Pin the algorithm and verify iss/aud so a token minted by another service is rejected.
      algorithms: ['HS256'],
      issuer: cfg.issuer,
      audience: cfg.audience,
      clockTimestamp: Math.floor(cfg.clock.now().getTime() / 1000),
    }) as unknown as DecodedClaims;
  } catch (error) {
    // `TokenExpiredError` is not a static ESM export of the CJS `jsonwebtoken` package, so expiry is
    // detected by the error's `name` rather than `instanceof` — this keeps the import native-ESM safe.
    if (error instanceof Error && error.name === 'TokenExpiredError') {
      throw new AppError('TOKEN_EXPIRED', 'Access token has expired');
    }
    throw new AppError('UNAUTHENTICATED', 'Access token is invalid');
  }

  const { sub, role } = decoded;
  if (typeof sub !== 'string' || typeof role !== 'string') {
    throw new AppError('UNAUTHENTICATED', 'Access token is invalid');
  }
  return {
    userId: sub,
    role: role as UserRole,
    teamCategoryId: typeof decoded.team === 'string' ? decoded.team : null,
    mustChangePassword: decoded.mcp === true,
    jti: typeof decoded.jti === 'string' ? decoded.jti : '',
  };
}

/** Opaque refresh token: 256 bits of entropy, URL-safe, never derived from user data. */
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function newTokenFamilyId(): string {
  return randomUUID();
}

/** Only the SHA-256 hash is persisted (migration 013) — a database dump never yields a usable token. */
export function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
