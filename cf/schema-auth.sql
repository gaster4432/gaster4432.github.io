-- ==========================================
-- PKAX auth schema — apply to the AUTH_DB database
--   npx wrangler d1 execute cf-chat-auth --remote --file=cf/schema-auth.sql
-- ==========================================

-- One row per account. The 64-char session id lives on the user row,
-- so an account has exactly one active session at a time.
CREATE TABLE IF NOT EXISTS users (
  id                 TEXT PRIMARY KEY,
  username           TEXT NOT NULL,
  username_lc        TEXT NOT NULL UNIQUE,
  -- SHA-256 of the client-derived verifier. The browser does the expensive
  -- PBKDF2 stretch; the Worker only ever runs one cheap hash.
  verifier_hash      TEXT NOT NULL,
  session_id         TEXT UNIQUE,
  session_expires_at TEXT,
  -- Profile picture. Either an https URL or a downscaled data:image URI.
  -- Empty means the client renders a generated identicon from the username.
  avatar             TEXT NOT NULL DEFAULT '',
  persona            TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at      TEXT
);

-- UNIQUE(session_id) already provides an index; this keeps the lookup
-- path explicit if the column is ever dropped from the unique constraint.
CREATE INDEX IF NOT EXISTS idx_users_session ON users(session_id);

-- Fixed-window counters. KV is unusable here because it caps writes at
-- 1/sec/key, which would break a strict counter.
CREATE TABLE IF NOT EXISTS rate_limits (
  rkey         TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);