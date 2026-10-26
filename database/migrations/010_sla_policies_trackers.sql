-- 010: sla_policies and sla_trackers (docs/database-design.md §2.8, ST-401 … ST-404)
-- Column names use `*_mins`; the REST contract exposes `*_minutes` and the repository maps between
-- them (backend/src/modules/sla/sla.repository.pg.ts).
-- The four default policies mirror DEFAULT_SLA_POLICIES in @esrs/shared; the parity test asserts it.

-- Up Migration
CREATE TABLE sla_policies (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  priority             request_priority UNIQUE NOT NULL,
  first_response_mins  INT NOT NULL CHECK (first_response_mins > 0),
  resolution_mins      INT NOT NULL CHECK (resolution_mins > 0),
  business_hours       JSONB NOT NULL DEFAULT
    '{"days": [1, 2, 3, 4, 5], "start": "09:00", "end": "18:00", "timezone": "Asia/Kolkata"}'::jsonb,
  updated_by           BIGINT REFERENCES users (id),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A request cannot be due for resolution before it is due for a first response.
  CONSTRAINT resolution_after_first_response CHECK (resolution_mins > first_response_mins)
);

INSERT INTO sla_policies (priority, first_response_mins, resolution_mins)
VALUES
  ('critical', 30, 240),
  ('high', 120, 1440),
  ('medium', 240, 1620),
  ('low', 480, 2700)
ON CONFLICT (priority) DO NOTHING;

CREATE TABLE sla_trackers (
  id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id               BIGINT NOT NULL UNIQUE REFERENCES requests (id) ON DELETE CASCADE,
  policy_snapshot          JSONB NOT NULL,   -- outstanding due dates never follow later policy edits
  submitted_at             TIMESTAMPTZ NOT NULL,
  first_response_due_at    TIMESTAMPTZ,
  resolution_due_at        TIMESTAMPTZ,
  first_response_met_at    TIMESTAMPTZ,      -- stamped by the first agent action
  paused_intervals         JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{start,end}] business-time segments
  warned_at                TIMESTAMPTZ,
  breached_at              TIMESTAMPTZ,
  breached                 BOOLEAN NOT NULL DEFAULT false,
  completion_status        TEXT CHECK (completion_status IN ('met', 'breached')),  -- set at resolve
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The hourly sweep only ever looks at requests that can still breach.
CREATE INDEX idx_trackers_open ON sla_trackers (resolution_due_at) WHERE breached IS FALSE;
CREATE INDEX idx_trackers_due ON sla_trackers (resolution_due_at DESC);

-- Down Migration
DROP TABLE IF EXISTS sla_trackers CASCADE;
DROP TABLE IF EXISTS sla_policies CASCADE;
