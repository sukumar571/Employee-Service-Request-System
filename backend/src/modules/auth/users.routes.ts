import {
  createUserBodySchema,
  listUsersQuerySchema,
  safeUserSchema,
  updateUserBodySchema,
  userIdParamsSchema,
} from '@esrs/shared';
import { Router } from 'express';
import { parseBody, parseParams, parseQuery } from '../../http/validate.js';
import { sendCreated, sendResource } from '../../http/respond.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import type { AuthService } from './auth.service.js';

/**
 * Admin user provisioning (docs/requirements.md FR-1, ST-105). There is deliberately **no**
 * self-registration endpoint: accounts are created only by an ADMIN, who sets an initial password
 * the user must rotate on first login (`must_change_password`, ST-104).
 *
 * Every route here is authenticated and gated by `requirePermission('user.manage')` (admin-only in
 * the RBAC matrix). The actor's role is taken from the verified token, never from the request body,
 * so a caller cannot grant itself admin by posting `role: 'admin'` (docs/security-plan.md §4).
 */
export function createUsersRouter(service: AuthService): Router {
  const router = Router();

  // Router-level authN, then per-route authZ so an unauthenticated request fails 401 (not 403).
  router.use(authenticate(service));

  router.get('/', requirePermission('user.manage'), async (req, res) => {
    const query = parseQuery(listUsersQuerySchema, req);
    const users = await service.listUsers({
      ...(query.role !== undefined ? { role: query.role } : {}),
      ...(query.team !== undefined ? { teamCategoryId: query.team } : {}),
      ...(query.is_active !== undefined ? { isActive: query.is_active } : {}),
    });
    sendResource(res, safeUserSchema.array().parse(users));
  });

  router.post('/', requirePermission('user.manage'), async (req, res) => {
    const body = parseBody(createUserBodySchema, req);
    const claims = req.authClaims;
    if (!claims) throw new Error('authenticate did not populate claims');
    const user = await service.provisionUser(body, claims);
    sendCreated(res, safeUserSchema.parse(user));
  });

  router.patch('/:id', requirePermission('user.manage'), async (req, res) => {
    const { id } = parseParams(userIdParamsSchema, req);
    const body = parseBody(updateUserBodySchema, req);
    const claims = req.authClaims;
    if (!claims) throw new Error('authenticate did not populate claims');
    const user = await service.updateUser(id, body, claims);
    sendResource(res, safeUserSchema.parse(user));
  });

  return router;
}
