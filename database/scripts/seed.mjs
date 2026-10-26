/**
 * Applies `seeds/*.sql` in filename order.
 *
 * Seeds are written to be idempotent (`ON CONFLICT DO NOTHING` + sequence resync), so `npm run
 * db:seed` can be executed repeatedly. Demo credentials are never stored in the repository: the
 * `{{DEMO_PASSWORD_HASH}}` token is replaced with a bcrypt hash of `SEED_DEMO_PASSWORD`, taken from
 * the environment (see `database/.env.example`). If a seed references the token and the variable is
 * missing, seeding stops — there is no default password baked into the source.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { seedsDir } from './config.mjs';

const PASSWORD_TOKEN = '{{DEMO_PASSWORD_HASH}}';

export async function listSeedFiles() {
  const entries = await readdir(seedsDir);
  return entries.filter((name) => name.endsWith('.sql')).toSorted();
}

/** @returns the list of seed files that were executed. */
export async function applySeeds(databaseUrl) {
  const files = await listSeedFiles();
  const statements = [];
  for (const name of files) {
    statements.push({ name, sql: await readFile(path.join(seedsDir, name), 'utf8') });
  }

  let hash;
  if (statements.some((seed) => seed.sql.includes(PASSWORD_TOKEN))) {
    const password = process.env.SEED_DEMO_PASSWORD?.trim();
    if (!password) {
      throw new Error(
        'A seed contains {{DEMO_PASSWORD_HASH}} but SEED_DEMO_PASSWORD is not set. ' +
          'Set it in database/.env (a development-only value you choose) and re-run `npm run db:seed`.',
      );
    }
    // Cost 12 matches the application's policy (docs/security-plan.md §3).
    hash = await bcrypt.hash(password, 12);
  }

  const client = new pg.Client({ connectionString: databaseUrl });

  await client.connect();
  const applied = [];
  try {
    for (const seed of statements) {
      const sql = hash ? seed.sql.replaceAll(PASSWORD_TOKEN, hash) : seed.sql;
      await client.query(sql);
      applied.push(seed.name);
    }
  } finally {
    await client.end();
  }
  return applied;
}
