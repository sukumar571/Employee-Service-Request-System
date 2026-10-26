-- 007: requests — the aggregate root (docs/database-design.md §2.3)
-- Only cheap CHECKs and FKs live here; the lifecycle itself is enforced by the application state
-- machine (backend/src/domain/request/stateMachine.ts) so it stays testable without a database.

-- Up Migration
CREATE TABLE requests (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_number     TEXT UNIQUE,                     -- 'REQ-2026-000123', assigned on submit (§5)
  requester_id       BIGINT NOT NULL REFERENCES users (id),
  assignee_id        BIGINT REFERENCES users (id),
  category_id        BIGINT NOT NULL REFERENCES categories (id),
  sub_category_id    BIGINT REFERENCES sub_categories (id),
  department_id      BIGINT REFERENCES departments (id),   -- snapshot of requester's department
  title              TEXT NOT NULL CHECK (char_length(title) BETWEEN 5 AND 140),
  description        TEXT NOT NULL CHECK (char_length(description) >= 20),
  status             request_status NOT NULL DEFAULT 'draft',
  priority           request_priority NOT NULL DEFAULT 'medium',
  status_reason      TEXT,                            -- reason for the latest transition (BR-5)
  resolution_note    TEXT,                            -- required on resolve (ST-303)
  submitted_at       TIMESTAMPTZ,                     -- SLA clock start; NULL while draft
  resolved_at        TIMESTAMPTZ,
  closed_at          TIMESTAMPTZ,
  cancelled_at       TIMESTAMPTZ,
  reopen_count       INT NOT NULL DEFAULT 0,
  reopened_from      BIGINT REFERENCES requests (id), -- self link when a request is reopened
  requester_inactive BOOLEAN NOT NULL DEFAULT false,  -- edge case §16.1
  version            INT NOT NULL DEFAULT 0,          -- optimistic concurrency (If-Match)
  -- Full-text search column; generated so it can never disagree with title/description.
  search_text        tsvector GENERATED ALWAYS AS (
                      to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, ''))
                     ) STORED,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT valid_dates CHECK (resolved_at <= closed_at),   -- NULLs pass
  CONSTRAINT no_negative_reopens CHECK (reopen_count >= 0),
  CONSTRAINT no_self_reopen CHECK (reopened_from IS NULL OR reopened_from <> id),
  CONSTRAINT number_or_draft CHECK (status = 'draft' OR request_number IS NOT NULL)
);

-- Hot queue: everything an agent or manager can work on right now.
CREATE INDEX idx_requests_queue ON requests (category_id, status, priority)
  WHERE status NOT IN ('draft', 'closed', 'cancelled');
CREATE INDEX idx_requests_requester ON requests (requester_id) WHERE status <> 'draft';
CREATE INDEX idx_requests_assignee ON requests (assignee_id)
  WHERE status IN ('assigned', 'in_progress', 'on_hold');
CREATE INDEX idx_requests_due ON requests (resolved_at DESC);
CREATE INDEX idx_requests_search ON requests USING gin (search_text);

-- Down Migration
DROP TABLE IF EXISTS requests CASCADE;
