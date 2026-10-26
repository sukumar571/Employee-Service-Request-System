import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig } from './env.js';

const DEV = { NODE_ENV: 'development' };

function failure(source: NodeJS.ProcessEnv): string {
  try {
    loadConfig(source);
  } catch (error) {
    if (error instanceof ConfigurationError) return error.message;
    throw error;
  }
  throw new Error('expected loadConfig to reject');
}

describe('loadConfig — defaults (docs/system-architecture.md §8)', () => {
  it('applies documented defaults for a bare development environment', () => {
    const config = loadConfig(DEV);
    expect(config).toMatchObject({
      environment: 'development',
      isProduction: false,
      port: 4000,
      serviceName: 'esrs-api',
      logLevel: 'info',
      trustProxy: 0,
      bodyLimitKb: 64,
      corsOrigins: ['http://localhost:5173'],
    });
    expect(config.database).toBeUndefined();
  });

  it('ignores empty strings so a copied .env.example behaves like an unset value', () => {
    const config = loadConfig({ ...DEV, DATABASE_URL: '', LOG_LEVEL: '' });
    expect(config.database).toBeUndefined();
    expect(config.logLevel).toBe('info');
  });

  it('parses DATABASE_URL into a database config with pool limits', () => {
    const config = loadConfig({
      ...DEV,
      DATABASE_URL: 'postgres://esrs:pw@localhost:5432/esrs',
      DATABASE_POOL_MAX: '4',
      STATEMENT_TIMEOUT_MS: '2500',
    });
    expect(config.database).toEqual({
      url: 'postgres://esrs:pw@localhost:5432/esrs',
      poolMax: 4,
      statementTimeoutMs: 2500,
    });
  });
});

describe('loadConfig — secrets never have committed fallbacks (docs/security-plan.md §7)', () => {
  it('generates an ephemeral dev secret and says so', () => {
    const config = loadConfig(DEV);
    expect(config.auth.fromEnvironment).toBe(false);
    expect(config.auth.jwtSecret).toMatch(/^esrs-dev-ephemeral-/);
    // Two boots must not share a secret, otherwise tokens would survive a restart by accident.
    expect(loadConfig(DEV).auth.jwtSecret).not.toBe(config.auth.jwtSecret);
  });

  it('accepts an environment secret of at least 32 characters', () => {
    const secret = 'a'.repeat(48);
    const config = loadConfig({ ...DEV, JWT_ACCESS_SECRET: secret });
    expect(config.auth).toMatchObject({ jwtSecret: secret, fromEnvironment: true });
  });

  it('refuses to boot in production without a secret, naming the variable only', () => {
    const message = failure({ NODE_ENV: 'production', CORS_ORIGINS: 'https://hr.example.com' });
    expect(message).toContain('JWT_ACCESS_SECRET');
    expect(message).not.toContain('a'.repeat(32));
  });

  it('refuses the localhost CORS default in production', () => {
    const message = failure({
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: 'x'.repeat(40),
    });
    expect(message).toContain('CORS_ORIGINS');
  });
});

describe('loadConfig — fail fast with variable names', () => {
  it('rejects a non-numeric port', () => {
    expect(failure({ ...DEV, PORT: 'http' })).toContain('PORT');
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(failure({ NODE_ENV: 'staging' })).toContain('NODE_ENV');
  });

  it('rejects an out-of-range trust proxy hop count', () => {
    expect(failure({ ...DEV, TRUST_PROXY: '9' })).toContain('TRUST_PROXY');
  });

  it('never echoes secret values in the error message', () => {
    const message = failure({ ...DEV, BODY_LIMIT_KB: '999999' });
    expect(message).toContain('BODY_LIMIT_KB');
    expect(message).not.toContain('999999');
  });
});
