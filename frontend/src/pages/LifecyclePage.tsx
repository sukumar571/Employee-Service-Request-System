import {
  REQUEST_STATUSES,
  USER_ROLES,
  allowedActionsFor,
  lifecycleRules,
  type ActorContext,
  type LifecycleRuleWire,
  type RequestStatus,
  type UserRole,
} from '@esrs/shared';
import { useMemo, useState } from 'react';
import { useCatalog } from '../api/queries';
import { StatusBadge } from '../components/Badge';
import { Notice, Spinner } from '../components/Feedback';
import { cx } from '../lib/cx';
import { humanize } from '../lib/format';

/**
 * Lifecycle explorer. The rule set comes from `GET /meta` when the API is up and from
 * `@esrs/shared` otherwise — both are generated from the same frozen table, so the explorer can
 * never disagree with the backend state machine that enforces it.
 */
function useRules(): { rules: LifecycleRuleWire[]; source: 'api' | 'bundled' } {
  const catalog = useCatalog();
  const bundled = useMemo(() => lifecycleRules(), []);
  if (catalog.data) return { rules: catalog.data.transitions, source: 'api' };
  return { rules: bundled, source: 'bundled' };
}

interface RowProps {
  readonly rule: LifecycleRuleWire;
  readonly allowed: boolean;
}

function RuleRow({ rule, allowed }: RowProps) {
  const constraints = [
    rule.requester_only ? 'requester only' : null,
    rule.assignee_only
      ? rule.managers_bypass
        ? 'assignee (managers bypass)'
        : 'assignee only'
      : null,
    rule.reason_required ? 'reason required' : null,
  ].filter((value): value is string => value !== null);

  return (
    <tr className={cx('border-b border-border/60 last:border-0', !allowed && 'text-ink-muted')}>
      <td className="px-3 py-2">
        <StatusBadge status={rule.from} />
      </td>
      <td className="px-3 py-2 font-mono text-xs">{rule.action}</td>
      <td className="px-3 py-2">
        <StatusBadge status={rule.to} />
      </td>
      <td className="px-3 py-2 text-xs">{rule.roles.map(humanize).join(', ')}</td>
      <td className="px-3 py-2 text-xs">{constraints.length ? constraints.join(' · ') : '—'}</td>
      <td className="px-3 py-2 text-xs font-semibold">
        {allowed ? (
          <span className="text-sla-safe">Allowed</span>
        ) : (
          <span className="text-ink-muted">Blocked</span>
        )}
      </td>
    </tr>
  );
}

export function LifecyclePage() {
  const [status, setStatus] = useState<RequestStatus>('submitted');
  const [role, setRole] = useState<UserRole>('agent');
  const [isRequester, setIsRequester] = useState(false);
  const [isAssignee, setIsAssignee] = useState(false);

  const catalog = useCatalog();
  const { rules, source } = useRules();

  const actor: ActorContext = { role, isRequester, isAssignee };
  const allowed = new Set(allowedActionsFor(status, actor));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Request lifecycle</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Pick a state and an actor to see which actions the shared state machine allows. Rules
          served from{' '}
          <span className="font-mono text-xs">
            {source === 'api' ? 'GET /meta' : '@esrs/shared'}
          </span>
          .
        </p>
      </header>

      <section className="card grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label" htmlFor="status">
            Current status
          </label>
          <select
            id="status"
            className="field"
            value={status}
            onChange={(event) => setStatus(event.target.value as RequestStatus)}
          >
            {REQUEST_STATUSES.map((value) => (
              <option key={value} value={value}>
                {humanize(value)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="role">
            Acting role
          </label>
          <select
            id="role"
            className="field"
            value={role}
            onChange={(event) => setRole(event.target.value as UserRole)}
          >
            {USER_ROLES.map((value) => (
              <option key={value} value={value}>
                {humanize(value)}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="space-y-1">
          <legend className="label">Relationship to the request</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isRequester}
              onChange={(event) => setIsRequester(event.target.checked)}
            />
            Is the requester
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isAssignee}
              onChange={(event) => setIsAssignee(event.target.checked)}
            />
            Is the current assignee
          </label>
        </fieldset>

        <div className="flex flex-col justify-end gap-2">
          <p className="text-sm text-ink-muted">Allowed actions</p>
          {allowed.size === 0 ? (
            <p className="text-sm font-semibold text-sla-breached">
              None — request would be rejected
            </p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {[...allowed].map((action) => (
                <li key={action}>
                  <span className="badge border-sla-safe/40 bg-sla-safe/10">{action}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {catalog.isPending ? <Spinner label="Loading lifecycle rules" /> : null}

      <section className="card overflow-x-auto">
        <table className="w-full min-w-[46rem] text-left text-sm">
          <caption className="sr-only">
            Lifecycle transition rules filtered by the selected actor
          </caption>
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-ink-muted">
            <tr>
              <th className="px-3 py-2">From</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">To</th>
              <th className="px-3 py-2">Roles</th>
              <th className="px-3 py-2">Constraints</th>
              <th className="px-3 py-2">For this actor</th>
            </tr>
          </thead>
          <tbody>
            {rules
              .filter((rule) => rule.from === status)
              .map((rule) => (
                <RuleRow
                  key={`${rule.from}-${rule.action}`}
                  rule={rule}
                  allowed={allowed.has(rule.action)}
                />
              ))}
          </tbody>
        </table>
        {rules.every((rule) => rule.from !== status) ? (
          <Notice tone="info">This status has no outgoing transitions (terminal state).</Notice>
        ) : null}
      </section>
    </div>
  );
}
