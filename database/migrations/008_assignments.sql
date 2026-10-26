-- 008: assignments — who held the ticket and when (docs/database-design.md §2.5)

-- Up Migration
CREATE TABLE assignments (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id     BIGINT NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  agent_id       BIGINT NOT NULL REFERENCES users (id),
  assigned_by    BIGINT NOT NULL REFERENCES users (id),
  assigned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  unassigned_at  TIMESTAMPTZ,                       -- NULL means "currently assigned"
  reason         TEXT NOT NULL DEFAULT 'claim'
                 CHECK (reason IN ('claim', 'manager_assign', 'reassign', 'reopened'))
);

CREATE INDEX idx_assignments_request ON assignments (request_id, assigned_at DESC);
CREATE INDEX idx_assignments_open ON assignments (request_id) WHERE unassigned_at IS NULL;
CREATE INDEX idx_assignments_agent ON assignments (agent_id) WHERE unassigned_at IS NULL;

-- Down Migration
DROP TABLE IF EXISTS assignments CASCADE;
