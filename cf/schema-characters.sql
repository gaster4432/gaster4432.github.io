-- ==========================================
-- Migration for the EXISTING cf-chat database (characters)
--   npx wrangler d1 execute cf-chat --remote --file=cf/schema-characters.sql
--
-- Run this BEFORE deploying worker code that INSERTs owner_id,
-- otherwise those inserts fail.
--
-- SQLite's ALTER TABLE has no IF NOT EXISTS — run exactly once.
-- ==========================================

-- Provenance only. GET /api/characters still returns every row, so all
-- users see all characters and moderation is done by hand from the
-- Cloudflare D1 dashboard.
ALTER TABLE characters ADD COLUMN owner_id TEXT;

CREATE INDEX IF NOT EXISTS idx_characters_owner ON characters(owner_id);