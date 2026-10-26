-- 005: users (docs/database-design.md §2.1)
-- `email` is normalized to lower case in the application (`normalizeEmail`); the functional unique
-- index makes that rule enforceable in the database too. `citext` was considered and rejected.

-- Up Migration
CREATE TABLE users (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email                 TEXT UNIQUE NOT NULL,
  password_hash         TEXT NOT NULL,                 -- bcrypt cost 12, never logged
  full_name             TEXT NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 120),
  role                  user_role NOT NULL DEFAULT 'employee',
  department_id         BIGINT REFERENCES departments (id),
  team_category_id      BIGINT REFERENCES categories (id),  -- agent/manager scoping (ST-301)
  is_active             BOOLEAN NOT NULL DEFAULT true,
  must_change_password  BOOLEAN NOT NULL DEFAULT false,     -- ST-104 first login
  failed_login_count    INT NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,                        -- ST-103
  last_login_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT no_negative_failed_logins CHECK (failed_login_count >= 0)
);

CREATE UNIQUE INDEX uq_users_email_lower ON users (LOWER(email));
CREATE INDEX idx_users_team ON users (team_category_id) WHERE role IN ('agent', 'manager');
CREATE INDEX idx_users_active ON users (is_active);

-- Down Migration
DROP TABLE IF EXISTS users CASCADE;
