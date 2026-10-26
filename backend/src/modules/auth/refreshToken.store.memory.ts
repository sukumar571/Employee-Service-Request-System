import type { Clock } from '../../domain/ports/clock.js';
import type {
  NewRefreshToken,
  RefreshRecord,
  RefreshTokenStore,
  RevokeReason,
} from './refreshToken.store.js';

/** In-memory refresh store mirroring migration 013: keyed by hash, family-revocable, rotation-aware. */
export class InMemoryRefreshTokenStore implements RefreshTokenStore {
  private readonly rows = new Map<string, RefreshRecord>();
  private readonly hashIndex = new Map<string, string>();
  private nextId = 1;

  constructor(private readonly clock: Clock) {}

  insert(token: NewRefreshToken): Promise<RefreshRecord> {
    const record: RefreshRecord = {
      id: String(this.nextId++),
      userId: token.userId,
      familyId: token.familyId,
      tokenHash: token.tokenHash,
      parentTokenHash: token.parentTokenHash ?? null,
      createdAt: this.clock.now(),
      expiresAt: token.expiresAt,
      revokedReason: null,
      replacedByHash: null,
      replacedAt: null,
    };
    this.rows.set(record.id, record);
    this.hashIndex.set(record.tokenHash, record.id);
    return Promise.resolve(record);
  }

  findByHash(tokenHash: string): Promise<RefreshRecord | null> {
    const id = this.hashIndex.get(tokenHash);
    return Promise.resolve(id ? (this.rows.get(id) ?? null) : null);
  }

  markRotated(id: string, replacedByHash: string, at: Date): Promise<void> {
    const current = this.rows.get(id);
    if (current) this.rows.set(id, { ...current, revokedReason: 'rotated', replacedByHash, replacedAt: at });
    return Promise.resolve();
  }

  revokeFamily(familyId: string, reason: RevokeReason): Promise<void> {
    for (const [id, record] of this.rows) {
      if (record.familyId === familyId && record.revokedReason === null) {
        this.rows.set(id, { ...record, revokedReason: reason });
      }
    }
    return Promise.resolve();
  }

  revokeAllForUser(userId: string, reason: RevokeReason, exceptFamilyId?: string): Promise<void> {
    for (const [id, record] of this.rows) {
      if (
        record.userId === userId &&
        record.revokedReason === null &&
        record.familyId !== exceptFamilyId
      ) {
        this.rows.set(id, { ...record, revokedReason: reason });
      }
    }
    return Promise.resolve();
  }
}
