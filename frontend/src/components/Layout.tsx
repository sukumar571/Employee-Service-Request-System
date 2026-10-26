import { NavLink, Outlet } from 'react-router-dom';
import { APP_NAME } from '../lib/config';
import { cx } from '../lib/cx';

/**
 * Application shell: sticky header, primary navigation and the routed `<main>` region.
 * Nav links use `NavLink` so the active route is expressed with `aria-current="page"`
 * rather than a class alone (docs/requirements.md NFR-8).
 */
const NAV_ITEMS = [
  { to: '/', label: 'Overview', end: true },
  { to: '/lifecycle', label: 'Lifecycle', end: false },
  { to: '/sla/policies', label: 'SLA policies', end: false },
] as const;

function navClass({ isActive }: { isActive: boolean }): string {
  return cx(
    'rounded-lg px-3 py-2 text-sm font-medium transition',
    isActive ? 'bg-brand text-white' : 'text-ink-muted hover:bg-slate-100 hover:text-ink',
  );
}

export function Layout() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
          <NavLink to="/" className="text-lg font-bold tracking-tight text-brand">
            {APP_NAME}
          </NavLink>
          <nav aria-label="Primary" className="flex flex-wrap gap-1">
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <span className="ml-auto text-xs text-ink-muted">
            Sign-in arrives with Phase&nbsp;5 (JWT auth)
          </span>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <Outlet />
      </main>

      <footer className="border-t border-border bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-4 text-xs text-ink-muted">
          {APP_NAME} — internship reference build. Contract and design documents live in
          <code className="ml-1 rounded bg-slate-100 px-1 py-0.5">docs/</code>.
        </div>
      </footer>
    </div>
  );
}
