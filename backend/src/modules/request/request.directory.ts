import type { UserRole } from '@esrs/shared';

/**
 * Read-only user directory the request module needs to validate people (assignee eligibility,
 * requester existence, display names).
 *
 * Declared here rather than imported from the auth module because cross-module repository imports
 * are forbidden (eslint `no-restricted-imports`, docs/system-architecture.md §2): the composition
 * root wires the auth adapters into this port, and the request module stays unaware of which
 * adapter it was given. The structural shape matches `UserRepository.findById`, so both the
 * Postgres and in-memory auth adapters satisfy it without an adapter class.
 */
export interface DirectoryUser {
  readonly id: string;
  readonly fullName: string;
  readonly role: UserRole;
  readonly teamCategoryId: string | null;
  readonly departmentId: string | null;
  readonly isActive: boolean;
}

export interface UserDirectory {
  findById(id: string): Promise<DirectoryUser | null>;
}
