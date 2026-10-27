-- 006: request_numbers — gapless human-readable ID generator (docs/database-design.md §5)
-- One row per year, incremented inside the submission transaction:
--   INSERT INTO request_numbers (year, last_seq) VALUES ($1, 1)
--   ON CONFLICT (year) DO UPDATE SET last_seq = request_numbers.last_seq + 1
--   RETURNING last_seq;
-- The row is seeded with 1 (not the column default 0) so the first ticket of a year is …000001:
-- last_seq records the sequence already handed out.

-- Up Migration
CREATE TABLE request_numbers (
  year      INT PRIMARY KEY CHECK (year BETWEEN 2000 AND 2999),
  last_seq  BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT no_negative_seq CHECK (last_seq >= 0)
);

-- Down Migration
DROP TABLE IF EXISTS request_numbers CASCADE;
