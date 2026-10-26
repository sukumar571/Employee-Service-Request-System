import { DEFAULT_BUSINESS_HOURS } from '@esrs/shared';
import { describe, expect, it } from 'vitest';
import {
  addBusinessMinutes,
  businessMinutesAt,
  elapsedBusinessMinutes,
  InvalidBusinessWindowError,
  remainingBusinessMinutes,
  toWindow,
} from './businessHours.js';
import type { BusinessWindow } from './businessHours.js';

const IST_OFFSET_MINUTES = 5 * 60 + 30; // Asia/Kolkata, no DST

/** Wall-clock constructor for Asia/Kolkata instants (TC table values are IST). */
function ist(year: number, month: number, day: number, hour = 9, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - IST_OFFSET_MINUTES * 60_000);
}

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
});

function label(instant: Date): string {
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// 2026-10-25 is a Sunday, so the working week under test starts Monday the 26th.
const MON_26 = ist(2026, 10, 26);
const TUE_27 = ist(2026, 10, 27);
const WED_28 = ist(2026, 10, 28);
const THU_29 = ist(2026, 10, 29);
const FRI_30 = ist(2026, 10, 30);
const SAT_31 = ist(2026, 10, 31);

const window9h: BusinessWindow = toWindow(DEFAULT_BUSINESS_HOURS); // Mon–Fri 09:00–18:00 = 540 min/day

describe('business window parsing (TC-SLA-05 and validation)', () => {
  it('parses the default 9-hour weekday window', () => {
    expect(window9h).toEqual({
      days: [1, 2, 3, 4, 5],
      startMinutes: 540,
      endMinutes: 1_080,
      timeZone: 'Asia/Kolkata',
    });
  });

  it('rejects an end that is not after the start', () => {
    expect(() => toWindow({ ...DEFAULT_BUSINESS_HOURS, end: '09:00' })).toThrow(
      InvalidBusinessWindowError,
    );
  });

  it('rejects an empty day list and malformed times', () => {
    expect(() => toWindow({ ...DEFAULT_BUSINESS_HOURS, days: [] })).toThrow(
      InvalidBusinessWindowError,
    );
    expect(() => toWindow({ ...DEFAULT_BUSINESS_HOURS, start: '9:0' })).toThrow(
      InvalidBusinessWindowError,
    );
  });

  it('rejects non-positive SLA targets', () => {
    expect(() => addBusinessMinutes(MON_26, 0, window9h)).toThrow(InvalidBusinessWindowError);
    expect(() => addBusinessMinutes(MON_26, -30, window9h)).toThrow(InvalidBusinessWindowError);
  });
});

describe('addBusinessMinutes (TC-SLA-01…04)', () => {
  it('TC-SLA-01: Mon 10:00 + 24 business-h ⇒ Wed 16:00', () => {
    const due = addBusinessMinutes(ist(2026, 10, 26, 10, 0), 1_440, window9h);
    expect(label(due)).toBe('Wed 2026-10-28 16:00');
  });

  it('TC-SLA-02: Fri 18:30 (outside hours) + 4 business-h ⇒ Mon 13:00', () => {
    const due = addBusinessMinutes(ist(2026, 10, 30, 18, 30), 240, window9h);
    expect(label(due)).toBe('Mon 2026-11-02 13:00');
  });

  it('TC-SLA-03: Sat 11:00 + 1 business-h ⇒ Mon 10:00', () => {
    const due = addBusinessMinutes(ist(2026, 10, 31, 11, 0), 60, window9h);
    expect(label(due)).toBe('Mon 2026-11-02 10:00');
  });

  it('TC-SLA-04: paused span Tue 09:00–Thu 09:00 costs 18 business-h, moving due Fri 15:00', () => {
    const unpaused = addBusinessMinutes(MON_26, 1_440, window9h);
    expect(label(unpaused)).toBe('Wed 2026-10-28 15:00');

    const pausedMinutes = elapsedBusinessMinutes(TUE_27, THU_29, window9h);
    expect(pausedMinutes).toBe(1_080);

    const resumed = addBusinessMinutes(MON_26, 1_440 + pausedMinutes, window9h);
    expect(label(resumed)).toBe('Fri 2026-10-30 15:00');
  });

  it('a target landing exactly at close of business stays on that day', () => {
    const due = addBusinessMinutes(MON_26, 540, window9h);
    expect(label(due)).toBe('Mon 2026-10-26 18:00');
  });

  it('respects a custom window (24×7 Sat–Sun support rota)', () => {
    // SAT_31 is Sat 09:00 IST; under the default Mon–Fri window this would roll to Monday,
    // so a Saturday due date proves the rota days are honoured.
    const always = toWindow({
      days: [6, 7],
      start: '00:00',
      end: '23:59',
      timezone: 'Asia/Kolkata',
    });
    const due = addBusinessMinutes(SAT_31, 120, always);
    expect(label(due)).toBe('Sat 2026-10-31 11:00');
  });
});

describe('elapsed / remaining business minutes (TC-SLA-07)', () => {
  it('counts only open-window minutes across a weekend', () => {
    // Mon 09:00 → following Mon 09:00 = 5 working days × 540 min.
    expect(elapsedBusinessMinutes(MON_26, ist(2026, 11, 2, 9, 0), window9h)).toBe(2_700);
  });

  it('is 0 while the clock has not started and never negative', () => {
    expect(elapsedBusinessMinutes(SAT_31, SAT_31, window9h)).toBe(0);
    expect(elapsedBusinessMinutes(WED_28, MON_26, window9h)).toBe(0);
    expect(remainingBusinessMinutes(FRI_30, MON_26, window9h)).toBe(0);
  });

  it('clamps to the window: time outside hours is not charged', () => {
    expect(elapsedBusinessMinutes(ist(2026, 10, 26, 3, 0), ist(2026, 10, 26, 8, 0), window9h)).toBe(
      0,
    );
    expect(
      elapsedBusinessMinutes(ist(2026, 10, 26, 9, 0), ist(2026, 10, 26, 22, 0), window9h),
    ).toBe(540);
  });

  it('businessMinutesAt is monotonic in time', () => {
    const points = [MON_26, TUE_27, WED_28, THU_29, FRI_30, SAT_31, ist(2026, 11, 2, 9, 0)];
    const values = points.map((point) => businessMinutesAt(point, window9h));
    expect(values.every((value, index) => index === 0 || value >= values[index - 1]!)).toBe(true);
    expect(values.at(-1)! - values[0]!).toBe(2_700);
  });

  it('TC-SLA-06 (property): adding n minutes then measuring elapsed returns n', () => {
    // Deterministic pseudo-random sweep over 200 start instants and targets.
    let seed = 42;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };

    for (let iteration = 0; iteration < 200; iteration += 1) {
      const startMs = MON_26.getTime() + Math.floor(next() * 45 * 24 * 60) * 60_000;
      const minutes = 1 + Math.floor(next() * 3_000);
      const start = new Date(startMs);
      const due = addBusinessMinutes(start, minutes, window9h);
      expect(elapsedBusinessMinutes(start, due, window9h)).toBe(minutes);
    }
  });
});
