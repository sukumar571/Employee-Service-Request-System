import type { CommentDto, RequestTimelineEntry } from '@esrs/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderWithProviders, stubFetch } from '../test/harness';
import { CommentThread, TimelineFeed } from './Activity';

/**
 * Comments and the activity timeline, with the two properties that matter most here:
 *
 *  1. user-generated content is *displayed*, never interpreted — the XSS test asserts that no DOM
 *     node is created from a comment body, which is the only proof that "safely rendered" holds;
 *  2. the shared Zod schema guards the write path in the browser too, so an empty or oversized
 *     comment is refused before a request leaves the page (the API repeats both checks regardless).
 */

const LIST_URL = '/api/v1/requests/7/comments?page=1';
const POST_URL = '/api/v1/requests/7/comments';
const TIMELINE_URL = '/api/v1/requests/7/timeline?limit=100';

function commentFixture(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: '1',
    request_id: '7',
    author: { id: '21', full_name: 'Priya Raman' },
    body: 'Reimaged from the golden build.',
    visibility: 'public',
    is_post_closure: false,
    created_at: '2026-10-20T09:15:00.000Z',
    updated_at: '2026-10-20T09:15:00.000Z',
    ...overrides,
  };
}

function entryFixture(overrides: Partial<RequestTimelineEntry> = {}): RequestTimelineEntry {
  return {
    id: 'e1',
    event_type: 'created',
    actor: { id: '21', full_name: 'Priya Raman' },
    actor_role: 'employee',
    from_status: null,
    to_status: 'submitted',
    detail: {},
    created_at: '2026-10-20T09:00:00.000Z',
    kind: 'event',
    ...overrides,
  };
}

function listBody(items: CommentDto[]) {
  return { data: items, meta: { page: 1, page_size: 20, total: items.length } };
}

function renderThread(items: CommentDto[], allowInternal = false) {
  const calls = stubFetch({ [LIST_URL]: jsonResponse(200, listBody(items)) });
  const { result } = renderWithProviders(
    <CommentThread requestId="7" allowInternal={allowInternal} />,
  );
  return { calls, container: result.container };
}

function renderTimeline(entries: RequestTimelineEntry[]) {
  const calls = stubFetch({
    [TIMELINE_URL]: jsonResponse(200, {
      data: entries,
      meta: { page: 1, page_size: 100, total: entries.length },
    }),
  });
  const { result } = renderWithProviders(<TimelineFeed requestId="7" />);
  return { calls, container: result.container };
}

/** Text of every row in the rendered feed/thread, in DOM order. */
function itemTexts(): string[] {
  return within(screen.getByRole('list'))
    .getAllByRole('listitem')
    .map((item) => item.textContent ?? '');
}

describe('CommentThread', () => {
  it('shows the thread oldest-first with the author and the stored instant', async () => {
    renderThread([
      commentFixture(),
      commentFixture({
        id: '2',
        body: 'Driver pack applied, asking the user to test.',
        author: { id: '22', full_name: 'Arjun Patel' },
        created_at: '2026-10-20T10:00:00.000Z',
      }),
    ]);

    await screen.findByText('Reimaged from the golden build.');
    const items = itemTexts();

    expect(items).toHaveLength(2);
    expect(items[0]).toContain('Priya Raman');
    expect(items[1]).toContain('Arjun Patel');
    // Author and timestamp come from the payload; the UI never invents or rewrites either.
    expect(items[0]).toContain('20 Oct 2026');
    expect(items[1]).toContain('15:30');
    expect(screen.getByText('(2)')).toBeInTheDocument();
  });

  it('renders a hostile comment body as text and creates no element from it', async () => {
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const { container } = renderThread([commentFixture({ body: payload })]);

    await screen.findByText(payload);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.queryByLabelText('onerror')).toBeNull();
  });

  it('labels an internal note and a post-closure comment', async () => {
    renderThread([
      commentFixture({
        visibility: 'internal',
        is_post_closure: true,
        body: 'Invoice number found.',
      }),
    ]);

    await screen.findByText('Invoice number found.');
    expect(screen.getByText('Internal')).toBeInTheDocument();
    expect(screen.getByText('After closure')).toBeInTheDocument();
  });

  it('refuses an empty comment without calling the API', async () => {
    const { calls } = renderThread([]);

    await screen.findByText('No comments on this request yet.');
    fireEvent.click(screen.getByRole('button', { name: /post comment/i }));

    expect(await screen.findByText(/at least 1 non-space character/i)).toBeInTheDocument();
    expect(calls).not.toContain(POST_URL);
  });

  it('refuses whitespace-only content as well', async () => {
    const { calls } = renderThread([]);

    await screen.findByText('No comments on this request yet.');
    fireEvent.change(screen.getByLabelText('Add a comment'), { target: { value: '   \n\t ' } });
    fireEvent.click(screen.getByRole('button', { name: /post comment/i }));

    expect(await screen.findByText(/at least 1 non-space character/i)).toBeInTheDocument();
    expect(calls).not.toContain(POST_URL);
  });

  it('refuses a body longer than the contract maximum before sending it', async () => {
    const { calls } = renderThread([]);

    await screen.findByText('No comments on this request yet.');
    fireEvent.change(screen.getByLabelText('Add a comment'), {
      target: { value: 'x'.repeat(5001) },
    });
    expect(screen.getByText('5001/5000 characters')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /post comment/i }));
    expect(await screen.findByText(/at most 5000 characters/i)).toBeInTheDocument();
    expect(calls).not.toContain(POST_URL);
  });

  it('sends the trimmed body and refetches the thread the server just wrote', async () => {
    const posts: string[] = [];
    const reads: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') {
          posts.push(typeof init.body === 'string' ? init.body : '');
          return jsonResponse(201, {
            data: commentFixture({ id: '99', body: 'Laptop reimaged.' }),
          });
        }
        reads.push(url);
        return jsonResponse(
          200,
          listBody([commentFixture({ id: '99', body: 'Laptop reimaged.' })]),
        );
      }),
    );

    renderWithProviders(<CommentThread requestId="7" allowInternal={false} />);
    await screen.findByText('Laptop reimaged.');

    fireEvent.change(screen.getByLabelText('Add a comment'), {
      target: { value: '  Keyboard cleaned.  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /post comment/i }));

    expect(await screen.findByText(/Comment posted and recorded/i)).toBeInTheDocument();
    // `.parse()` inside the mutation applies the shared schema, so the wire carries trimmed text.
    const payload = posts[0] ?? '';
    expect(payload).not.toBe('');
    expect(JSON.parse(payload)).toEqual({
      body: 'Keyboard cleaned.',
      visibility: 'public',
    });
    await waitFor(() => expect(reads.filter((url) => url === LIST_URL)).toHaveLength(2));
  });

  it('renders the API rejection verbatim instead of silently swallowing it', async () => {
    stubFetch({
      [LIST_URL]: jsonResponse(200, listBody([])),
      [POST_URL]: jsonResponse(403, {
        error: { code: 'FORBIDDEN', message: 'You may not comment on this request.' },
      }),
    });

    renderWithProviders(<CommentThread requestId="7" allowInternal={false} />);
    await screen.findByText('No comments on this request yet.');

    fireEvent.change(screen.getByLabelText('Add a comment'), { target: { value: 'Any update?' } });
    fireEvent.click(screen.getByRole('button', { name: /post comment/i }));

    expect(await screen.findByText('You may not comment on this request.')).toBeInTheDocument();
    expect(screen.getByText(/FORBIDDEN · HTTP 403/)).toBeInTheDocument();
  });

  it('hides the internal choice from a caller the API treats as staff-less', async () => {
    renderThread([commentFixture()]);
    await screen.findByText('Reimaged from the golden build.');

    expect(screen.queryByLabelText('Visibility')).toBeNull();
  });

  it('offers the internal choice when the caller is in staff view', async () => {
    renderThread([commentFixture()], true);
    await screen.findByText('Reimaged from the golden build.');

    const select = screen.getByLabelText('Visibility');
    expect(within(select).getByRole('option', { name: /internal/i })).toBeInTheDocument();
  });

  it('surfaces the access error the API returned for the thread', async () => {
    stubFetch({
      [LIST_URL]: jsonResponse(403, {
        error: { code: 'FORBIDDEN', message: 'You may not read this request.' },
      }),
    });

    renderWithProviders(<CommentThread requestId="7" allowInternal={false} />);

    expect(await screen.findByText('You may not read this request.')).toBeInTheDocument();
    expect(screen.getByText(/Comments unavailable/)).toBeInTheDocument();
  });
});

describe('TimelineFeed', () => {
  it('merges lifecycle events and comments in feed order', async () => {
    renderTimeline([
      entryFixture(),
      entryFixture({
        id: 'e2',
        event_type: 'assigned',
        actor: { id: '31', full_name: 'Devi Menon' },
        actor_role: 'agent',
        from_status: 'submitted',
        to_status: 'assigned',
        created_at: '2026-10-20T09:30:00.000Z',
      }),
      entryFixture({
        id: 'c1',
        event_type: 'comment_added',
        kind: 'comment',
        actor: { id: '31', full_name: 'Devi Menon' },
        actor_role: 'agent',
        from_status: null,
        to_status: null,
        detail: { body: 'Collecting the asset tag.', characters: 28 },
        created_at: '2026-10-20T10:00:00.000Z',
      }),
    ]);

    await screen.findByText('Collecting the asset tag.');
    const items = itemTexts();

    expect(items).toHaveLength(3);
    expect(items[0]).toContain('Created');
    expect(items[1]).toContain('Submitted → Assigned');
    expect(items[1]).toContain('Devi Menon');
    expect(items[2]).toContain('Comment added');
    expect(items[2]).toContain('Collecting the asset tag.');
  });

  it('falls back to System when an entry has no actor', async () => {
    renderTimeline([entryFixture({ actor: null, actor_role: 'system' })]);

    await screen.findByText('System');
    // The role snapshot travels with the entry, so an actor-less row still says who acted.
    expect(itemTexts()[0]).toContain('system');
  });

  it('renders hostile text inside a timeline entry as text', async () => {
    const payload = '<svg onload=alert(1)>';
    const { container } = renderTimeline([
      entryFixture({ detail: { body: payload }, kind: 'comment', to_status: null }),
    ]);

    await screen.findByText(payload);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('explains an empty feed instead of rendering a blank card', async () => {
    renderTimeline([]);

    expect(await screen.findByText(/Nothing has happened/i)).toBeInTheDocument();
  });
});
