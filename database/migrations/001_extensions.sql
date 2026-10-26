-- 001: extensions
-- pgcrypto  -> gen_random_uuid() for attachment/refresh-token identifiers
-- pg_trgm   -> fuzzy title search (docs/database-design.md §6)

-- Up Migration
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Down Migration
DROP EXTENSION IF EXISTS pg_trgm CASCADE;
DROP EXTENSION IF EXISTS pgcrypto CASCADE;
