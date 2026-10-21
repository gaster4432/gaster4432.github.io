-- ==========================================
-- Suggestion Box schema — apply to the suggestion-box database
--   npx wrangler d1 execute suggestion-box --remote --file=suggestion-box/schema.sql
--
-- This matches the table that is already live, so running it again
-- is a no-op.
-- ==========================================

CREATE TABLE IF NOT EXISTS suggestions (
  id         TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
