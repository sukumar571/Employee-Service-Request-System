import { userRoleSchema } from '@esrs/shared';
import { AppError } from '../../lib/errors/appError.js';
import type { Database } from '../../db/pool.js';
import type { NewUser, UserListFilter, UserRecord, UserRepository } from './user.repository.js';

/**
 * Postgres adapter for `users` (migration 005). Parameterized SQL only (docs/security-plan.md §5).
 * BIGINT columns arrive as strings from `pg`, which is exactly what the port expects for `id`, so no
 * numeric coercion is applied — it would risk losing precision on ids beyond 2^53.
 */
interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly full_name: string;
  readonly role: string;
  readonly department_id: string | null;
  readonly team_category_id: string | null;
  readonly is_active: boolean;
  readonly must_change_password: boolean;
  readonly failed_login_count: number;
  readonly locked_until: Date | null;
  readonly last_login_at: Date | null;
}

const COLUMNS = `id, email, password_hash, full_name, role, department_id, team_category_id,
  is_active, must_change_password, failed_login_count, locked_until, last_login_at`;

export class PostgresUserRepository implements UserRepository {
  constructor(private readonly database: Database) {}

  async findByEmail(email: string): Promise<UserRecord | null> {
    const result = await this.database.query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE LOWER(email) = LOWER($1)`,
      [email],
    );
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const result = await this.database.query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE id = $1::bigint`,
      [id],
    );
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async create(user: NewUser): Promise<UserRecord> {
    const result = await this.database.query<UserRow>(
      `INSERT INTO users (email, password_hash, full_name, role, department_id, team_category_id,
                          is_active, must_change_password)
       VALUES ($1, $2, $3, $4::user_role, $5::bigint, $6::bigint, true, true)
       RETURNING ${COLUMNS}`,
      [
        user.email,
        user.passwordHash,
        user.fullName,
        user.role,
        user.departmentId ?? null,
        user.teamCategoryId ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new AppError('INTERNAL', 'User insert returned no row');
    return toRecord(row);
  }

  async list(filter: UserListFilter): Promise<UserRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.role !== undefined) {
      params.push(filter.role);
      clauses.push(`role = $${params.length}::user_role`);
    }
    if (filter.teamCategoryId !== undefined) {
      params.push(filter.teamCategoryId);
      clauses.push(`team_category_id = $${params.length}::bigint`);
    }
    if (filter.isActive !== undefined) {
      params.push(filter.isActive);
      clauses.push(`is_active = $${params.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.database.query<UserRow>(
      `SELECT ${COLUMNS} FROM users ${where} ORDER BY email ASC`,
      params,
    );
    return result.rows.map(toRecord);
  }

  async onLoginSuccess(id: string, at: Date): Promise<void> {
    await this.database.query(
      `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = $2, updated_at = now()
       WHERE id = $1::bigint`,
      [id, at],
    );
  }

  async onLoginFailure(
    id: string,
    at: Date,
    maxFailures: number,
    lockoutMinutes: number,
  ): Promise<UserRecord> {
    // One round-trip: increment, and arm locked_until only when the new count reaches the threshold.
    const lockUntil = new Date(at.getTime() + lockoutMinutes * 60_000);
    const result = await this.database.query<UserRow>(
      `UPDATE users
         SET failed_login_count = failed_login_count + 1,
             locked_until = CASE WHEN failed_login_count + 1 >= $2::int THEN $3::timestamptz ELSE locked_until END,
             updated_at = now()
       WHERE id = $1::bigint
       RETURNING ${COLUMNS}`,
      [id, maxFailures, lockUntil],
    );
    const row = result.rows[0];
    if (!row) throw new AppError('INTERNAL', 'Login-failure update matched no user');
    return toRecord(row);
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.database.query(
      `UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now()
       WHERE id = $1::bigint`,
      [id, passwordHash],
    );
  }

  async update(
    id: string,
    patch: Partial<Omit<UserRecord, 'id' | 'email' | 'passwordHash'>>,
  ): Promise<UserRecord | null> {
    const assignments: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown, cast?: string): void => {
      params.push(value);
      assignments.push(`${column} = $${params.length}${cast ? `::${cast}` : ''}`);
    };

    if (patch.fullName !== undefined) set('full_name', patch.fullName);
    if (patch.role !== undefined) set('role', patch.role, 'user_role');
    if (patch.departmentId !== undefined) set('department_id', patch.departmentId, 'bigint');
    if (patch.teamCategoryId !== undefined) set('team_category_id', patch.teamCategoryId, 'bigint');
    if (patch.isActive !== undefined) set('is_active', patch.isActive);
    if (patch.mustChangePassword !== undefined) set('must_change_password', patch.mustChangePassword);

    if (assignments.length === 0) return this.findById(id);

    params.push(id);
    const result = await this.database.query<UserRow>(
      `UPDATE users SET ${assignments.join(', ')}, updated_at = now()
       WHERE id = $${params.length}::bigint
       RETURNING ${COLUMNS}`,
      params,
    );
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async countActiveAdmins(): Promise<number> {
    const result = await this.database.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count FROM users WHERE role = 'admin' AND is_active`,
    );
    return Number(result.rows[0]?.count ?? '0');
  }
}

function toRecord(row: UserRow): UserRecord {
  const parsedRole = userRoleSchema.safeParse(row.role);
  if (!parsedRole.success) {
    throw new AppError('INTERNAL', 'Stored user role is not a known enum value', {
      cause: row.role,
    });
  }
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    fullName: row.full_name,
    role: parsedRole.data,
    departmentId: row.department_id,
    teamCategoryId: row.team_category_id,
    isActive: row.is_active,
    mustChangePassword: row.must_change_password,
    failedLoginCount: row.failed_login_count,
    lockedUntil: row.locked_until,
    lastLoginAt: row.last_login_at,
  };
}
