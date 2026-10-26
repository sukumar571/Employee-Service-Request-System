import { readFile, readdir } from 'node:fs/promises';
import {
  COMMENT_VISIBILITIES,
  DEFAULT_BUSINESS_HOURS,
  DEFAULT_SLA_POLICIES,
  NOTIFICATION_TYPES,
  REQUEST_EVENT_TYPES,
  REQUEST_PRIORITIES,
  REQUEST_STATUSES,
  USER_ROLES,
  businessHoursSchema,
} from '@esrs/shared';
import { describe, expect, it } from 'vitest';

/**
 * Contract test C-02 (docs/test-plan.md §4): the PostgreSQL enumerations and the seeded SLA
 * targets must be identical to the contract in `@esrs/shared`. Drift here is the classic
 * "the API says one thing, the database says another" failure, so it is checked as a unit test
 * that needs no running database.
 */
const migrationsDir = new URL('../migrations/', import.meta.url);

const readMigration = async (name: string): Promise<string> =>
  readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

// Top-level await is resolved by the ESM loader before any test in this file executes.
const enumsSql = await readMigration('002_enums.sql');
const slaSql = await readMigration('010_sla_policies_trackers.sql');
const alignmentSql = await readMigration('015_schema_alignment_columns.sql');
const referenceSeedSql = await readFile(new URL('../seeds/001_reference_data.sql', import.meta.url), 'utf8');
const migrationNames = (await readdir(migrationsDir))
  .filter((name) => name.endsWith('.sql'))
  .toSorted();

/** `CREATE TYPE x AS ENUM ('a', 'b');` → `['a', 'b']`, order preserved. */
function enumLabels(sql: string, typeName: string): string[] {
  const body = new RegExp(`CREATE TYPE ${typeName} AS ENUM\\s*\\(([^)]*)\\)`, 'i').exec(sql)?.[1];
  if (!body) return [];
  return body
    .split(',')
    .map((label) => label.trim().replaceAll(/^'|'$/g, ''))
    .filter((label) => label.length > 0);
}

describe('enumerations (002_enums.sql) match @esrs/shared', () => {
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ['user_role', USER_ROLES],
    ['request_status', REQUEST_STATUSES],
    ['request_priority', REQUEST_PRIORITIES],
    ['comment_visibility', COMMENT_VISIBILITIES],
    ['request_event_type', REQUEST_EVENT_TYPES],
    ['notification_type', NOTIFICATION_TYPES],
  ];

  for (const [typeName, contract] of cases) {
    it(`${typeName} has exactly the contract labels, in order`, () => {
      expect(enumLabels(enumsSql, typeName)).toStrictEqual([...contract]);
    });
  }
});

describe('SLA defaults (010_sla_policies_trackers.sql) match @esrs/shared', () => {
  const rows = [...slaSql.matchAll(/\('(low|medium|high|critical)',\s*(\d+),\s*(\d+)\)/g)];

  it('seeds exactly one policy per priority', () => {
    expect(new Set(rows.map((row) => row[1]))).toEqual(new Set<string>(REQUEST_PRIORITIES));
    expect(rows).toHaveLength(REQUEST_PRIORITIES.length);
  });

  for (const priority of REQUEST_PRIORITIES) {
    it(`${priority} targets equal the contract`, () => {
      const row = rows.find((candidate) => candidate[1] === priority);
      const targets = DEFAULT_SLA_POLICIES[priority];
      expect(Number(row?.[2])).toBe(targets.first_response_minutes);
      expect(Number(row?.[3])).toBe(targets.resolution_minutes);
    });
  }

  it('uses the `timezone` key the contract requires', () => {
    const literal = /\{"days":[^}]*\}/.exec(slaSql)?.[0];
    if (!literal) throw new Error('010 must define a default business_hours JSONB literal');
    expect(businessHoursSchema.parse(JSON.parse(literal))).toStrictEqual(DEFAULT_BUSINESS_HOURS);
  });

  it('names the columns the Postgres repository reads', () => {
    expect(slaSql).toContain('first_response_mins');
    expect(slaSql).toContain('resolution_mins');
  });
});

describe('schema alignment (015_schema_alignment_columns.sql) match the spec + backend', () => {
  it('gives categories a description and a default SLA configuration', () => {
    expect(alignmentSql).toMatch(/ADD COLUMN description TEXT/);
    expect(alignmentSql).toMatch(/ADD COLUMN default_resolution_hours INT CHECK \(default_resolution_hours > 0\)/);
    expect(referenceSeedSql).toContain('default_resolution_hours');
  });

  it('makes audit_logs.request_id a service-request FK and frees the name via http_request_id', () => {
    // PostgresAuditSink (backend/src/db/audit.pg.ts) writes exactly these two columns.
    expect(alignmentSql).toMatch(/RENAME COLUMN request_id TO http_request_id/);
    expect(alignmentSql).toMatch(/request_id BIGINT REFERENCES requests \(id\) ON DELETE SET NULL/);
  });

  it('keeps updated_at honest with a shared trigger', () => {
    expect(alignmentSql).toContain('CREATE FUNCTION set_updated_at()');
    for (const table of ['users', 'categories', 'requests', 'comments', 'sla_policies', 'sla_trackers']) {
      expect(alignmentSql, `missing updated_at trigger on ${table}`).toContain(`ON ${table} `);
    }
  });

  it('defines the audit FK after the requests table exists (14 < 15)', () => {
    const indexOf = (prefix: string) => migrationNames.findIndex((name) => name.startsWith(prefix));
    expect(indexOf('007')).toBeLessThan(indexOf('015'));
    expect(indexOf('014')).toBeLessThan(indexOf('015'));
  });
});

describe('migration file conventions', () => {
  it('use a three digit prefix and a snake_case name', () => {
    for (const name of migrationNames) {
      expect(name).toMatch(/^\d{3}_[a-z0-9_]+\.sql$/);
    }
  });

  it('sort into a strictly increasing sequence', () => {
    const prefixes = migrationNames.map((name) => Number(name.slice(0, 3)));
    expect(prefixes).toStrictEqual([...prefixes].sort((a, b) => a - b));
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('are all reversible', async () => {
    for (const name of migrationNames) {
      const sql = await readMigration(name);
      expect(sql, `${name} needs an up section`).toMatch(/^\s*--\s*Up Migration\b/im);
      expect(sql, `${name} needs a down section`).toMatch(/^\s*--\s*Down Migration\b/im);
    }
  });
});
