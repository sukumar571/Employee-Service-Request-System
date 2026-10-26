-- 009: comments and request_events (docs/database-design.md §2.6, §2.7)
-- `request_events` is append-only: the API never UPDATEs or DELETEs it, and production hardening
-- revokes those privileges from the application role.

-- Up Migration
CREATE TABLE comments (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id      BIGINT NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  author_id       BIGINT NOT NULL REFERENCES users (id),
  body            TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  visibility      comment_visibility NOT NULL DEFAULT 'public',
  is_post_closure BOOLEAN NOT NULL DEFAULT false,   -- BR-8: comment after closure
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_comments_request ON comments (request_id, created_at);
-- Internal notes are filtered in SQL on every read path, not only in the API layer.
CREATE INDEX idx_comments_request_public ON comments (request_id, created_at) WHERE visibility = 'public';

CREATE TABLE request_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id   BIGINT NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  actor_id     BIGINT REFERENCES users (id),        -- NULL for system/scheduler actions
  actor_role   user_role NOT NULL,                  -- snapshot: the role at the time of the action
  event_type   request_event_type NOT NULL,
  from_status  request_status,
  to_status    request_status,
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_request ON request_events (request_id, created_at);

-- Down Migration
DROP TABLE IF EXISTS request_events CASCADE;
DROP TABLE IF EXISTS comments CASCADE;
