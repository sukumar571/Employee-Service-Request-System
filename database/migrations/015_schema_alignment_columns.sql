-- 015: schema-alignment columns + updated_at triggers
-- Closes the gaps between the spec checklist and migrations 001-014 without renaming anything the
-- backend repositories read (see the *_mins note in 010 and the named-column parity test):
--   * categories: `description` and a default resolution target, so the taxonomy row carries the
--     "default SLA configuration" the spec requires. The authoritative SLA clock still runs on the
--     priority-based sla_policies + sla_trackers (docs/database-design.md §2.8).
--   * audit_logs: the TEXT `request_id` column is the HTTP correlation id, which collides with the
--     spec's "request_id where applicable" (a reference to the audited service request). Renaming
--     the correlation column to `http_request_id` frees `request_id` for the FK. The reference is
--     SET NULL, not CASCADE: an audit trail must outlive the entity it describes.
--   * updated_at: one shared trigger keeps the column honest on every UPDATE; the application
--     repositories also set it explicitly, which stays compatible (the trigger overwrites with the
--     same server-side clock, so the value can never disagree with the row's own transactions).

-- Up Migration
ALTER TABLE categories
  ADD COLUMN description TEXT,
  ADD COLUMN default_resolution_hours INT CHECK (default_resolution_hours > 0);

ALTER TABLE audit_logs RENAME COLUMN request_id TO http_request_id;
ALTER TABLE audit_logs
  ADD COLUMN request_id BIGINT REFERENCES requests (id) ON DELETE SET NULL;

DROP INDEX IF EXISTS idx_audit_request;
CREATE INDEX idx_audit_http_request ON audit_logs (http_request_id) WHERE http_request_id IS NOT NULL;
CREATE INDEX idx_audit_service_request ON audit_logs (request_id) WHERE request_id IS NOT NULL;

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_users_updated_at         BEFORE UPDATE ON users         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_departments_updated_at   BEFORE UPDATE ON departments   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_categories_updated_at    BEFORE UPDATE ON categories    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_sub_categories_updated_at BEFORE UPDATE ON sub_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_requests_updated_at      BEFORE UPDATE ON requests      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_comments_updated_at      BEFORE UPDATE ON comments      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_sla_policies_updated_at  BEFORE UPDATE ON sla_policies  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_sla_trackers_updated_at  BEFORE UPDATE ON sla_trackers  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
DROP TRIGGER IF EXISTS trg_sla_trackers_updated_at  ON sla_trackers;
DROP TRIGGER IF EXISTS trg_sla_policies_updated_at  ON sla_policies;
DROP TRIGGER IF EXISTS trg_comments_updated_at      ON comments;
DROP TRIGGER IF EXISTS trg_requests_updated_at      ON requests;
DROP TRIGGER IF EXISTS trg_sub_categories_updated_at ON sub_categories;
DROP TRIGGER IF EXISTS trg_categories_updated_at    ON categories;
DROP TRIGGER IF EXISTS trg_departments_updated_at   ON departments;
DROP TRIGGER IF EXISTS trg_users_updated_at         ON users;
DROP FUNCTION IF EXISTS set_updated_at() CASCADE;

DROP INDEX IF EXISTS idx_audit_service_request;
ALTER TABLE audit_logs DROP COLUMN IF EXISTS request_id;
ALTER TABLE audit_logs RENAME COLUMN http_request_id TO request_id;
CREATE INDEX idx_audit_request ON audit_logs (request_id) WHERE request_id IS NOT NULL;

ALTER TABLE categories
  DROP COLUMN IF EXISTS default_resolution_hours,
  DROP COLUMN IF EXISTS description;
