import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Environment parsing — validated at boot, fail fast, and never echo secret VALUES
 * (docs/security-plan.md §7). Only variable names appear in error messages.
 */

const optionalText = (min: number) => z.string().min(min).optional();

const rawEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  SERVICE_NAME: z.string().min(1).default('esrs-api'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: optionalText(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(250).max(60_000).default(5_000),

  JWT_ACCESS_SECRET: optionalText(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  JWT_ISSUER: z.string().min(1).default('esrs-api'),
  JWT_AUDIENCE: z.string().min(1).default('esrs-web'),
  /** bcrypt work factor. 12 is the policy (security-plan §2); tests drop it to keep the suite fast. */
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  /** Account lockout: N consecutive failures within the window locks the account (FR-5). */
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).max(20).default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().min(1).max(10_000).default(10),

  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  /**
   * Set to the number of proxies in front of the API (nginx/compose) so `req.ip` stays the real
   * client address for rate limiting and audit rows. Left false locally, where trusting any proxy
   * would let a client spoof its own address in `X-Forwarded-For`.
   */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  /** Body size cap for JSON payloads; attachment uploads are multipart and capped separately. */
  BODY_LIMIT_KB: z.coerce.number().int().min(8).max(1024).default(64),
});

export type Environment = z.infer<typeof rawEnvSchema>['NODE_ENV'];

export interface DatabaseConfig {
  url: string;
  poolMax: number;
  statementTimeoutMs: number;
}

export interface AppConfig {
  environment: Environment;
  isProduction: boolean;
  port: number;
  serviceName: string;
  logLevel: string;
  /** Undefined when DATABASE_URL is absent — the API still boots (health reports not_configured). */
  database?: DatabaseConfig;
  auth: {
    jwtSecret: string;
    /** True when the secret came from the environment; false for an ephemeral dev secret. */
    fromEnvironment: boolean;
    accessTokenTtlSeconds: number;
    refreshTokenTtlDays: number;
    /** `iss`/`aud` are verified on every token so a token minted elsewhere is rejected. */
    jwtIssuer: string;
    jwtAudience: string;
    bcryptRounds: number;
    loginMaxFailures: number;
    loginLockoutMinutes: number;
  };
  rateLimit: {
    windowMs: number;
    loginMax: number;
  };
  corsOrigins: string[];
  trustProxy: number;
  bodyLimitKb: number;
}

export class ConfigurationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigurationError';
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // Treat empty strings (common in copied .env files) as "not set".
  const normalized = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );

  const parsed = rawEnvSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const env = parsed.data;

  if (env.NODE_ENV === 'production' && env.JWT_ACCESS_SECRET === undefined) {
    throw new ConfigurationError([
      'JWT_ACCESS_SECRET: a secret of at least 32 characters is required in production',
    ]);
  }
  // The default value is a local dev origin; shipping it to production means CORS was forgotten.
  if (env.NODE_ENV === 'production' && /localhost|127\.0\.0\.1/.test(env.CORS_ORIGINS)) {
    throw new ConfigurationError([
      'CORS_ORIGINS: set the real web origin in production (localhost is not allowed)',
    ]);
  }

  const fromEnvironment = Boolean(env.JWT_ACCESS_SECRET);
  const jwtSecret =
    env.JWT_ACCESS_SECRET ??
    // Ephemeral, memory-only secret so local development never needs a committed value.
    `esrs-dev-ephemeral-${randomBytes(24).toString('base64url')}`;

  return {
    environment: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    port: env.PORT,
    serviceName: env.SERVICE_NAME,
    logLevel: env.LOG_LEVEL,
    database: env.DATABASE_URL
      ? {
          url: env.DATABASE_URL,
          poolMax: env.DATABASE_POOL_MAX,
          statementTimeoutMs: env.STATEMENT_TIMEOUT_MS,
        }
      : undefined,
    auth: {
      jwtSecret,
      fromEnvironment,
      accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
      jwtIssuer: env.JWT_ISSUER,
      jwtAudience: env.JWT_AUDIENCE,
      bcryptRounds: env.BCRYPT_ROUNDS,
      loginMaxFailures: env.LOGIN_MAX_FAILURES,
      loginLockoutMinutes: env.LOGIN_LOCKOUT_MINUTES,
    },
    rateLimit: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      loginMax: env.RATE_LIMIT_LOGIN_MAX,
    },
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    trustProxy: env.TRUST_PROXY,
    bodyLimitKb: env.BODY_LIMIT_KB,
  };
}
