-- 002: enumerations
-- These labels are the database half of the contract in `@esrs/shared`
-- (shared/src/enums/index.ts). Drift fails the parity test in database/test/enumParity.test.ts.

-- Up Migration
CREATE TYPE user_role AS ENUM ('employee', 'agent', 'manager', 'admin');

CREATE TYPE request_status AS ENUM
  ('draft', 'submitted', 'assigned', 'in_progress', 'on_hold', 'resolved', 'closed', 'cancelled');

CREATE TYPE request_priority AS ENUM ('low', 'medium', 'high', 'critical');

CREATE TYPE comment_visibility AS ENUM ('public', 'internal');

CREATE TYPE request_event_type AS ENUM
  ('created', 'submitted', 'assigned', 'claimed', 'unassigned', 'reassigned', 'started',
   'placed_on_hold', 'resumed', 'resolved', 'reopened', 'closed', 'cancelled',
   'priority_changed', 'comment_added', 'attachment_added');

CREATE TYPE notification_type AS ENUM
  ('request_status_changed', 'request_assigned', 'request_commented', 'request_reopened',
   'sla_warning', 'sla_breach', 'auto_close_warning', 'auto_closed');

-- Down Migration
DROP TYPE IF EXISTS notification_type CASCADE;
DROP TYPE IF EXISTS request_event_type CASCADE;
DROP TYPE IF EXISTS comment_visibility CASCADE;
DROP TYPE IF EXISTS request_priority CASCADE;
DROP TYPE IF EXISTS request_status CASCADE;
DROP TYPE IF EXISTS user_role CASCADE;
