#!/usr/bin/env node
/**
 * ESRS database command line entry point.
 *
 *   node scripts/run.mjs up      # apply pending migrations
 *   node scripts/run.mjs down    # revert the last applied migration (use `down all` for every one)
 *   node scripts/run.mjs status  # applied vs pending, file by file
 *   node scripts/run.mjs seed    # idempotent reference + demo data
 *   node scripts/run.mjs verify  # constraint checks against a clean scratch database
 *   node scripts/run.mjs reset   # down all, up, seed  (destructive: development only)
 *
 * Migrations are plain `.sql` files with `-- Up Migration` / `-- Down Migration` markers, the
 * format node-pg-migrate reads natively (docs/database-design.md §3).
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadEnv, migrationsTable, packageDir, redact, resolveDatabaseUrl } from './config.mjs';
import { applySeeds } from './seed.mjs';
import { showStatus } from './status.mjs';

loadEnv();

function cliPath() {
  const specifier = 'node-pg-migrate/bin/node-pg-migrate';
  try {
    return fileURLToPath(import.meta.resolve(specifier));
  } catch {
    return createRequire(import.meta.url).resolve(specifier);
  }
}

const databaseUrl = resolveDatabaseUrl();

if (!databaseUrl) {
  process.stderr.write(
    [
      'No database configured.',
      '',
      'Set DATABASE_URL (or the POSTGRES_* variables) in .env / .env.local,',
      'or start the bundled PostgreSQL container first:',
      '',
      '  npm run db:up      # docker compose up -d postgres',
      '  npm run db:migrate',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

/** Runs node-pg-migrate with this package as the working directory. */
function migrate(args) {
  const result = spawnSync(process.execPath, [cliPath(), ...args, '-t', migrationsTable], {
    cwd: packageDir,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
  return result.status === 0;
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

const command = process.argv[2] ?? 'up';
const extraArgs = process.argv.slice(3);

log(`Database: ${redact(databaseUrl)}  (${command})`);

switch (command) {
  case 'up':
    migrate(['up', ...extraArgs]);
    break;

  case 'down':
    // node-pg-migrate needs a count; `down` with no argument means "undo everything" here.
    migrate(['down', ...(extraArgs.length > 0 ? extraArgs : ['all'])]);
    break;

  case 'make':
    if (extraArgs.length === 0) {
      process.stderr.write('Usage: node scripts/run.mjs make <migration_name>\n');
      process.exitCode = 1;
      break;
    }
    migrate(['create', ...extraArgs, '--migration-file-language', 'sql']);
    break;

  case 'status':
    await showStatus(databaseUrl);
    break;

  case 'seed': {
    const applied = await applySeeds(databaseUrl);
    log(`Seeds applied: ${applied.join(', ')}`);
    break;
  }

  case 'verify': {
    // verify.mjs owns the process (pass/fail table + exit code) once imported.
    await import('./verify.mjs');
    break;
  }

  case 'reset': {
    process.stderr.write('reset drops and recreates the schema — development data only.\n');
    if (!migrate(['down', 'all'])) break;
    if (!migrate(['up'])) break;
    const applied = await applySeeds(databaseUrl);
    log(`Seeds applied: ${applied.join(', ')}`);
    break;
  }

  default:
    process.stderr.write(
      `Unknown command '${command}'. Use: up | down | status | seed | verify | reset | make\n`,
    );
    process.exitCode = 1;
}
