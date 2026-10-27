import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { jsonResponse, renderWithProviders, stubFetch } from '../test/harness';
import { RequestActivityPage } from './RequestActivityPage';

/**
 * The activity workspace is the only screen that puts the two history surfaces side by side, so the
 * test that matters is that they are wired to *different* endpoints and both appear for the routed
 * request id. `renderWithProviders` cannot express a route, hence the local router here.
 */
function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/requests/:id/activity" element={<RequestActivityPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RequestActivityPage', () => {
  it('loads the timeline and the comment thread for the routed request', async () => {
    const { calls } = stubFetch({
      '/api/v1/requests/42/timeline?limit=100': jsonResponse(200, {
        data: [
          {
            id: 'e1',
            event_type: 'created',
            actor: { id: '21', full_name: 'Priya Raman' },
            actor_role: 'employee',
            from_status: null,
            to_status: 'submitted',
            detail: {},
            created_at: '2026-10-20T09:00:00.000Z',
            kind: 'event',
          },
        ],
        meta: { page: 1, page_size: 100, total: 1 },
      }),
      '/api/v1/requests/42/comments?page=1': jsonResponse(200, {
        data: [
          {
            id: '1',
            request_id: '42',
            author: { id: '22', full_name: 'Arjun Patel' },
            body: 'Vendor call booked for Tuesday.',
            visibility: 'public',
            is_post_closure: false,
            created_at: '2026-10-20T09:40:00.000Z',
            updated_at: '2026-10-20T09:40:00.000Z',
          },
        ],
        meta: { page: 1, page_size: 20, total: 1 },
      }),
    });

    renderAt('/requests/42/activity');

    expect(await screen.findByText('Vendor call booked for Tuesday.')).toBeInTheDocument();
    expect(screen.getByText('Activity timeline')).toBeInTheDocument();
    expect(calls).toContain('/api/v1/requests/42/timeline?limit=100');
    expect(calls).toContain('/api/v1/requests/42/comments?page=1');
  });

  it('names the request the route points at', async () => {
    stubFetch({
      '/api/v1/requests/7/timeline?limit=100': jsonResponse(200, {
        data: [],
        meta: { page: 1, page_size: 100, total: 0 },
      }),
      '/api/v1/requests/7/comments?page=1': jsonResponse(200, {
        data: [],
        meta: { page: 1, page_size: 20, total: 0 },
      }),
    });

    renderAt('/requests/7/activity');

    expect(await screen.findByText('Request activity')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('asks for a request id when the route carries none', async () => {
    renderWithProviders(<RequestActivityPage />);

    expect(await screen.findByText(/No request selected/i)).toBeInTheDocument();
    expect(screen.getByText(/Open a request with a path/i)).toBeInTheDocument();
  });

  it('states plainly that the audit trail is not on this screen', async () => {
    stubFetch({
      '/api/v1/requests/9/timeline?limit=100': jsonResponse(200, {
        data: [],
        meta: { page: 1, page_size: 100, total: 0 },
      }),
      '/api/v1/requests/9/comments?page=1': jsonResponse(200, {
        data: [],
        meta: { page: 1, page_size: 20, total: 0 },
      }),
    });

    renderAt('/requests/9/activity');

    expect(await screen.findByText(/What this list is not/i)).toBeInTheDocument();
    expect(screen.getByText(/separate append-only table/i)).toBeInTheDocument();
  });
});
