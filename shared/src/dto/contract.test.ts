import { describe, expect, it } from 'vitest';
import {
  apiErrorBodySchema,
  catalogOptionsSchema,
  CONTRACT_VERSION,
  DEFAULT_BUSINESS_HOURS,
  DEFAULT_SLA_POLICIES,
  isTerminalStatus,
  listResponseSchema,
  paginationQuerySchema,
  resourceSchema,
  SLA_WARNING_RATIO,
  slaPolicyDtoSchema,
  systemStatusSchema,
  updateSlaPolicyBodySchema,
} from '../index.js';

const aPolicy = {
  priority: 'high' as const,
  first_response_minutes: 120,
  resolution_minutes: 1440,
  business_hours: DEFAULT_BUSINESS_HOURS,
};

describe('response envelope conventions', () => {
  it('parses the canonical error body', () => {
    const body = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request payload',
        details: [{ path: 'title', message: 'min 5 characters' }],
        request_id: '7c1f',
      },
    };
    expect(apiErrorBodySchema.safeParse(body).success).toBe(true);
  });

  it('rejects unknown error codes (append-only contract, api-spec §14)', () => {
    const body = { error: { code: 'SOMETHING_NEW', message: 'x' } };
    expect(apiErrorBodySchema.safeParse(body).success).toBe(false);
  });

  it('builds list and single-resource envelopes', () => {
    const list = { data: [aPolicy], meta: { page: 1, page_size: 20, total: 1 } };
    expect(listResponseSchema(slaPolicyDtoSchema).safeParse(list).success).toBe(true);
    expect(resourceSchema(slaPolicyDtoSchema).safeParse({ data: aPolicy }).success).toBe(true);
  });

  it('applies pagination defaults and clamps oversized page_size', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ page: 1, page_size: 20 });
    expect(paginationQuerySchema.parse({ page: '3', page_size: '500' })).toEqual({
      page: 3,
      page_size: 100,
    });
    expect(paginationQuerySchema.safeParse({ page: '0' }).success).toBe(false);
  });
});

describe('SLA contract', () => {
  it('validates a policy DTO and rejects a bad priority', () => {
    expect(slaPolicyDtoSchema.safeParse(aPolicy).success).toBe(true);
    expect(slaPolicyDtoSchema.safeParse({ ...aPolicy, priority: 'urgent' }).success).toBe(false);
  });

  it('manager policy edits require a reason and forbid unknown fields', () => {
    const valid = { first_response_minutes: 60, resolution_minutes: 900, reason: 'Too generous' };
    expect(updateSlaPolicyBodySchema.safeParse(valid).success).toBe(true);
    expect(updateSlaPolicyBodySchema.safeParse({ ...valid, priority: 'low' }).success).toBe(false);
    expect(updateSlaPolicyBodySchema.safeParse({ ...valid, reason: 'no' }).success).toBe(false);
  });

  it('default targets are ordered: stricter priority ⇒ shorter clock', () => {
    const order = ['critical', 'high', 'medium', 'low'] as const;
    const resolution = order.map((p) => DEFAULT_SLA_POLICIES[p].resolution_minutes);
    const response = order.map((p) => DEFAULT_SLA_POLICIES[p].first_response_minutes);
    expect(resolution).toEqual([...resolution].sort((a, b) => a - b));
    expect(response).toEqual([...response].sort((a, b) => a - b));
    expect(SLA_WARNING_RATIO).toBe(0.75);
  });

  it('default business hours are a valid weekday window', () => {
    expect(DEFAULT_BUSINESS_HOURS.days).toEqual([1, 2, 3, 4, 5]);
    expect(DEFAULT_BUSINESS_HOURS.start).toBe('09:00');
  });
});

describe('meta contract', () => {
  it('system status accepts a degraded database reading', () => {
    const status = {
      status: 'degraded' as const,
      service: 'esrs-api',
      version: '0.1.0',
      environment: 'development',
      uptime_seconds: 12,
      timestamp: new Date().toISOString(),
      database: { state: 'down' as const },
    };
    expect(systemStatusSchema.safeParse(status).success).toBe(true);
  });

  it('catalog options expose every enum the UI needs', () => {
    const parsed = catalogOptionsSchema.safeParse({
      roles: ['employee', 'agent', 'manager', 'admin'],
      statuses: ['draft', 'submitted', 'assigned', 'in_progress', 'on_hold', 'resolved'],
      priorities: ['low', 'medium', 'high', 'critical'],
      actions: ['submit', 'claim', 'start', 'resolve'],
      sla_states: ['safe', 'warning', 'breached'],
      comment_visibilities: ['public', 'internal'],
      event_types: ['created'],
      notification_types: ['sla_breach'],
    });
    expect(parsed.success).toBe(true);
  });

  it('terminal statuses are excluded from open queues', () => {
    expect(isTerminalStatus('closed')).toBe(true);
    expect(isTerminalStatus('on_hold')).toBe(false);
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
