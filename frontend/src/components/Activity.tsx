import { COMMENT_BODY_MAX, createCommentBodySchema } from '@esrs/shared';
import type { CommentDto, CommentVisibility } from '@esrs/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import type { ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { useAddComment, useRequestComments, useRequestTimeline } from '../api/queries';
import { formatInstant, humanize } from '../lib/format';
import { cx } from '../lib/cx';
import { ErrorNotice, Notice, Spinner } from './Feedback';

/**
 * Comments and the activity timeline for a single request (docs/api-specification.md §7).
 *
 * **Rendering rule that matters:** every string in this file reaches the DOM as a React *child*, and
 * React escapes `<`, `>`, `&` and `"` in children. React's raw-HTML prop is never used here, and
 * nothing derived from user content is ever used as a URL, a `target` or a class name — so a comment
 * body containing `<script>` or `<img onerror=…>` is displayed as literal text instead of executing
 * (docs/security-plan.md §4). `whitespace-pre-wrap` is what preserves newlines; it is CSS, not HTML.
 *
 * The two feeds are kept visually distinct on purpose: comments are people talking, the timeline is
 * the append-only activity record. Neither is the audit log, which has no read endpoint at all.
 */

/** Comment text is trusted only after the shared schema has checked it — server does the same. */
function commentBodyOf(entry: { detail: Record<string, unknown> }): string {
  const value = entry.detail.body;
  return typeof value === 'string' ? value : '';
}

function Meta({ children }: { children: ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">{children}</p>
  );
}

function Tag({ tone, label }: { tone: 'internal' | 'post-closure'; label: string }) {
  return (
    <span
      className={cx(
        'badge',
        tone === 'internal'
          ? 'border-sla-warning/40 bg-sla-warning/10 text-ink'
          : 'border-status-closed/40 bg-status-closed/10 text-ink',
      )}
    >
      {label}
    </span>
  );
}

interface ComposerProps {
  readonly requestId: string;
  /** Server-side `comment.internal` is the real gate; this only hides an option that would 403. */
  readonly allowInternal: boolean;
}

/**
 * The form mirrors the *input* side of the shared schema: `visibility` is optional because the schema
 * supplies the `public` default, which is why the submit below still has to resolve it.
 */
interface CommentFormValues {
  body: string;
  visibility?: CommentVisibility;
}

function CommentComposer({ requestId, allowInternal }: ComposerProps) {
  const mutation = useAddComment();

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors },
  } = useForm<CommentFormValues>({
    resolver: zodResolver(createCommentBodySchema),
    defaultValues: { body: '', visibility: 'public' },
  });

  const characters = watch('body').length;
  const tooLong = characters > COMMENT_BODY_MAX;

  const submit = handleSubmit((values) => {
    mutation.mutate(
      {
        requestId,
        body: { body: values.body, visibility: values.visibility ?? 'public' },
      },
      { onSuccess: () => reset({ body: '', visibility: 'public' }) },
    );
  });

  return (
    <form className="space-y-3" onSubmit={(event) => void submit(event)}>
      <div>
        <label className="label" htmlFor="comment-body">
          Add a comment
        </label>
        <textarea
          id="comment-body"
          className="field"
          rows={3}
          placeholder="Anything the people working on this request should know…"
          aria-describedby="comment-length"
          {...register('body')}
        />
        <div className="mt-1 flex items-baseline justify-between gap-3">
          <p className="text-xs text-sla-breached" aria-live="polite">
            {errors.body?.message ?? ''}
          </p>
          <p
            id="comment-length"
            className={cx('text-xs text-ink-muted', tooLong && 'font-semibold text-sla-breached')}
          >
            {characters}/{COMMENT_BODY_MAX} characters
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        {allowInternal ? (
          <div className="min-w-56 flex-1">
            <label className="label" htmlFor="comment-visibility">
              Visibility
            </label>
            <select id="comment-visibility" className="field" {...register('visibility')}>
              <option value="public">Public — the requester can read this</option>
              <option value="internal">Internal — staff only</option>
            </select>
          </div>
        ) : null}
        <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
          {mutation.isPending ? 'Posting…' : 'Post comment'}
        </button>
      </div>

      {mutation.isError ? (
        <ErrorNotice error={mutation.error} heading="The API rejected this comment" />
      ) : null}
      {mutation.isSuccess ? (
        <Notice tone="success">Comment posted and recorded in the activity timeline.</Notice>
      ) : null}
    </form>
  );
}

function CommentItem({ comment }: { comment: CommentDto }) {
  return (
    <li className="space-y-1 border-t border-border/60 pt-3 first:border-0 first:pt-0">
      <Meta>
        <span className="font-semibold text-ink">{comment.author.full_name}</span>
        <span>{formatInstant(comment.created_at)}</span>
        {comment.visibility === 'internal' ? <Tag tone="internal" label="Internal" /> : null}
        {comment.is_post_closure ? <Tag tone="post-closure" label="After closure" /> : null}
      </Meta>
      {/* Rendered as an escaped child; the raw-HTML prop is deliberately not used. */}
      <p className="text-sm break-words whitespace-pre-wrap text-ink">{comment.body}</p>
    </li>
  );
}

function actorLabel(entry: { actor: { id: string; full_name: string } | null }): string {
  return entry.actor ? entry.actor.full_name : 'System';
}

export function CommentThread({ requestId, allowInternal }: ComposerProps) {
  const comments = useRequestComments(requestId);

  return (
    <section aria-labelledby="comments-heading" className="card space-y-4 p-4">
      <h2
        id="comments-heading"
        className="text-sm font-semibold uppercase tracking-wide text-ink-muted"
      >
        Comments
        {comments.data ? (
          <span className="ml-1 normal-case">({comments.data.meta.total})</span>
        ) : null}
      </h2>

      {comments.isPending ? <Spinner label="Loading comments" /> : null}
      {comments.error ? (
        <ErrorNotice error={comments.error} heading="Comments unavailable" />
      ) : null}

      {comments.data ? (
        comments.data.data.length === 0 ? (
          <Notice tone="info">No comments on this request yet.</Notice>
        ) : (
          <ul className="space-y-3">
            {comments.data.data.map((comment) => (
              <CommentItem key={comment.id} comment={comment} />
            ))}
          </ul>
        )
      ) : null}

      <hr className="border-border/60" />
      <CommentComposer requestId={requestId} allowInternal={allowInternal} />
    </section>
  );
}

export function TimelineFeed({ requestId }: { requestId: string }) {
  const timeline = useRequestTimeline(requestId);

  return (
    <section aria-labelledby="timeline-heading" className="card space-y-4 p-4">
      <h2
        id="timeline-heading"
        className="text-sm font-semibold uppercase tracking-wide text-ink-muted"
      >
        Activity timeline
      </h2>

      {timeline.isPending ? <Spinner label="Loading activity" /> : null}
      {timeline.error ? (
        <ErrorNotice error={timeline.error} heading="Activity unavailable" />
      ) : null}

      {timeline.data ? (
        timeline.data.data.length === 0 ? (
          <Notice tone="info">Nothing has happened on this request yet.</Notice>
        ) : (
          <ol className="space-y-3">
            {timeline.data.data.map((entry) => {
              const transition =
                entry.from_status && entry.to_status
                  ? `${humanize(entry.from_status)} → ${humanize(entry.to_status)}`
                  : null;
              return (
                <li key={entry.id} className="relative space-y-1 pl-4">
                  <span
                    aria-hidden="true"
                    className={cx(
                      'absolute top-1.5 left-0 size-2 rounded-full',
                      entry.kind === 'comment' ? 'bg-sla-warning' : 'bg-brand',
                    )}
                  />
                  <Meta>
                    <span className="font-semibold text-ink">{actorLabel(entry)}</span>
                    <span className="font-mono text-xs">{humanize(entry.event_type)}</span>
                    {transition ? <span>{transition}</span> : null}
                    <span>{formatInstant(entry.created_at)}</span>
                    <span className="font-mono text-[0.65rem]">{entry.actor_role}</span>
                  </Meta>
                  {entry.kind === 'comment' ? (
                    <p className="text-sm break-words whitespace-pre-wrap text-ink">
                      {commentBodyOf(entry)}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )
      ) : null}
    </section>
  );
}
