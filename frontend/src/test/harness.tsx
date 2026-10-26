import {
  DEFAULT_BUSINESS_HOURS,
  DEFAULT_SLA_POLICIES,
  SLA_WARNING_RATIO,
  CONTRACT_VERSION,
  REQUEST_STATUSES,
  REQUEST_PRIORITIES,
  REQUEST_ACTIONS,
  USER_ROLES,
  SLA_STATES,
  COMMENT_VISIBILITIES,
  REQUEST_EVENT_TYPES,
  NOTIFICATION_TYPES,
  lifecycleRules,
  type ApiCatalog,
  type RequestPriority,
} from '@esrs/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

/**
 * Test harness for component/integration tests. No test talks to a real server: `stubFetch`
 * replaces the global with a route table, exactly as docs/test-plan.md §7 requires.
 */
export interface FakeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export function jsonResponse(
  status: number,
  body: unknown,
  requestId = 'test-request-id',
): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'x-request-id' ? requestId : null) },
    json: async () => body,
  };
}

type RouteTable = Readonly<Record<string, FakeResponse | (() => FakeResponse)>>;

/** Installs a `fetch` stub keyed by exact URL; unmatched URLs fail the test loudly. */
export function stubFetch(routes: RouteTable): { calls: string[] } {
  const calls: string[] = [];
  const stub = async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const handler = routes[url];
    if (!handler) throw new Error(`No fetch stub for ${url}`);
    return typeof handler === 'function' ? handler() : handler;
  };
  vi.stubGlobal('fetch', vi.fn(stub));
  return { calls };
}

/** A catalogue identical in shape to `GET /meta`, built from the shared contract. */
export function catalogFixture(overrides?: Partial<ApiCatalog>): ApiCatalog {
  return {
    contract_version: CONTRACT_VERSION,
    api: { service: 'esrs-api', api_version: '0.1.0', documentation: '/api/v1/meta' },
    catalog: {
      roles: [...USER_ROLES],
      statuses: [...REQUEST_STATUSES],
      priorities: [...REQUEST_PRIORITIES],
      actions: [...REQUEST_ACTIONS],
      sla_states: [...SLA_STATES],
      comment_visibilities: [...COMMENT_VISIBILITIES],
      event_types: [...REQUEST_EVENT_TYPES],
      notification_types: [...NOTIFICATION_TYPES],
    },
    transitions: lifecycleRules(),
    sla: {
      business_hours: DEFAULT_BUSINESS_HOURS,
      warning_ratio: SLA_WARNING_RATIO,
      default_policies: DEFAULT_SLA_POLICIES,
    },
    ...overrides,
  };
}

export function slaPolicyFixture(priority: RequestPriority = 'critical') {
  const targets = DEFAULT_SLA_POLICIES[priority];
  return {
    priority,
    first_response_minutes: targets.first_response_minutes,
    resolution_minutes: targets.resolution_minutes,
    business_hours: DEFAULT_BUSINESS_HOURS,
  };
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
}

export function renderWithProviders(ui: ReactElement): {
  result: RenderResult;
  client: QueryClient;
} {
  const client = createTestQueryClient();
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
  return { result, client };
}
