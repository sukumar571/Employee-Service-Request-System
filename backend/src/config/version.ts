/**
 * API version reported by `/health/*` and `/meta`.
 * Kept in code (not read from package.json at runtime) so the production `dist/` folder stays
 * self-contained; a unit test asserts it matches `backend/package.json`.
 */
export const API_VERSION = '0.1.0';

/** Path version from docs/api-specification.md §14. */
export const API_BASE_PATH = '/api/v1';
