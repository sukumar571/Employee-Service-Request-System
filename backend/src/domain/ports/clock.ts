/**
 * Injectable time port (docs/requirements.md NFR-6): every SLA/lifecycle calculation receives a
 * `Clock` so unit tests advance time deterministically instead of sleeping.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Test/demo helper: a clock that only moves when told to. */
export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(value: Date | string): void {
    this.current = new Date(value);
  }

  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }
}
