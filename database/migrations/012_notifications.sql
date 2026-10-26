-- 012: notifications (docs/database-design.md §2.10)
-- `dedupe_key` carries the event or scheduler-run id so a re-run of the SLA sweep or the
-- auto-close job cannot fan out a second copy of the same alert (edge §16.16).

-- Up Migration
CREATE TABLE notifications (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type        notification_type NOT NULL,
  request_id  BIGINT REFERENCES requests (id) ON DELETE CASCADE,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key  TEXT NOT NULL DEFAULT '',
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_notification_dedupe UNIQUE (user_id, type, request_id, dedupe_key)
);

CREATE INDEX idx_notif_unread ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX idx_notif_request ON notifications (request_id);

-- Down Migration
DROP TABLE IF EXISTS notifications CASCADE;
