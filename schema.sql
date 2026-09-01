-- Run once against the D1 database:
--   npx wrangler d1 execute pavani-judgments --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS judgments (
  chunk_id TEXT NOT NULL,
  verdict  TEXT NOT NULL,
  reviewer TEXT,
  instagram_id TEXT,
  ts       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_judgments_chunk ON judgments(chunk_id);
