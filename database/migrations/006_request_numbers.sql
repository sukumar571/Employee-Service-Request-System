-- 006: request_numbers — gapless human-readable ID generator (docs/database-design.md §5)
-- One row per year, incremented inside the submission transaction:
--   INSERT INTO request_numbers (year) VALUES ($1)
--   ON CONFLICT (year) DO UPDATE SET last_seq = request_numbers.last_seq + 1
--   RETURNING last_seq;

-- Up Migration
CREATE TABLE request_numbers (
  year      INT PRIMARY KEY CHECK (year BETWEEN 2000 AND 2999),
  last_seq  BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT no_negative_seq CHECK (last_seq >= 0)
);

-- Down Migration
DROP TABLE IF EXISTS request_numbers CASCADE;
