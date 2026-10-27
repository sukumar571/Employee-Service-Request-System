/**
 * Refresh-token store (docs/security-plan.md §3, migration 013 `refresh_tokens`). Only the SHA-256
 * hash of an opaque token is kept; `family_id` is the rotation chain so replaying a rotated token
 * revokes the whole family. The service depends on this port; Postgres backs it in production and
 * the in-memory adapter runs it in tests.
 */

export type RevokeReason =
  'rotated' | 'reuse_detected' | 'logged_out' | 'admin_revoked' | 'expired';

export interface RefreshRecord {
  readonly id: string;
  readonly userId: string;
  readonly familyId: string;
  readonly tokenHash: string;
  readonly parentTokenHash: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedReason: RevokeReason | null;
  /** Hash of the token that rotated this one (lineage), with the moment of rotation for the grace window. */
  readonly replacedByHash: string | null;
  readonly replacedAt: Date | null;
}

export interface NewRefreshToken {
  readonly userId: string;
  readonly familyId: string;
  readonly tokenHash: string;
  readonly parentTokenHash?: string | null;
  readonly expiresAt: Date;
}

export interface RefreshTokenStore {
  insert(token: NewRefreshToken): Promise<RefreshRecord>;
  findByHash(tokenHash: string): Promise<RefreshRecord | null>;
  /** Marks a still-valid token as rotated (the normal refresh path). */
  markRotated(id: string, replacedByHash: string, at: Date): Promise<void>;
  /** Revokes every token in a family (logout, reuse detection, password change). */
  revokeFamily(familyId: string, reason: RevokeReason): Promise<void>;
  /** Revokes all of a user's families except optionally one (used by change-password). */
  revokeAllForUser(userId: string, reason: RevokeReason, exceptFamilyId?: string): Promise<void>;
}
