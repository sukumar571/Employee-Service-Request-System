/**
 * Shared configuration for the database command line tools.
 *
 * Environment resolution mirrors the backend (`main.ts`): the most specific file wins and
 * nothing is ever committed — see `.env.example` for the documented keys.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.resolve(packageDir, '..');
export const migrationsDir = path.join(packageDir, 'migrations');
export const seedsDir = path.join(packageDir, 'seeds');
export const migrationsTable = 'pgmigrations';

const here = (...parts) => path.join(packageDir, ...parts);
const there = (...parts) => path.join(repoRoot, ...parts);

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  const result = dotenv.config({ path: file });
  if (result.error) {
    throw new Error(`Unable to read ${path.relative(repoRoot, file)}: ${result.error.message}`);
  }
}

/** Loads env files from the repository root and this package, most specific last. */
export function loadEnv() {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  for (const file of [
    there('.env'),
    there('.env.local'),
    there(`.env.${nodeEnv}`),
    there(`.env.${nodeEnv}.local`),
    here('.env'),
    here('.env.local'),
  ]) {
    loadEnvFile(file);
  }
}

/**
 * `DATABASE_URL`, or one composed from the discrete `PG*`/`POSTGRES_*` variables that
 * `docker-compose.yml` exposes. Returns `null` when the database is not configured at all,
 * which callers turn into a helpful message instead of a stack trace.
 */
export function resolveDatabaseUrl() {
  const direct = process.env.DATABASE_URL;
  if (direct) return direct;

  const user = process.env.PGUSER ?? process.env.POSTGRES_USER;
  const database = process.env.PGDATABASE ?? process.env.POSTGRES_DB;
  if (!user || !database) return null;

  const password = process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD ?? '';
  const host = process.env.PGHOST ?? process.env.POSTGRES_HOST ?? 'localhost';
  const port = process.env.PGPORT ?? process.env.POSTGRES_PORT ?? '5432';
  const credentials = password
    ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
    : encodeURIComponent(user);
  return `postgres://${credentials}@${host}:${port}/${database}`;
}

/** Never print the password half of a URL in logs or error messages. */
export function redact(url) {
  return url.replace(/(:)[^:@/]+(@)/, '$1****$2');
}
