import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type RequestHandler, Router } from 'express';
import helmet from 'helmet';
import type { AppConfig } from './config/env.js';
import { API_BASE_PATH, API_VERSION } from './config/version.js';
import { PostgresAuditSink } from './db/audit.pg.js';
import type { Database } from './db/pool.js';
import { RecordingAuditSink, type AuditSink } from './ports/audit.js';
import { systemClock, type Clock } from './domain/ports/clock.js';
import type { Logger } from './lib/logger.js';
import { authenticate, passwordChangeGate } from './middleware/authenticate.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFoundHandler } from './middleware/notFoundHandler.js';
import { requestContext } from './middleware/requestContext.js';
import { requestLogger } from './middleware/requestLogger.js';
import { InMemoryRefreshTokenStore } from './modules/auth/refreshToken.store.memory.js';
import { PostgresRefreshTokenStore } from './modules/auth/refreshToken.store.pg.js';
import type { RefreshTokenStore } from './modules/auth/refreshToken.store.js';
import { InMemoryUserRepository } from './modules/auth/user.repository.memory.js';
import { PostgresUserRepository } from './modules/auth/user.repository.pg.js';
import type { UserRepository } from './modules/auth/user.repository.js';
import { AuthService } from './modules/auth/auth.service.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createUsersRouter } from './modules/auth/users.routes.js';
import { createHealthRouter } from './modules/health/health.routes.js';
import { createMetaRouter } from './modules/meta/meta.routes.js';
import { InMemoryRequestRepository } from './modules/request/request.repository.memory.js';
import { PostgresRequestRepository } from './modules/request/request.repository.pg.js';
import type { RequestRepository } from './modules/request/request.repository.js';
import { RequestActivityService } from './modules/request/request.activity.service.js';
import { createRequestRouter } from './modules/request/request.routes.js';
import { RequestService } from './modules/request/request.service.js';
import { InMemorySlaPolicyRepository } from './modules/sla/sla.repository.memory.js';
import { PostgresSlaPolicyRepository } from './modules/sla/sla.repository.pg.js';
import type { SlaPolicyRepository } from './modules/sla/sla.repository.js';
import { createSlaRouter } from './modules/sla/sla.routes.js';
import { SlaService } from './modules/sla/sla.service.js';

/**
 * Composition root (docs/system-architecture.md §4). Everything the routes need is injected here,
 * so tests can build an app with a fixed clock, an in-memory repository and a fabricated identity.
 */
export interface AppDependencies {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly database: Database;
  readonly clock?: Clock;
  readonly slaRepository?: SlaPolicyRepository;
  /** Overrides the `requests` adapter (tests seed an in-memory repository; else memory-or-Postgres). */
  readonly requestRepository?: RequestRepository;
  readonly audit?: AuditSink;
  /** Overrides the `users` adapter (tests seed an in-memory repository; else memory-or-Postgres). */
  readonly userRepository?: UserRepository;
  /** Overrides the refresh-token store (tests use an in-memory store; else memory-or-Postgres). */
  readonly refreshStore?: RefreshTokenStore;
  /**
   * Identity gate for the business APIs (sets `req.auth`). Defaults to the real JWT `authenticate`
   * middleware; tests inject a fabricated actor to drive the permission matrix without minting tokens.
   */
  readonly identity?: RequestHandler;
}

export interface BuiltApp {
  readonly app: Express;
  readonly services: {
    readonly sla: SlaService;
    readonly request: RequestService;
    readonly activity: RequestActivityService;
    readonly auth: AuthService;
    readonly clock: Clock;
    readonly audit: AuditSink;
  };
}

export function createApp(deps: AppDependencies): BuiltApp {
  const { config, logger, database } = deps;
  const clock = deps.clock ?? systemClock;

  const audit: AuditSink =
    deps.audit ??
    (database.configured ? new PostgresAuditSink(database, logger) : new RecordingAuditSink()); // no database yet: keep the trail visible in memory

  const slaRepository =
    deps.slaRepository ??
    (database.configured
      ? new PostgresSlaPolicyRepository(database)
      : new InMemorySlaPolicyRepository(clock, undefined, audit));

  const userRepository =
    deps.userRepository ??
    (database.configured ? new PostgresUserRepository(database) : new InMemoryUserRepository());

  const refreshStore =
    deps.refreshStore ??
    (database.configured
      ? new PostgresRefreshTokenStore(database)
      : new InMemoryRefreshTokenStore(clock));

  // The `UserRepository` structurally satisfies `UserDirectory`: the request module reads display
  // names and role/team scoping, never credentials, so it never imports another module's repository.
  const requestRepository =
    deps.requestRepository ??
    (database.configured
      ? new PostgresRequestRepository(database)
      : // In memory mode the repository owns the audit sink: request writes describe their audit rows
        // and this adapter records them, which is what keeps `audit.entries` meaningful without a
        // database. On Postgres the same rows are inserted on the transaction's own client instead.
        new InMemoryRequestRepository({ clock, directory: userRepository, audit }));

  const slaService = new SlaService({ repository: slaRepository, clock });
  const requestService = new RequestService({
    repository: requestRepository,
    directory: userRepository,
    clock,
    sla: slaService,
  });
  // Comments and the activity trail are a second service over the same aggregate: they reuse the
  // request module's row-scope rule, so a thread can never be read by someone who cannot see the ticket.
  const activityService = new RequestActivityService({
    repository: requestRepository,
    requests: requestService,
    clock,
  });
  const authService = new AuthService({
    users: userRepository,
    refresh: refreshStore,
    clock,
    audit,
    config,
  });

  const app = express();
  app.disable('x-powered-by');
  // 0 hops = disabled, so a local client cannot spoof X-Forwarded-For into the audit rows.
  app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: false, // the API returns JSON only; the SPA sets its own CSP
      crossOriginResourcePolicy: { policy: 'same-origin' },
    }),
  );

  if (config.corsOrigins.length > 0) {
    app.use(
      cors({ origin: config.corsOrigins, credentials: true, exposedHeaders: ['x-request-id'] }),
    );
  }

  app.use(requestContext());
  app.use(requestLogger(logger));
  app.use(express.json({ limit: `${config.bodyLimitKb}kb` }));
  // Reads the httpOnly refresh cookie set by the auth router (docs/security-plan.md §3).
  app.use(cookieParser());

  const api = Router();
  api.get('/', (_req, res) => {
    res.json({
      data: {
        service: config.serviceName,
        api_version: API_VERSION,
        base_path: API_BASE_PATH,
        endpoints: [
          '/health/live',
          '/health/ready',
          '/meta',
          '/auth/login',
          '/auth/refresh',
          '/auth/logout',
          '/auth/me',
          '/auth/change-password',
          '/users',
          '/requests',
          '/requests/:id',
          '/requests/:id/events',
          '/requests/:id/comments',
          '/requests/:id/timeline',
          '/requests/:id/{submit,claim,assign,start,hold,resume,resolve,close,reopen,cancel,transition}',
          '/sla/policies',
          '/sla/policies/:priority',
        ],
      },
    });
  });
  api.use('/health', createHealthRouter({ config, database, clock, version: API_VERSION }));
  api.use(
    '/meta',
    createMetaRouter({
      serviceName: config.serviceName,
      apiVersion: API_VERSION,
      documentationPath: '/docs/api-specification.md',
    }),
  );
  // Auth and user-admin routers guard themselves (public login/refresh/logout; the rest via the
  // route-level `authenticate` + `requirePermission`), so they mount BEFORE the business gate.
  api.use('/auth', createAuthRouter(authService, config));
  api.use('/users', createUsersRouter(authService));
  // Business APIs need an authenticated identity. Tests may inject a fabricated actor; production
  // uses the real JWT gate plus the forced-password-change gate (fail closed 401 / 403). Scoping the
  // gate to the protected router (rather than the whole API) keeps unknown routes at 404, not 401.
  const businessIdentity: RequestHandler[] = deps.identity
    ? [deps.identity]
    : [authenticate(authService), passwordChangeGate()];
  api.use('/sla', businessIdentity, createSlaRouter(slaService));
  // The comment and timeline routes mount inside `/requests/:id` (one identity gate, no double
  // authentication), so the request router owns the whole `/requests` surface.
  api.use('/requests', businessIdentity, createRequestRouter(requestService, activityService));

  app.use(API_BASE_PATH, api);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return {
    app,
    services: {
      sla: slaService,
      request: requestService,
      activity: activityService,
      auth: authService,
      clock,
      audit,
    },
  };
}
