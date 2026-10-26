import { describe, expect, it } from 'vitest';
import { FixedClock, systemClock } from './clock.js';

describe('FixedClock — deterministic time for SLA tests (NFR-6)', () => {
  const start = new Date('2026-10-26T10:00:00+05:30');

  it('returns the instant it was set to', () => {
    expect(new FixedClock(start).now().getTime()).toBe(start.getTime());
  });

  it('advances only when told to', () => {
    const clock = new FixedClock(start);
    clock.advanceMinutes(90);
    expect(clock.now().getTime()).toBe(start.getTime() + 90 * 60_000);
  });

  it('hands out copies, so a caller cannot move the clock by mutating a Date', () => {
    const clock = new FixedClock(start);
    const snapshot = clock.now();
    snapshot.setFullYear(2030);
    expect(clock.now().getFullYear()).toBe(2026);
  });

  it('accepts an ISO string and can move backwards (the sweep tests rely on this)', () => {
    const clock = new FixedClock(start);
    clock.set('2026-10-26T09:59:00+05:30');
    expect(clock.now().getTime()).toBe(start.getTime() - 60_000);
  });
});

describe('systemClock', () => {
  it('tracks wall time', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});
