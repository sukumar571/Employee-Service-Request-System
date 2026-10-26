/**
 * Runtime configuration, resolved from Vite env at build time.
 * Only `VITE_`-prefixed values reach the browser, and none of them are secret
 * (docs/security-plan.md §7: the SPA never holds a database URL or a signing key).
 */
function baseUrl(): string {
  const raw = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

export const API_BASE_URL = baseUrl();

export const APP_NAME = 'Employee Service Request System';

/** Poll cadence from docs/system-architecture.md §6 (health + bell are 60 s). */
export const HEALTH_POLL_MS = 30_000;
export const QUERY_STALE_MS = 15_000;
