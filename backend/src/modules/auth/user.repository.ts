import type { UserRole } from '@esrs/shared';

/**
 * Persistence port for the `users` table (docs/database-design.md §2.1, migration 005).
 * The service and HTTP layers depend on this interface only; the Postgres adapter is used when
 * `DATABASE_URL` is set and the in-memory adapter keeps the auth flow testable without a database
 * (the same port/adapter split as the SLA module).
 *
 * `passwordHash` is present on the records this port returns so the service can verify a login —
 * it is stripped by the DTO layer before anything reaches the wire (docs/security-plan.md §2).
 */
export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly fullName: string;
  readonly role: UserRole;
  readonly departmentId: string | null;
  readonly teamCategoryId: string | null;
  readonly isActive: boolean;
  readonly mustChangePassword: boolean;
  readonly failedLoginCount: number;
  readonly lockedUntil: Date | null;
  readonly lastLoginAt: Date | null;
}

/** Fields an admin supplies when provisioning a user; the password is already hashed (ST-105). */
export interface NewUser {
  readonly email: string;
  readonly passwordHash: string;
  readonly fullName: string;
  readonly role: UserRole;
  readonly departmentId?: string | null;
  readonly teamCategoryId?: string | null;
}

export interface UserRepository {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  create(user: NewUser): Promise<UserRecord>;
  list(filter: UserListFilter): Promise<UserRecord[]>;
  /** Records a successful login: resets the failure counter, stamps last_login_at. */
  onLoginSuccess(id: string, at: Date): Promise<void>;
  /**
   * Records a failed login and returns the updated lockout state so the service can decide the
   * response (generic 401 vs 423 locked). Locking is applied when the counter reaches the threshold.
   */
  onLoginFailure(id: string, at: Date, maxFailures: number, lockoutMinutes: number): Promise<UserRecord>;
  /** Replaces the password hash and clears the forced-change flag. */
  updatePassword(id: string, passwordHash: string): Promise<void>;
  /** Admin edit of profile/role/active flags. Returns the fresh record or null when absent. */
  update(id: string, patch: Partial<Omit<UserRecord, 'id' | 'email' | 'passwordHash'>>): Promise<UserRecord | null>;
  countActiveAdmins(): Promise<number>;
}

export interface UserListFilter {
  readonly role?: UserRole;
  readonly teamCategoryId?: string;
  readonly isActive?: boolean;
}
