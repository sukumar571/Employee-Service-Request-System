import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { API_BASE_PATH, API_VERSION } from './version.js';

describe('version constants', () => {
  it('reports the same version as backend/package.json (no drift between docs and build)', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(API_VERSION).toBe(pkg.version);
  });

  it('uses the versioned base path from the API specification §14', () => {
    expect(API_BASE_PATH).toBe('/api/v1');
  });
});
