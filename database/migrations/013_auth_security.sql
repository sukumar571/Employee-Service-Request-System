-- 013: refresh-token rotation and login attempts (docs/database-design.md §2.11, ST-103)
-- Only the SHA-256 hash of a refresh token is stored, never the raw value; `family_id` is the
-- rotation chain, so reusing an already-rotated token revokes the whole family (docs/security-plan.md §4).

-- Up Migration
CREATE TABLE refresh_tokens (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id          UUID NOT NULL,
  token_hash         TEXT NOT NULL,               -- sha256(raw token), hex
  parent_token_hash  TEXT,                        -- rotation lineage
  replaced_by        TEXT,                        -- hash of the token that rotated this one
  revoked_reason     TEXT CHECK (revoked_reason IN
                        ('rotated', 'reuse_detected', 'logged_out', 'admin_revoked', 'expired')),
  expires_at         TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_refresh_token UNIQUE (family_id, token_hash)
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id) WHERE revoked_reason IS NULL;
CREATE INDEX idx_refresh_tokens_expiry ON refresh_tokens (expires_at);

CREATE TABLE login_attempts (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_lf      TEXT NOT NULL,                    -- lower-case email used for lockout counting
  ip            INET,                             -- raw IP is redacted in logs (NFR-7)
  success       BOOLEAN NOT NULL,
  attempted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_login_attempts_recent ON login_attempts (email_lf, attempted_at DESC);

-- Down Migration
DROP TABLE IF EXISTS login_attempts CASCADE;
DROP TABLE IF EXISTS refresh_tokens CASCADE;
