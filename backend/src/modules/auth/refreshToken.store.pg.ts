import { AppError } from '../../lib/errors/appError.js';
import type { Database } from '../../db/pool.js';
import type {
  NewRefreshToken,
  RefreshRecord,
  RefreshTokenStore,
  RevokeReason,
} from './refreshToken.store.js';

/**
 * Postgres adapter for `refresh_tokens` (migrations 013 + 016). Only the SHA-256 hash of a token is
 * ever stored; the raw value is returned to the client once and never persisted (docs/security-plan.md §3).
 * `uuid`/`bigint` columns arrive as strings from `pg`, matching the port's string ids.
 */
const REVOKE_REASONS: readonly RevokeReason[] = [
  'rotated',
  'reuse_detected',
  'logged_out',
  'admin_revoked',
  'expired',
];

interface RefreshRow {
  readonly id: string;
  readonly user_id: string;
  readonly family_id: string;
  readonly token_hash: string;
  readonly parent_token_hash: string | null;
  readonly replaced_by: string | null;
  readonly revoked_reason: string | null;
  readonly expires_at: Date;
  readonly created_at: Date;
  readonly replaced_at: Date | null;
}

const COLUMNS = `id, user_id, family_id, token_hash, parent_token_hash, replaced_by,
  revoked_reason, expires_at, created_at, replaced_at`;

export class PostgresRefreshTokenStore implements RefreshTokenStore {
  constructor(private readonly database: Database) {}

  async insert(token: NewRefreshToken): Promise<RefreshRecord> {
    const result = await this.database.query<RefreshRow>(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, parent_token_hash, expires_at)
       VALUES ($1::bigint, $2::uuid, $3, $4, $5)
       RETURNING ${COLUMNS}`,
      [
        token.userId,
        token.familyId,
        token.tokenHash,
        token.parentTokenHash ?? null,
        token.expiresAt,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new AppError('INTERNAL', 'Refresh-token insert returned no row');
    return toRecord(row);
  }

  async findByHash(tokenHash: string): Promise<RefreshRecord | null> {
    const result = await this.database.query<RefreshRow>(
      `SELECT ${COLUMNS} FROM refresh_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async markRotated(id: string, replacedByHash: string, at: Date): Promise<void> {
    await this.database.query(
      `UPDATE refresh_tokens SET revoked_reason = 'rotated', replaced_by = $2, replaced_at = $3
       WHERE id = $1::uuid`,
      [id, replacedByHash, at],
    );
  }

  async revokeFamily(familyId: string, reason: RevokeReason): Promise<void> {
    await this.database.query(
      `UPDATE refresh_tokens SET revoked_reason = $2
       WHERE family_id = $1::uuid AND revoked_reason IS NULL`,
      [familyId, reason],
    );
  }

  async revokeAllForUser(
    userId: string,
    reason: RevokeReason,
    exceptFamilyId?: string,
  ): Promise<void> {
    await this.database.query(
      `UPDATE refresh_tokens SET revoked_reason = $2
       WHERE user_id = $1::bigint
         AND revoked_reason IS NULL
         AND ($3::uuid IS NULL OR family_id <> $3::uuid)`,
      [userId, reason, exceptFamilyId ?? null],
    );
  }
}

function toRecord(row: RefreshRow): RefreshRecord {
  return {
    id: row.id,
    userId: row.user_id,
    familyId: row.family_id,
    tokenHash: row.token_hash,
    parentTokenHash: row.parent_token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedReason: parseReason(row.revoked_reason),
    replacedByHash: row.replaced_by,
    replacedAt: row.replaced_at,
  };
}

function parseReason(value: string | null): RevokeReason | null {
  if (value === null) return null;
  const match: RevokeReason | undefined = REVOKE_REASONS.find((reason) => reason === value);
  if (!match) {
    throw new AppError('INTERNAL', 'Stored refresh token has an unknown revoke reason', {
      cause: value,
    });
  }
  return match;
}
