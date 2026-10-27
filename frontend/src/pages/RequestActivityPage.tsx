import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CommentThread, TimelineFeed } from '../components/Activity';
import { Notice } from '../components/Feedback';

/**
 * Request activity workspace: the comment thread and the activity timeline for one request, side by
 * side. The request is addressed by id in the path (`/requests/:id/activity`), which is also how the
 * two endpoints are scoped.
 *
 * Two honest limitations of this screen, both stated in the UI rather than hidden:
 *  - the SPA has no session yet (Phase 5), so it cannot know whether the caller holds
 *    `comment.internal`. The staff toggle below only reveals the *option*; a request to post an
 *    internal note without the permission is refused by the API with HTTP 403, exactly as the
 *    SLA policy editor demonstrates `UNAUTHENTICATED` today;
 *  - what is shown here is the user-visible activity feed (`request_events` + `comments`). The audit
 *    trail (`audit_logs`) is an administrative record with before/after values and has no read
 *    endpoint, so it can never be surfaced by mistake.
 */
export function RequestActivityPage() {
  const { id: requestId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [staffMode, setStaffMode] = useState(false);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Request activity</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Comments people write, and the append-only timeline of what happened to request{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">
            {requestId || '—'}
          </code>
          .
        </p>
      </header>

      <form
        className="card flex flex-wrap items-end gap-3 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          const value = new FormData(event.currentTarget).get('request-id');
          const target = typeof value === 'string' ? value.trim() : '';
          if (/^\d+$/.test(target)) void navigate(`/requests/${target}/activity`);
        }}
      >
        <div className="min-w-56 flex-1">
          <label className="label" htmlFor="request-id">
            Request id
          </label>
          {/* Uncontrolled and re-keyed by the route: navigating always shows the request in view. */}
          <input
            key={requestId}
            id="request-id"
            name="request-id"
            className="field"
            defaultValue={requestId}
            inputMode="numeric"
            pattern="\d+"
            title="A numeric request id"
            placeholder="e.g. 1"
          />
        </div>
        <button type="submit" className="btn btn-primary">
          Load request
        </button>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={staffMode}
            onChange={(event) => setStaffMode(event.target.checked)}
          />
          Staff view (offers internal comments)
        </label>
      </form>

      {requestId ? (
        <>
          <div className="grid gap-6 xl:grid-cols-2">
            <TimelineFeed requestId={requestId} />
            <CommentThread requestId={requestId} allowInternal={staffMode} />
          </div>

          <Notice tone="info" title="What this list is not">
            <ul className="list-disc pl-5">
              <li>
                The timeline is the request&apos;s activity feed. Administrative audit entries live
                in a separate append-only table that this application never reads back.
              </li>
              <li>
                Internal notes are filtered by the API for callers without the staff permission —
                the toggle above cannot grant a right, it only shows the choice.
              </li>
            </ul>
          </Notice>
        </>
      ) : (
        <Notice tone="warning" title="No request selected">
          <p>Open a request with a path such as /requests/1/activity.</p>
        </Notice>
      )}
    </div>
  );
}
