import type { BusinessHours } from '@esrs/shared';

/**
 * Business-hours arithmetic (docs/requirements.md §8) — pure, framework-free and timezone aware.
 *
 * All accumulation happens in *local wall-clock* space of the configured time zone, so
 * "24 business hours" means 24 hours inside the open window, never 24 elapsed real hours.
 * IST has no DST, but the implementation resolves the offset per instant so a time zone with
 * DST behaves sanely too (docs/database-design.md §2.8 keeps the window on each tracker).
 *
 * Covered by TC-SLA-01…07 in docs/test-plan.md §1.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

export interface BusinessWindow {
  /** ISO day numbers (1 = Monday … 7 = Sunday). */
  readonly days: readonly number[];
  readonly startMinutes: number;
  readonly endMinutes: number;
  readonly timeZone: string;
}

export class InvalidBusinessWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBusinessWindowError';
  }
}

export function toWindow(config: BusinessHours): BusinessWindow {
  const start = toMinutesOfDay(config.start);
  const end = toMinutesOfDay(config.end);
  if (end <= start) {
    throw new InvalidBusinessWindowError(
      `Window end (${config.end}) must be after start (${config.start})`,
    );
  }
  const days = [...new Set(config.days)].filter(
    (day) => Number.isInteger(day) && day >= 1 && day <= 7,
  );
  if (days.length === 0) {
    throw new InvalidBusinessWindowError('A business-hours window needs at least one weekday');
  }
  return { days, startMinutes: start, endMinutes: end, timeZone: config.timezone };
}

function toMinutesOfDay(hhmm: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) throw new InvalidBusinessWindowError(`Invalid HH:MM value '${hhmm}'`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59)
    throw new InvalidBusinessWindowError(`Invalid time value '${hhmm}'`);
  return hours * 60 + minutes;
}

/** Day index: whole days since 1970-01-01 (which was a Thursday, ISO day 4). */
function dayIndex(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

function isoDayOf(dayIndex: number): number {
  return (((dayIndex % 7) + 3) % 7) + 1;
}

interface CumulativeModel {
  readonly window: BusinessWindow;
  readonly minutesPerOpenDay: number;
  readonly minutesPerWeek: number;
  /** Business minutes elapsed before the start of each day of the 7-day cycle anchored on 1970-01-01. */
  readonly cyclePrefix: number[];
}

function buildModel(window: BusinessWindow): CumulativeModel {
  const minutesPerOpenDay = window.endMinutes - window.startMinutes;
  const isOpenDay = (dayIdx: number) => window.days.includes(isoDayOf(dayIdx));

  const cyclePrefix: number[] = [0];
  for (let offset = 0; offset < 7; offset += 1) {
    cyclePrefix.push(cyclePrefix[offset]! + (isOpenDay(offset) ? minutesPerOpenDay : 0));
  }

  return {
    window,
    minutesPerOpenDay,
    minutesPerWeek: cyclePrefix[7]!,
    cyclePrefix,
  };
}

/** Business minutes elapsed strictly before the given local date (at 00:00). */
function minutesBeforeDay(model: CumulativeModel, dayIdx: number): number {
  if (dayIdx < 0) {
    throw new InvalidBusinessWindowError('Business-hour math does not support dates before 1970');
  }
  const weeks = Math.floor(dayIdx / 7);
  const rest = dayIdx - weeks * 7;
  return weeks * model.minutesPerWeek + model.cyclePrefix[rest]!;
}

interface WallClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(instant: Date, timeZone: string): WallClockParts {
  let formatter = partFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    partFormatters.set(timeZone, formatter);
  }

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function offsetMinutesAt(instant: Date, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return Math.round(
    (asUtc - Math.floor(instant.getTime() / MS_PER_MINUTE) * MS_PER_MINUTE) / MS_PER_MINUTE,
  );
}

/** Business minutes elapsed at the given instant (clamped to window edges). */
export function businessMinutesAt(instant: Date, window: BusinessWindow): number {
  const model = buildModel(window);
  const w = wallClock(instant, window.timeZone);
  const dayIdx = dayIndex(w.year, w.month, w.day);
  const minuteOfDay = w.hour * 60 + w.minute;

  let withinDay = 0;
  if (window.days.includes(isoDayOf(dayIdx))) {
    withinDay = Math.min(Math.max(minuteOfDay - window.startMinutes, 0), model.minutesPerOpenDay);
  }
  return minutesBeforeDay(model, dayIdx) + withinDay;
}

/** Convert "business minutes since epoch" back to an instant. */
function instantAtBusinessMinutes(model: CumulativeModel, target: number): Date {
  const { window } = model;
  // Start from the week containing the estimate, then walk forward day by day (max ~7 steps).
  let dayIdx = Math.floor(target / model.minutesPerWeek) * 7;
  let guard = 0;
  while (minutesBeforeDay(model, dayIdx + 1) < target && guard < 14) {
    dayIdx += 1;
    guard += 1;
  }

  // A target that lands exactly on a boundary may resolve onto a non-working day: move to the
  // next working day so a due date is never Sat/Sun 09:00.
  guard = 0;
  while (!window.days.includes(isoDayOf(dayIdx)) && guard < 7) {
    dayIdx += 1;
    guard += 1;
  }

  const withinDay = Math.min(target - minutesBeforeDay(model, dayIdx), model.minutesPerOpenDay);
  const minuteOfDay = window.startMinutes + withinDay;

  const { year, month, day } = utcParts(dayIdx);

  // Interpret the local wall clock in the configured zone (two-pass offset for DST safety).
  const naive = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  let offset = offsetMinutesAt(new Date(naive), window.timeZone);
  let instantMs = naive - offset * MS_PER_MINUTE;
  const recheck = offsetMinutesAt(new Date(instantMs), window.timeZone);
  if (recheck !== offset) {
    offset = recheck;
    instantMs = naive - offset * MS_PER_MINUTE;
  }
  return new Date(instantMs);
}

function utcParts(dayIdx: number): { year: number; month: number; day: number } {
  const date = new Date(dayIdx * MS_PER_DAY);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** Add `minutes` of business time to `start` (used to compute SLA due dates). */
export function addBusinessMinutes(start: Date, minutes: number, window: BusinessWindow): Date {
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new InvalidBusinessWindowError(
      `Business minute target must be a positive integer, got ${minutes}`,
    );
  }
  const model = buildModel(window);
  return instantAtBusinessMinutes(model, businessMinutesAt(start, window) + minutes);
}

/** Elapsed business minutes between two instants (never negative). */
export function elapsedBusinessMinutes(from: Date, to: Date, window: BusinessWindow): number {
  return Math.max(0, businessMinutesAt(to, window) - businessMinutesAt(from, window));
}

/** Remaining business minutes from `from` until `due` (0 once due has passed). */
export function remainingBusinessMinutes(from: Date, due: Date, window: BusinessWindow): number {
  return elapsedBusinessMinutes(from, due, window);
}

export type { CumulativeModel };
