-- 004: categories and sub_categories (docs/database-design.md §2.2)
-- Created before users because users.team_category_id references categories (ST-301 scoping).

-- Up Migration
CREATE TABLE categories (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,            -- 'IT' | 'HR' | 'FAC'
  name        TEXT NOT NULL,
  team_label  TEXT NOT NULL,                   -- 'IT Support' …
  is_active   BOOLEAN NOT NULL DEFAULT true,   -- ST-501 soft deactivate
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sub_categories (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category_id  BIGINT NOT NULL REFERENCES categories (id),
  name         TEXT NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_sub_category UNIQUE (category_id, name)
);

CREATE INDEX idx_sub_categories_category ON sub_categories (category_id);

-- Down Migration
DROP TABLE IF EXISTS sub_categories CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
