-- 011: attachments and request_attachments (docs/database-design.md §2.9)
-- Files are uploaded to a staging row (`status = 'pending'`) and bound to a request when the
-- request is created; a nightly job purges staging rows older than draft_expiry_days.

-- Up Migration
CREATE TABLE attachments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by  BIGINT NOT NULL REFERENCES users (id),
  file_name    TEXT NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  stored_path  TEXT UNIQUE NOT NULL,          -- server-side name; the original is never trusted
  size_bytes   BIGINT NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),  -- 10 MB cap (NFR-6)
  mime_type    TEXT NOT NULL,
  magic_type   TEXT,                          -- type detected from the file header (edge §16.9)
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'bound', 'purged')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_attachments_staging ON attachments (status, created_at) WHERE status = 'pending';

CREATE TABLE request_attachments (
  request_id     BIGINT NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  attachment_id  UUID NOT NULL UNIQUE REFERENCES attachments (id),
  added_by       BIGINT NOT NULL REFERENCES users (id),
  added_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, attachment_id)
);

-- Down Migration
DROP TABLE IF EXISTS request_attachments CASCADE;
DROP TABLE IF EXISTS attachments CASCADE;
