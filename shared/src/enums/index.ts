import { z } from 'zod';

/**
 * Authoritative enumerations for ESRS.
 * These values MUST stay identical to the PostgreSQL `CREATE TYPE ... AS ENUM` values
 * (database/migrations/002_enums.sql). Drift is caught by a contract test (docs/test-plan.md §4 C-02).
 */

export const USER_ROLES = ['employee', 'agent', 'manager', 'admin'] as const;
export const userRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof userRoleSchema>;

export const REQUEST_STATUSES = [
  'draft',
  'submitted',
  'assigned',
  'in_progress',
  'on_hold',
  'resolved',
  'closed',
  'cancelled',
] as const;
export const requestStatusSchema = z.enum(REQUEST_STATUSES);
export type RequestStatus = z.infer<typeof requestStatusSchema>;

export const REQUEST_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export const requestPrioritySchema = z.enum(REQUEST_PRIORITIES);
export type RequestPriority = z.infer<typeof requestPrioritySchema>;

export const COMMENT_VISIBILITIES = ['public', 'internal'] as const;
export const commentVisibilitySchema = z.enum(COMMENT_VISIBILITIES);
export type CommentVisibility = z.infer<typeof commentVisibilitySchema>;

export const REQUEST_EVENT_TYPES = [
  'created',
  'submitted',
  'assigned',
  'claimed',
  'unassigned',
  'reassigned',
  'started',
  'placed_on_hold',
  'resumed',
  'resolved',
  'reopened',
  'closed',
  'cancelled',
  'priority_changed',
  'comment_added',
  'attachment_added',
] as const;
export const requestEventTypeSchema = z.enum(REQUEST_EVENT_TYPES);
export type RequestEventType = z.infer<typeof requestEventTypeSchema>;

export const NOTIFICATION_TYPES = [
  'request_status_changed',
  'request_assigned',
  'request_commented',
  'request_reopened',
  'sla_warning',
  'sla_breach',
  'auto_close_warning',
  'auto_closed',
] as const;
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

/** Derived SLA urgency used by queues and badges (never stored — computed from a tracker). */
export const SLA_STATES = ['safe', 'warning', 'breached'] as const;
export const slaStateSchema = z.enum(SLA_STATES);
export type SlaState = z.infer<typeof slaStateSchema>;

/** Statuses that no longer consume SLA time or appear in open queues. */
export const TERMINAL_STATUSES: readonly RequestStatus[] = ['closed', 'cancelled'];

export function isTerminalStatus(status: RequestStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
