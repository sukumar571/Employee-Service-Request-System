/**
 * `npm run db:status` — node-pg-migrate has no status command, so this compares the files in
 * `migrations/` with the rows of the `pgmigrations` table.
 */
import { readdir } from 'node:fs/promises';
import pg from 'pg';
import { migrationsDir, migrationsTable } from './config.mjs';

export async function showStatus(databaseUrl) {
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).toSorted();

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const tableExists = await client.query(`SELECT to_regclass($1) AS name`, [migrationsTable]);
    const applied = new Set();
    if (tableExists.rows[0]?.name) {
      const rows = await client.query(`SELECT name FROM ${migrationsTable} ORDER BY migration ASC`);
      for (const row of rows.rows) applied.add(row.name);
    }

    const pending = [];
    for (const file of files) {
      const status = applied.has(file) ? 'applied' : 'pending';
      if (status === 'pending') pending.push(file);
      console.log(`${status.padEnd(8)} ${file}`);
    }
    console.log(`\n${files.length - pending.length}/${files.length} migrations applied.`);
    return pending;
  } finally {
    await client.end();
  }
}
