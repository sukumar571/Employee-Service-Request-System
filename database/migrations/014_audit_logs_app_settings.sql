-- 014: audit_logs and app_settings (docs/database-design.md §2.12, §2.13)
-- `audit_logs` records administrative and security changes (who/what/before/after) and is separate
-- from `request_events`, which is user-facing activity history.
-- `request_id` and `actor_role` are written by PostgresAuditSink so an audit row can always be
-- traced back to the API request that produced it.

-- Up Migration
CREATE TABLE audit_logs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id     BIGINT REFERENCES users (id),      -- NULL for anonymous/system actions
  actor_role   user_role,                         -- role snapshot at the time of the action
  actor_ip     INET,
  request_id   TEXT,                              -- x-request-id correlation
  action       TEXT NOT NULL,                     -- 'user.created', 'role.changed', 'sla_policy.updated'
  entity_type  TEXT,
  entity_id    TEXT,
  before       JSONB,
  after        JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_entity ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_actor ON audit_logs (actor_id, created_at DESC);
CREATE INDEX idx_audit_request ON audit_logs (request_id) WHERE request_id IS NOT NULL;

CREATE TABLE app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  BIGINT REFERENCES users (id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- MVP defaults (docs/requirements.md §8). Seeds never overwrite an existing key.
INSERT INTO app_settings (key, value)
VALUES
  ('reopen_days', '7'::jsonb),
  ('auto_close_business_days', '5'::jsonb),
  ('auto_close_warning_days', '3'::jsonb),
  ('draft_expiry_days', '90'::jsonb),
  ('attachment_max_mb', '10'::jsonb),
  ('business_hours',
   '{"days": [1, 2, 3, 4, 5], "start": "09:00", "end": "18:00", "timezone": "Asia/Kolkata"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Down Migration
DROP TABLE IF EXISTS app_settings CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
