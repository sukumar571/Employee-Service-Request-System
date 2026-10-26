import { z } from 'zod';
import { userRoleSchema } from '../enums/index.js';

/**
 * Authentication & user-management contract (docs/api-specification.md §3, §4).
 * These schemas are the single source of truth for both the SPA forms and the API parsing, so a
 * field the client sends is validated by the exact same rules on the server.
 *
 * Wire format is snake_case (docs/api-specification.md §1). The password hash never appears in any
 * of these output schemas — it lives only in the persistence layer (docs/security-plan.md §2).
 */

/** A password a human can type but a bot cannot brute-force cheaply (security-plan §2: min 12). */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters');

export const loginBodySchema = z
  .object({
    // `z.email()` normalises nothing; the service lower-cases before lookup (matches the
    // functional unique index on LOWER(email) in migration 005).
    email: z.email('Enter a valid email address').max(254),
    password: z.string().min(1, 'Password is required').max(128),
  })
  .strict();
export type LoginBody = z.infer<typeof loginBodySchema>;

/**
 * The user object safe to return over the wire: identity + entitlements, never secrets.
 * `id` is the stringified database key so the browser keeps full 64-bit precision.
 */
export const safeUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  full_name: z.string(),
  role: userRoleSchema,
  department_id: z.string().nullable(),
  team_category_id: z.string().nullable(),
  is_active: z.boolean(),
  must_change_password: z.boolean(),
});
export type SafeUser = z.infer<typeof safeUserSchema>;

/** `POST /auth/login` and `POST /auth/refresh` success body (the refresh cookie is Set-Cookie, not JSON). */
export const loginResultSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  user: safeUserSchema,
});
export type LoginResult = z.infer<typeof loginResultSchema>;

/**
 * `POST /auth/change-password`. `current_password` is required once the forced-change gate is past
 * it; on the very first login (must_change_password) it may be omitted because the seeded/initial
 * password is the one being replaced — the service still verifies it when supplied.
 */
export const changePasswordBodySchema = z
  .object({
    current_password: z.string().min(1).max(128).optional(),
    new_password: passwordSchema,
  })
  .strict()
  .refine((body) => body.current_password === undefined || body.current_password !== body.new_password, {
    message: 'The new password must differ from the current password',
    path: ['new_password'],
  });
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;

/**
 * `POST /users` — admin provisioning only (there is deliberately no self-registration;
 * docs/security-plan.md §2). The admin sets an initial password the user must change on first login.
 */
export const createUserBodySchema = z
  .object({
    email: z.email('Enter a valid email address').max(254),
    full_name: z.string().trim().min(2, 'Name is too short').max(120),
    role: userRoleSchema,
    department_id: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).optional(),
    team_category_id: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).optional(),
    initial_password: passwordSchema,
  })
  .strict();
export type CreateUserBody = z.infer<typeof createUserBodySchema>;

/** `PATCH /users/:id` — role/team/active edits. All optional; at least one required (checked in service). */
export const updateUserBodySchema = z
  .object({
    full_name: z.string().trim().min(2).max(120).optional(),
    role: userRoleSchema.optional(),
    department_id: z.union([z.string().regex(/^\d+$/), z.number().int().positive(), z.null()]).optional(),
    team_category_id:
      z.union([z.string().regex(/^\d+$/), z.number().int().positive(), z.null()]).optional(),
    is_active: z.boolean().optional(),
  })
  .strict();
export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;

export const userIdParamsSchema = z.object({ id: z.string().regex(/^\d+$/, 'User id must be numeric') });

/** `GET /users` list query (admin). Filters are optional; pagination is clamped by the shared schema. */
export const listUsersQuerySchema = z.object({
  role: userRoleSchema.optional(),
  team: z.string().regex(/^\d+$/).optional(),
  is_active: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

/** `GET /auth/me` body — the SPA bootstraps its session and role guard from this. */
export const meResultSchema = safeUserSchema;
export type MeResult = z.infer<typeof meResultSchema>;
