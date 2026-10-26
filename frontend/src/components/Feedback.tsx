import type { ReactNode } from 'react';
import { ApiError } from '../lib/apiClient';
import { cx } from '../lib/cx';

/** Loading affordance for query-driven regions; announced to screen readers. */
export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-ink-muted">
      <span
        aria-hidden="true"
        className="inline-block size-4 animate-spin rounded-full border-2 border-border border-t-brand"
      />
      {label}…
    </p>
  );
}

interface NoticeProps {
  readonly tone: 'info' | 'success' | 'warning' | 'danger';
  readonly title?: string;
  readonly children: ReactNode;
}

const TONE_CLASSES: Record<NoticeProps['tone'], string> = {
  info: 'border-slate-300 bg-slate-50 text-ink',
  success: 'border-sla-safe/40 bg-sla-safe/10 text-ink',
  warning: 'border-sla-warning/40 bg-sla-warning/10 text-ink',
  danger: 'border-sla-breached/40 bg-sla-breached/10 text-ink',
};

/** Neutral information block — the same visual language for every non-error message. */
export function Notice({ tone, title, children }: NoticeProps) {
  return (
    <div
      className={cx('rounded-lg border px-3 py-2 text-sm', TONE_CLASSES[tone])}
      role={tone === 'danger' ? 'alert' : undefined}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      <div className="mt-0.5 space-y-1">{children}</div>
    </div>
  );
}

/**
 * Renders a failure from the API boundary. The error code and `request_id` are shown because
 * they are the exact values backend logs carry, which is what makes a bug report actionable
 * (docs/api-specification.md §1.1).
 */
export function ErrorNotice({
  error,
  heading = 'This section could not be loaded',
}: {
  error: unknown;
  heading?: string;
}) {
  if (error instanceof ApiError) {
    return (
      <Notice tone="danger" title={heading}>
        <p>{error.message}</p>
        <p className="font-mono text-xs">
          {error.code} · HTTP {error.status || '—'}
          {error.requestId ? ` · request ${error.requestId}` : ''}
        </p>
        {error.details?.length ? (
          <ul className="list-disc pl-5 text-xs">
            {error.details.map((detail, index) => (
              <li key={`${detail.path}-${index}`}>
                <span className="font-mono">{detail.path}</span>: {detail.message}
              </li>
            ))}
          </ul>
        ) : null}
      </Notice>
    );
  }
  return (
    <Notice tone="danger" title={heading}>
      <p>Something went wrong while loading this page.</p>
    </Notice>
  );
}

/** labelled key/value row used by the overview cards and tables. */
export function Definition({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 last:border-0">
      <dt className="text-sm text-ink-muted">{term}</dt>
      <dd className="text-right text-sm font-medium text-ink">{children}</dd>
    </div>
  );
}
