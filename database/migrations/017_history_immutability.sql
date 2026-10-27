-- 017: audit and activity history immutability (docs/security-plan.md §7, docs/database-design.md §2.7, §2.12)
--
-- `audit_logs` and `request_events` are evidence, not application state: once written, a row must not
-- be editable and must not be quietly removable. The requirement is "prevent ordinary application
-- users from editing or deleting historical audit entries", and this schema enforces it on three
-- levels, strongest first:
--
--   1. **Column privileges** (the real guarantee in production): the application connects as a
--      dedicated role that is granted INSERT/SELECT on the history tables and nothing more. PostgreSQL
--      then refuses UPDATE/DELETE/TRUNCATE before any PL/pgSQL runs, and the refusal cannot be switched
--      off from inside the session. Applied only when the role exists — see the honest limitation below.
--   2. **Row triggers** (defence in depth): a BEFORE trigger raises SQLSTATE 42501 on UPDATE/DELETE.
--      This protects the rows even when the connecting role technically holds the table privileges,
--      which is exactly the case in this project's single-owner development database (`esrs` owns the
--      schema, so level 1 has nothing to revoke from it).
--   3. **Provenance triggers on `comments`**: a comment's *text* may legitimately be corrected later
--      (the API does not offer that endpoint today), but its author and creation instant are part of
--      the record and are frozen here — "preserve the author and timestamp" is a database rule, not a
--      convention the API happens to follow.
--
-- The triggers honour one documented escape hatch: `SET LOCAL esrs.allow_history_mutation = 'on'`
-- inside a maintenance transaction. That is a deliberate operator affordance (retention purge, GDPR
-- erasure), not a hole the application can reach: no application code path issues SET, the setting is
-- transaction-scoped, and PostgreSQL cannot cascade a foreign key without the parent delete running
-- in the same transaction — which is why `DELETE FROM requests …` (ON DELETE CASCADE into
-- `request_events`) also needs the flag. `app_settings` history retention and audit archival therefore
-- remain explicit, auditable maintenance jobs.

-- Up Migration

-- Level 2 and 3: the guard functions ------------------------------------------------------------
CREATE FUNCTION forbid_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('esrs.allow_history_mutation', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Table "%" is append-only: UPDATE is forbidden', TG_TABLE_NAME
      USING ERRCODE = '42501',
            HINT    = 'Insert a correcting row instead of rewriting history.';
  END IF;

  RAISE EXCEPTION 'Table "%" is append-only: DELETE is forbidden', TG_TABLE_NAME
    USING ERRCODE = '42501',
          HINT    = 'Set esrs.allow_history_mutation = ''on'' (SET LOCAL) inside a maintenance transaction.';
END;
$$;

CREATE FUNCTION preserve_comment_provenance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('esrs.allow_history_mutation', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.author_id IS DISTINCT FROM OLD.author_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.is_post_closure IS DISTINCT FROM OLD.is_post_closure THEN
    RAISE EXCEPTION 'A comment''s identity, author, timestamp and BR-8 flag are immutable'
      USING ERRCODE = '42501',
            HINT    = 'Only body and visibility may change, and only through a reviewed maintenance job.';
  END IF;

  RETURN NEW;
END;
$$;

-- One trigger per history table, named so it fires before `set_updated_at()` on `comments`
-- (PostgreSQL orders same-kind triggers alphabetically), which keeps that trigger's work untouched.
CREATE TRIGGER trg_audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_history_mutation();

CREATE TRIGGER trg_request_events_append_only
  BEFORE UPDATE OR DELETE ON request_events
  FOR EACH ROW EXECUTE FUNCTION forbid_history_mutation();

CREATE TRIGGER trg_comments_provenance
  BEFORE UPDATE ON comments
  FOR EACH ROW EXECUTE FUNCTION preserve_comment_provenance();

-- Level 1: least privilege, when the deployment defines a separate application role. The role name is
-- a convention (docs/security-plan.md §8), so this block is a no-op on a single-owner database rather
-- than a failure — and `database/README.md` records that development therefore relies on level 2 only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'esrs_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs, request_events FROM esrs_app;
    GRANT  SELECT, INSERT            ON audit_logs, request_events TO esrs_app;
    -- A comment's body is the one history column the API may eventually correct, but the author and
    -- timestamp are guarded by the trigger above; the application role still gets no DELETE at all.
    REVOKE DELETE ON comments FROM esrs_app;
  END IF;
END;
$$;

-- The timeline reads one request's merged feed ordered by instant; the two existing
-- (request_id, created_at) indexes already serve it, so no new index is introduced here.

-- Down Migration
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'esrs_app') THEN
    GRANT ALL ON audit_logs, request_events, comments TO esrs_app;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_comments_provenance           ON comments;
DROP TRIGGER IF EXISTS trg_request_events_append_only    ON request_events;
DROP TRIGGER IF EXISTS trg_audit_logs_append_only        ON audit_logs;
DROP FUNCTION IF EXISTS preserve_comment_provenance();
DROP FUNCTION IF EXISTS forbid_history_mutation();
