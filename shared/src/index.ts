/**
 * `@esrs/shared` — the contract package.
 * Backend and frontend both import from here; nothing in this package may import
 * Express, `pg` or Node built-ins (enforced by eslint.config.mjs).
 */
export * from './enums/index.js';
export * from './enums/errorCodes.js';
export * from './domain/requestTransitions.js';
export * from './dto/envelope.js';
export * from './dto/slaPolicy.js';
export * from './dto/meta.js';
export * from './dto/auth.js';

/** Bumped on any breaking contract change (docs/api-specification.md §14). */
export const CONTRACT_VERSION = '1.0.0';
