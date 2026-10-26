import {
  slaPolicyDtoSchema,
  slaPolicyListSchema,
  updateSlaPolicyBodySchema,
  updateSlaPolicyParamsSchema,
} from '@esrs/shared';
import { Router } from 'express';
import { parseBody, parseParams } from '../../http/validate.js';
import { sendResource } from '../../http/respond.js';
import { currentActor, requirePermission } from '../../middleware/requirePermission.js';
import { currentRequestId } from '../../middleware/requestContext.js';
import type { SlaService } from './sla.service.js';

/**
 * SLA policy endpoints (docs/api-specification.md §9).
 * `GET /sla/policies` needs an identity, `PUT` needs manager+ — both gates are the same
 * `requirePermission` middleware, so the matrix test (docs/test-plan.md §6 SEC-TC-04) can drive
 * them with fabricated actors.
 */
export function createSlaRouter(service: SlaService): Router {
  const router = Router();

  router.get('/policies', requirePermission('sla_policy.read'), async (_req, res) => {
    const policies = await service.listPolicies();
    // Contract assertion at the boundary: what we send must satisfy the published schema.
    sendResource(res, slaPolicyListSchema.parse(policies));
  });

  router.put('/policies/:priority', requirePermission('sla_policy.update'), async (req, res) => {
    const { priority } = parseParams(updateSlaPolicyParamsSchema, req);
    const body = parseBody(updateSlaPolicyBodySchema, req);
    const policy = await service.updatePolicy(
      priority,
      body,
      currentActor(req, res),
      currentRequestId(),
    );
    sendResource(res, slaPolicyDtoSchema.parse(policy));
  });

  return router;
}
