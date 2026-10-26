import { Link } from 'react-router-dom';

/** 404 inside the app shell — the API has its own `NOT_FOUND` envelope for unknown routes. */
export function NotFoundPage() {
  return (
    <div className="card mx-auto max-w-xl p-6 text-center">
      <p className="text-5xl font-bold tracking-tight text-brand">404</p>
      <h1 className="mt-2 text-lg font-semibold">That page does not exist</h1>
      <p className="mt-1 text-sm text-ink-muted">
        The route you asked for is not part of the portal. Modules are added phase by phase, so it
        may simply not be built yet.
      </p>
      <Link to="/" className="btn btn-primary mt-4">
        Back to the overview
      </Link>
    </div>
  );
}
