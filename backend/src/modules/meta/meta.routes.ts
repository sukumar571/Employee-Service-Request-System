import { Router } from 'express';
import {
  COMMENT_VISIBILITIES,
  CONTRACT_VERSION,
  DEFAULT_BUSINESS_HOURS,
  DEFAULT_SLA_POLICIES,
  NOTIFICATION_TYPES,
  REQUEST_ACTIONS,
  REQUEST_EVENT_TYPES,
  REQUEST_PRIORITIES,
  REQUEST_STATUSES,
  SLA_STATES,
  SLA_WARNING_RATIO,
  USER_ROLES,
  lifecycleRules,
  type ApiCatalog,
} from '@esrs/shared';
import { sendResource } from '../../http/respond.js';

export interface MetaDependencies {
  readonly serviceName: string;
  readonly apiVersion: string;
  readonly documentationPath: string;
}

/**
 * `GET /meta` (public) — the contract-driven catalogue for the SPA.
 * Values come from `@esrs/shared` only, so this endpoint cannot drift from the backend's own rules.
 */
export function buildCatalog(deps: MetaDependencies): ApiCatalog {
  return {
    contract_version: CONTRACT_VERSION,
    api: {
      service: deps.serviceName,
      api_version: deps.apiVersion,
      documentation: deps.documentationPath,
    },
    catalog: {
      roles: [...USER_ROLES],
      statuses: [...REQUEST_STATUSES],
      priorities: [...REQUEST_PRIORITIES],
      actions: [...REQUEST_ACTIONS],
      sla_states: [...SLA_STATES],
      comment_visibilities: [...COMMENT_VISIBILITIES],
      event_types: [...REQUEST_EVENT_TYPES],
      notification_types: [...NOTIFICATION_TYPES],
    },
    transitions: lifecycleRules(),
    sla: {
      business_hours: DEFAULT_BUSINESS_HOURS,
      warning_ratio: SLA_WARNING_RATIO,
      default_policies: DEFAULT_SLA_POLICIES,
    },
  };
}

export function createMetaRouter(deps: MetaDependencies): Router {
  const router = Router();
  const catalog = buildCatalog(deps);

  router.get('/', (_req, res) => {
    sendResource(res, catalog);
  });

  return router;
}
