import { describe, expect, it } from 'vitest';
import {
  AUDIT_VALUE_MAX,
  auditEntryForStorage,
  resolveAuditWrite,
  withRedaction,
  type AuditEntry,
} from './audit.js';

/**
 * The audit payload policy (docs/security-plan.md §7): the trail must hold evidence about a change
 * without becoming a second store of the secrets and free text that caused it. These are the
 * guarantees the request and comment writes rely on, tested at the port itself rather than through
 * HTTP, because a redaction rule is only worth anything if it holds for a payload no route would
 * ever send.
 */

const base: AuditEntry = {
  actorId: '42',
  actorRole: 'admin',
  action: 'user.updated',
  entityType: 'user',
  entityId: '7',
};

describe('withRedaction', () => {
  it('replaces a secret-valued key at any depth and leaves the rest of the image intact', () => {
    const entry = withRedaction({
      ...base,
      before: {
        full_name: 'Priya Sharma',
        password: 'hunter2',
        integrations: { api_key: 'ak_live_123', refresh_token: 'rt.abc', label: 'ops' },
        service: { access_key: 'AKIAEXAMPLE', secretArn: 'arn:aws:secretsmanager:x' },
        // A key whose whole name means "secrets" collapses entirely: no part of its value is stored.
        credentials: { primary: 'p-1', backup: 'p-2' },
        friends: [{ email: 'a@corp.example', new_password: 'again', newPassword: 'again-camel' }],
      },
      after: { full_name: 'Priya S.', password_hash: '$2a$12$abcdef', role: 'manager' },
    });

    expect(entry.before).toMatchObject({
      full_name: 'Priya Sharma',
      password: '[redacted]',
      integrations: { api_key: '[redacted]', refresh_token: '[redacted]', label: 'ops' },
      service: { access_key: '[redacted]', secretArn: '[redacted]' },
      credentials: '[redacted]',
      friends: [{ email: 'a@corp.example', new_password: '[redacted]', newPassword: '[redacted]' }],
    });
    // `api_key` and `access_key` split into two harmless tokens each, so the de-segmented whole name is
    // what catches them.
    expect(entry.after).toMatchObject({ role: 'manager', password_hash: '[redacted]' });
    expect(JSON.stringify(entry)).not.toContain('hunter2');
    expect(JSON.stringify(entry)).not.toContain('ak_live_123');
    expect(JSON.stringify(entry)).not.toContain('AKIAEXAMPLE');
    expect(JSON.stringify(entry)).not.toContain('secretsmanager');
    expect(JSON.stringify(entry)).not.toContain('p-1');
    expect(JSON.stringify(entry)).not.toContain('$2a$12$abcdef');
  });

  it('matches whole key words, so an ordinary field that merely contains one survives', () => {
    const entry = withRedaction({
      ...base,
      after: {
        author: 'carl',
        bypass: 'none',
        tokens: undefined,
        task: 'swap the SSD',
        is_post_closure: true,
        assignee_open_tickets_before: 0,
      },
    });
    expect(entry.after).toEqual({
      author: 'carl',
      bypass: 'none',
      task: 'swap the SSD',
      is_post_closure: true,
      assignee_open_tickets_before: 0,
    });
  });

  it('clips a value longer than the stored maximum instead of storing it whole', () => {
    const long = 'x'.repeat(AUDIT_VALUE_MAX + 500);
    const entry = withRedaction({ ...base, after: { resolution_note: long } });
    const stored = String((entry.after as { resolution_note: string }).resolution_note);

    expect(stored).toBe(`${'x'.repeat(AUDIT_VALUE_MAX)}…[truncated]`);
    expect(stored.length).toBeLessThan(long.length);
  });

  it('stops at the depth limit rather than following a cycle for ever', () => {
    const cyclic: Record<string, unknown> = { note: 'a' };
    cyclic.self = cyclic;
    const entry = withRedaction({ ...base, before: cyclic });

    expect(() => JSON.stringify(entry.before)).not.toThrow();
    expect(JSON.stringify(entry.before)).toContain('depth-limit');
  });

  it('serialises values JSON cannot hold instead of throwing on them', () => {
    const entry = withRedaction({
      ...base,
      after: {
        at: new Date('2026-10-26T10:00:00.000Z'),
        big: 9007199254740993n,
        callback: () => 'never stored',
      },
    });

    // `toEqual` treats an `undefined` property as absent, which is exactly the contract here: the key
    // carries no value, so the JSON column cannot hold a function.
    expect(entry.after).toEqual({
      at: '2026-10-26T10:00:00.000Z',
      big: '9007199254740993',
      callback: undefined,
    });
    expect(JSON.stringify(entry.after)).not.toContain('never stored');
  });

  it('is idempotent, so a retry of the same entry cannot change the recorded image', () => {
    const once = withRedaction({ ...base, after: { password: 'hunter2', role: 'admin' } });
    expect(withRedaction(once)).toEqual(once);
  });
});

describe('auditEntryForStorage', () => {
  it('emits only the columns the table has, and omits the ones that were never set', () => {
    const stored = auditEntryForStorage({ ...base, before: { role: 'agent' } });

    expect(Object.keys(stored).sort()).toEqual(
      ['actorId', 'actorRole', 'action', 'before', 'entityId', 'entityType'].sort(),
    );
    // `serviceRequestId` and `requestId` are absent, not undefined: the SQL layer binds NULLs itself.
    expect('after' in stored).toBe(false);
    expect('serviceRequestId' in stored).toBe(false);
  });
});

describe('resolveAuditWrite', () => {
  it('takes the subject id and the instant from the row the adapter just wrote', () => {
    const entry = resolveAuditWrite(() => ({ ...base, entityId: '', at: undefined }), {
      entityId: '11',
      at: '2026-10-26T12:00:00.000Z',
      version: 4,
    });

    expect(entry).toMatchObject({
      entityId: '11',
      serviceRequestId: '11',
      at: '2026-10-26T12:00:00.000Z',
    });
  });

  it('keeps a value the service stated deliberately', () => {
    const entry = resolveAuditWrite(
      () => ({ ...base, entityId: '99', serviceRequestId: '5', at: '2020-01-01T00:00:00.000Z' }),
      { entityId: '11', at: '2026-10-26T12:00:00.000Z' },
    );

    expect(entry).toMatchObject({
      entityId: '99',
      serviceRequestId: '5',
      at: '2020-01-01T00:00:00.000Z',
    });
  });

  it('points a comment audit row at its parent request, not at the comment', () => {
    // The comment is the entity; the request is what the FK column must reference so the trail can be
    // read back per ticket.
    const entry = resolveAuditWrite(
      ({ entityId, serviceRequestId }) => ({
        actorId: '20',
        actorRole: 'agent',
        action: 'comment.added',
        entityType: 'comment',
        entityId,
        serviceRequestId,
      }),
      { entityId: '77', serviceRequestId: '5', at: '2026-10-26T12:00:00.000Z' },
    );

    expect(entry).toMatchObject({ entityId: '77', serviceRequestId: '5' });
  });

  it('leaves a non-request entity pointing at itself, which the SQL layer then binds as NULL', () => {
    const entry = resolveAuditWrite(
      ({ entityId }) => ({
        actorId: '30',
        actorRole: 'manager',
        action: 'sla_policy.updated',
        entityType: 'sla_policy',
        entityId,
      }),
      { entityId: 'high', at: '2026-10-26T12:00:00.000Z' },
    );

    expect(entry.entityId).toBe('high');
    // Not a decimal id, so `auditParams` stores NULL in `audit_logs.request_id` rather than trying to
    // cast 'high' into the BIGINT foreign key.
    expect(/^\d+$/.test(String(entry.serviceRequestId))).toBe(false);
  });
});
