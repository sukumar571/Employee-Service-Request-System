import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LifecyclePage } from './LifecyclePage';
import { catalogFixture, jsonResponse, renderWithProviders, stubFetch } from '../test/harness';

/**
 * The lifecycle explorer is the frontend's proof that UI and API share one state machine:
 * the rule set is fetched from `/meta`, and the "allowed" column must match `allowedActionsFor()`
 * from `@esrs/shared` (docs/test-plan.md §5 contract tests).
 */
function renderPage() {
  stubFetch({ '/api/v1/meta': jsonResponse(200, { data: catalogFixture() }) });
  return renderWithProviders(<LifecyclePage />);
}

describe('LifecyclePage', () => {
  it('lists the outgoing transitions of the selected status', async () => {
    renderPage();

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    // header + claim/assign/cancel for `submitted`
    expect(rows).toHaveLength(4);
  });

  it('allows an agent to claim a submitted request but not assign it', async () => {
    renderPage();

    await screen.findByRole('table');
    expect(screen.getAllByText('Allowed')).toHaveLength(1);
    expect(screen.getAllByText('Blocked')).toHaveLength(2);
    expect(screen.getAllByText('claim').length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText('Acting role'), { target: { value: 'manager' } });
    expect(await screen.findAllByText('Allowed')).toHaveLength(2);
  });

  it('only lets the requester act on a resolved request', async () => {
    renderPage();

    fireEvent.change(screen.getByLabelText('Current status'), { target: { value: 'resolved' } });
    expect(await screen.findAllByText('Blocked')).toHaveLength(2);

    fireEvent.click(screen.getByLabelText('Is the requester'));
    expect(await screen.findAllByText('Allowed')).toHaveLength(2);
  });

  it('explains terminal states instead of rendering an empty grid', async () => {
    renderPage();

    fireEvent.change(screen.getByLabelText('Current status'), { target: { value: 'cancelled' } });
    expect(await screen.findByText(/terminal state/i)).toBeInTheDocument();
  });

  it('reports which source the rules came from', async () => {
    renderPage();
    expect(await screen.findByText('GET /meta')).toBeInTheDocument();
  });

  it('falls back to the bundled contract when /meta is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    renderWithProviders(<LifecyclePage />);

    expect(await screen.findByText('@esrs/shared')).toBeInTheDocument();
  });
});
