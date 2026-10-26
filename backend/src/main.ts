import { config as loadDotenv } from 'dotenv';
import { createApp } from './app.js';
import { ConfigurationError, loadConfig } from './config/env.js';
import { API_BASE_PATH, API_VERSION } from './config/version.js';
import { createDatabase } from './db/pool.js';
import { createLogger } from './lib/logger.js';

/**
 * Process entry point.
 *
 * Environment-specific configuration is resolved in this order (later entries do not override
 * earlier ones, so a local `.env.local` always wins):
 *   .env.<NODE_ENV>.local → .env.<NODE_ENV> → .env.local → .env
 * Secrets come from the environment only; nothing here has a fallback credential (docs/security-plan.md §7).
 */
function loadEnvironmentFiles(): void {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  for (const file of [`.env.${nodeEnv}.local`, `.env.${nodeEnv}`, '.env.local', '.env']) {
    loadDotenv({ path: file, quiet: true });
  }
}

function main(): void {
  loadEnvironmentFiles();

  // A configuration problem is fatal and must print variable NAMES, never values.
  const config = loadConfig();
  const logger = createLogger(config);
  const database = createDatabase(config.database, {
    onError: (error) => logger.error({ err: error }, 'postgres pool error'),
  });

  const { app } = createApp({ config, logger, database });

  const server = app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        base_path: API_BASE_PATH,
        version: API_VERSION,
        database: config.database ? 'configured' : 'not_configured',
        // Surfacing this avoids "why is my token invalid after a restart?" in local debugging.
        jwt_secret_source: config.auth.fromEnvironment ? 'environment' : 'ephemeral-dev',
      },
      'ESRS API listening',
    );
  });

  server.on('error', (error) => {
    logger.fatal({ err: error }, 'HTTP server failed');
    process.exitCode = 1;
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'shutting down');
    // Stop accepting connections, then release the pool; force-exit if a socket hangs (NFR-9).
    server.close((error) => {
      if (error) logger.error({ err: error }, 'error while closing server');
      void database.close().finally(() => process.exit(error ? 1 : 0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled rejection');
    process.exitCode = 1;
  });
}

try {
  main();
} catch (error) {
  if (error instanceof ConfigurationError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
