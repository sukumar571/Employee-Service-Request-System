import type { NewUser, UserListFilter, UserRecord, UserRepository } from './user.repository.js';

/**
 * In-memory `UserRepository` used when `DATABASE_URL` is absent and by the auth tests. It mirrors
 * the columns and rules of migration 005 (unique lower-cased email, lockout counters, soft
 * activation) so the same service logic runs against either adapter. Emails are matched
 * case-insensitively to reproduce the functional unique index `uq_users_email_lower`.
 */
export class InMemoryUserRepository implements UserRepository {
  private readonly rows = new Map<string, UserRecord>();
  private readonly emailIndex = new Map<string, string>();
  private nextId = 1;

  constructor(seed: readonly UserRecord[] = []) {
    for (const record of seed) this.put(record);
  }

  /** Test helper: insert a fully-formed record (bypasses the create() id allocation). */
  put(record: UserRecord): void {
    this.rows.set(record.id, record);
    this.emailIndex.set(record.email.toLowerCase(), record.id);
    const numeric = Number(record.id);
    if (Number.isFinite(numeric) && numeric >= this.nextId) this.nextId = numeric + 1;
  }

  findByEmail(email: string): Promise<UserRecord | null> {
    const id = this.emailIndex.get(email.toLowerCase());
    return Promise.resolve(id ? (this.rows.get(id) ?? null) : null);
  }

  findById(id: string): Promise<UserRecord | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  create(user: NewUser): Promise<UserRecord> {
    const email = user.email.toLowerCase();
    if (this.emailIndex.has(email)) {
      return Promise.reject(new Error(`email_taken:${email}`));
    }
    const record: UserRecord = {
      id: String(this.nextId++),
      email: user.email,
      passwordHash: user.passwordHash,
      fullName: user.fullName,
      role: user.role,
      departmentId: user.departmentId ?? null,
      teamCategoryId: user.teamCategoryId ?? null,
      isActive: true,
      mustChangePassword: true, // ST-104: an admin-provisioned account must change its password first
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: null,
    };
    this.put(record);
    return Promise.resolve(record);
  }

  list(filter: UserListFilter): Promise<UserRecord[]> {
    const rows = [...this.rows.values()].filter(
      (row) =>
        (filter.role === undefined || row.role === filter.role) &&
        (filter.teamCategoryId === undefined || row.teamCategoryId === filter.teamCategoryId) &&
        (filter.isActive === undefined || row.isActive === filter.isActive),
    );
    return Promise.resolve(rows.sort((a, b) => a.email.localeCompare(b.email)));
  }

  onLoginSuccess(id: string, at: Date): Promise<void> {
    this.mutate(id, { failedLoginCount: 0, lockedUntil: null, lastLoginAt: at });
    return Promise.resolve();
  }

  onLoginFailure(
    id: string,
    at: Date,
    maxFailures: number,
    lockoutMinutes: number,
  ): Promise<UserRecord> {
    const current = this.rows.get(id);
    if (!current) return Promise.reject(new Error(`unknown_user:${id}`));
    const failedLoginCount = current.failedLoginCount + 1;
    const lockedUntil =
      failedLoginCount >= maxFailures
        ? new Date(at.getTime() + lockoutMinutes * 60_000)
        : current.lockedUntil;
    const updated = this.mutate(id, { failedLoginCount, lockedUntil })!;
    return Promise.resolve(updated);
  }

  updatePassword(id: string, passwordHash: string): Promise<void> {
    this.mutate(id, { passwordHash, mustChangePassword: false });
    return Promise.resolve();
  }

  update(
    id: string,
    patch: Partial<Omit<UserRecord, 'id' | 'email' | 'passwordHash'>>,
  ): Promise<UserRecord | null> {
    return Promise.resolve(this.mutate(id, patch));
  }

  countActiveAdmins(): Promise<number> {
    return Promise.resolve(
      [...this.rows.values()].filter((row) => row.role === 'admin' && row.isActive).length,
    );
  }

  private mutate(id: string, patch: Partial<UserRecord>): UserRecord | null {
    const current = this.rows.get(id);
    if (!current) return null;
    const updated = { ...current, ...patch };
    this.rows.set(id, updated);
    return updated;
  }
}
