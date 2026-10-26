import { lifecycleRules } from '@esrs/shared';
import { useCatalog, useLiveness, useReadiness } from '../api/queries';
import { Definition, ErrorNotice, Notice, Spinner } from '../components/Feedback';
import { SlaBadge } from '../components/Badge';
import { businessWindowLabel, formatInstant, humanize } from '../lib/format';

/**
 * Overview page: proves the three contract surfaces (liveness, readiness, catalogue) are wired
 * end-to-end. Everything shown here comes from the API; the transition table is the only fallback,
 * taken from `@esrs/shared`, so the page still renders if `/meta` is unreachable.
 */
export function DashboardPage() {
  const liveness = useLiveness();
  const readiness = useReadiness();
  const catalog = useCatalog();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Platform overview</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Live view of the REST API contract. Data is fetched from{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">
            /api/v1/health/live
          </code>
          ,{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">
            /api/v1/health/ready
          </code>{' '}
          and{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">/api/v1/meta</code>.
        </p>
      </header>

      {liveness.isPending || readiness.isPending ? <Spinner label="Checking API health" /> : null}
      {liveness.error ? (
        <ErrorNotice error={liveness.error} heading="API is not reachable" />
      ) : null}
      {readiness.error ? (
        <ErrorNotice error={readiness.error} heading="Readiness check failed" />
      ) : null}

      {liveness.data ? (
        <section aria-label="Service status" className="grid gap-4 md:grid-cols-2">
          <div className="card p-4">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-muted">
              Liveness
            </h2>
            <dl>
              <Definition term="Process">{humanize(liveness.data.status)}</Definition>
              <Definition term="Service">{liveness.data.service}</Definition>
              <Definition term="Version">{liveness.data.version}</Definition>
              <Definition term="Environment">{liveness.data.environment}</Definition>
              <Definition term="Checked at">
                {formatInstant(liveness.data.timestamp, 'UTC')}
              </Definition>
            </dl>
          </div>

          {readiness.data ? (
            <div className="card p-4">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-muted">
                Readiness
              </h2>
              <dl>
                <Definition term="Overall">{humanize(readiness.data.status)}</Definition>
                <Definition term="Database">
                  {readiness.data.database.state === 'up'
                    ? `Up${readiness.data.database.latency_ms === undefined ? '' : ` · ${readiness.data.database.latency_ms} ms`}`
                    : humanize(readiness.data.database.state)}
                </Definition>
                <Definition term="Uptime">{readiness.data.uptime_seconds.toFixed(0)} s</Definition>
                <Definition term="Version">{readiness.data.version}</Definition>
              </dl>
              {readiness.data.database.state === 'not_configured' ? (
                <p className="mt-3 text-xs text-ink-muted">
                  Start PostgreSQL (<code className="font-mono">npm run db:up</code>) and set{' '}
                  <code className="font-mono">DATABASE_URL</code> to enable persistence. The API
                  serves contract endpoints without it by design.
                </p>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <section aria-label="API contract" className="card p-4">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Contract catalogue
        </h2>
        {catalog.isPending ? <Spinner label="Loading contract" /> : null}
        {catalog.error ? (
          <ErrorNotice error={catalog.error} heading="Catalogue unavailable" />
        ) : null}
        {catalog.data ? (
          <>
            <dl className="grid gap-x-8 md:grid-cols-2">
              <Definition term="Contract version">{catalog.data.contract_version}</Definition>
              <Definition term="API version">{catalog.data.api.api_version}</Definition>
              <Definition term="Lifecycle statuses">
                {catalog.data.catalog.statuses.length}
              </Definition>
              <Definition term="Priorities">{catalog.data.catalog.priorities.length}</Definition>
              <Definition term="Roles">{catalog.data.catalog.roles.length}</Definition>
              <Definition term="Transitions">{catalog.data.transitions.length}</Definition>
              <Definition term="Business window">
                {businessWindowLabel(catalog.data.sla.business_hours)}
              </Definition>
              <Definition term="Warning threshold">
                {Math.round(catalog.data.sla.warning_ratio * 100)}% elapsed
              </Definition>
            </dl>
            <ul className="mt-3 flex flex-wrap gap-2">
              {(['safe', 'warning', 'breached'] as const).map((state) => (
                <li key={state}>
                  <SlaBadge state={state} />
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Notice tone="info" title="Using the bundled contract">
            <p>
              <code className="font-mono text-xs">@esrs/shared</code> describes{' '}
              {lifecycleRules().length} lifecycle rules locally, so the UI stays renderable while
              the API is offline.
            </p>
          </Notice>
        )}
      </section>
    </div>
  );
}
