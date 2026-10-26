import type { BusinessHours } from '@esrs/shared';

/** Display default; overridden by the window advertised by `GET /meta` when available. */
export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

/** `in_progress` → `In progress` — labels come from the contract, never a lookup table. */
export function humanize(value: string): string {
  const spaced = value.replaceAll('_', ' ').replaceAll('-', ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** 90 → `1 h 30 min business time`, used by SLA target columns. */
export function formatBusinessMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0 min';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  if (rest === 0) return `${hours} h`;
  return `${hours} h ${rest} min`;
}

/** Whole business days, e.g. 1620 min → `3 business days` (docs/requirements.md §8 wording). */
export function formatBusinessDays(minutes: number, hoursPerDay: number): string {
  const perDay = Math.max(1, hoursPerDay) * 60;
  return `${(minutes / perDay).toFixed(minutes % perDay === 0 ? 0 : 1)} business days`;
}

export function formatInstant(
  value: string | Date | null | undefined,
  timeZone: string = DEFAULT_TIME_ZONE,
): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(date);
}

export function businessWindowLabel(hours: BusinessHours): string {
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const days = [...hours.days].sort((a, b) => a - b).map((day) => dayNames[day - 1] ?? `D${day}`);
  return `${days.join(', ')} ${hours.start}–${hours.end} (${hours.timezone})`;
}
