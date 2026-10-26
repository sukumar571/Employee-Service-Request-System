import { Router } from 'express';
import { sendResource } from '../../http/respond.js';
import * as healthService from './health.service.js';

/** Public probes (docs/api-specification.md §2 row 13.1) — no auth, no rate limit. */
export function createHealthRouter(deps: healthService.HealthDependencies): Router {
  const router = Router();

  router.get('/live', (_req, res) => {
    sendResource(res, healthService.liveness(deps));
  });

  router.get('/ready', async (_req, res) => {
    const report = await healthService.readiness(deps);
    sendResource(res, report.status, report.httpStatus);
  });

  return router;
}
