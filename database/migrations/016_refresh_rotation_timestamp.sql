-- 016: refresh-token rotation timestamp (docs/security-plan.md §3)
-- The refresh reuse-detection grace window (docs/api-specification.md §3 refresh) needs to know the
-- instant a token was rotated out, so an in-flight double-submit seconds later can be re-issued
-- instead of tearing down the whole family. Migration 013 records the lineage (`replaced_by`) but not
-- the moment; this adds the missing column. Nullable: only rotated rows ever set it.

-- Up Migration
ALTER TABLE refresh_tokens ADD COLUMN replaced_at TIMESTAMPTZ;

-- Down Migration
ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS replaced_at;
