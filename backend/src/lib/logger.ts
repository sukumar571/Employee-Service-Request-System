import { pino } from 'pino';
import type { Logger as PinoLogger } from 'pino';
import type { AppConfig } from '../config/env.js';

/**
 * Structured JSON logging with request correlation (docs/system-architecture.md §9).
 * Secrets and credentials are redacted by path — never log raw values (docs/security-plan.md §5).
 */
export type Logger = PinoLogger;

const REDACTED_PATHS = [
  'password',
  'new_password',
  'current_password',
  'initial_password',
  'token',
  'access_token',
  'refresh_token',
  'JWT_ACCESS_SECRET',
  'req.headers.authorization',
  'req.headers.cookie',
];

export function createLogger(config: AppConfig, overrides: pino.LoggerOptions = {}): Logger {
  const development = config.environment === 'development';

  return pino({
    level: config.logLevel,
    base: { service: config.serviceName, env: config.environment },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    // Human-readable logs locally, JSON everywhere else (Docker log driver expects JSON).
    ...(development && !process.env.VITEST
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, destination: '1', translateTime: 'HH:MM:ss.lcp' },
          },
        }
      : {}),
    ...overrides,
  });
}

/** Logger that produces no output — used by tests. */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
