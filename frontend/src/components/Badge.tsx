import type { RequestPriority, RequestStatus, SlaState } from '@esrs/shared';
import { humanize } from '../lib/format';
import { cx } from '../lib/cx';

/**
 * Status/priority/SLA chips. Class strings are written out in full because Tailwind only emits
 * utilities it can see statically — `text-status-${status}` would silently produce no CSS.
 * The palette is the token set declared in `src/index.css`.
 */
const STATUS_CLASSES: Record<RequestStatus, string> = {
  draft: 'border-status-draft/40 bg-status-draft/10 text-status-draft',
  submitted: 'border-status-submitted/40 bg-status-submitted/10 text-status-submitted',
  assigned: 'border-status-assigned/40 bg-status-assigned/10 text-status-assigned',
  in_progress: 'border-status-in-progress/40 bg-status-in-progress/10 text-status-in-progress',
  on_hold: 'border-status-on-hold/40 bg-status-on-hold/10 text-status-on-hold',
  resolved: 'border-status-resolved/40 bg-status-resolved/10 text-status-resolved',
  closed: 'border-status-closed/40 bg-status-closed/10 text-status-closed',
  cancelled: 'border-status-cancelled/40 bg-status-cancelled/10 text-status-cancelled',
};

const PRIORITY_CLASSES: Record<RequestPriority, string> = {
  low: 'border-priority-low/40 bg-priority-low/10 text-priority-low',
  medium: 'border-priority-medium/40 bg-priority-medium/10 text-priority-medium',
  high: 'border-priority-high/40 bg-priority-high/10 text-priority-high',
  critical: 'border-priority-critical/40 bg-priority-critical/10 text-priority-critical',
};

const SLA_CLASSES: Record<SlaState, string> = {
  safe: 'border-sla-safe/40 bg-sla-safe/10 text-sla-safe',
  warning: 'border-sla-warning/40 bg-sla-warning/10 text-sla-warning',
  breached: 'border-sla-breached/40 bg-sla-breached/10 text-sla-breached',
};

function Badge({ className, label, title }: { className: string; label: string; title?: string }) {
  return (
    <span className={cx('badge', className)} title={title}>
      {label}
    </span>
  );
}

export function StatusBadge({ status }: { status: RequestStatus }) {
  return <Badge className={STATUS_CLASSES[status]} label={humanize(status)} />;
}

export function PriorityBadge({ priority }: { priority: RequestPriority }) {
  return <Badge className={PRIORITY_CLASSES[priority]} label={`${humanize(priority)} priority`} />;
}

export function SlaBadge({
  state,
  remainingMinutes,
}: {
  state: SlaState;
  remainingMinutes?: number | null;
}) {
  const label =
    state === 'breached'
      ? 'SLA breached'
      : remainingMinutes === null || remainingMinutes === undefined
        ? `SLA ${humanize(state)}`
        : `${humanize(state)} · ${remainingMinutes} min left`;
  return <Badge className={SLA_CLASSES[state]} label={label} />;
}
