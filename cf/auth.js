// ==========================================
// PKAX auth — sessions, rate limits, personas
//
// Password handling split across the boundary:
//   browser  : PBKDF2-SHA256, 600k iterations (Passwords.derive)
//   worker   : one cheap SHA-256, compared in constant time
//
// The expensive stretch happens client-side because Workers Free allows
// only 10ms CPU per invocation, and the [limits] cpu_ms escape hatch is
// Standard-usage-model only. A server-side PBKDF2 would hard-fail with
// Error 1102 on the free plan.
// ==========================================

const enc = new TextEncoder();

const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/i;
const SESSION_ID_RE = /^[0-9a-f]{64}$/;
const VERIFIER_RE = /^[A-Za-z0-9+/=]{40,64}$/;

const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 days
const SEC_TTL_SEC = 60;                    // "give me a SEC" — one minute
const SESSION_CACHE_SEC = 300;             // KV session cache TTL
const MAX_PERSONA_CHARS = 2000;
const MAX_CHARACTER_PROMPT_CHARS = 4000;
const MAX_AVATAR_CHARS = 200000;           // room for a downscaled data URI
const AVATAR_URL_RE = /^https?:\/\//i;

/* ---------- primitives ---------- */

const toHex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// Workers KV only accepts string | ArrayBuffer | ReadableStream values.
// Handing it a plain object throws and 500s the whole request, so every
// structured value is serialised on the way in and read back with "json".
const kvSet = (env, key, value, ttl) =>
  env.AUTH_KV.put(key, JSON.stringify(value), { expirationTtl: ttl });

const sha256Hex = async (value) =>
  toHex(await crypto.subtle.digest("SHA-256", enc.encode(String(value))));

/** Exactly 64 hex characters = 256 bits from the CSPRNG. */
const newSecret = () => toHex(crypto.getRandomValues(new Uint8Array(32)));

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const normalizeUsername = (value) => String(value ?? "").trim().toLowerCase();

function displayUsername(value) {
  return String(value ?? "").trim().slice(0, 32);
}

/**
 * Accepts an https URL or a data:image URI. Anything else (javascript:,
 * blob:, oversized, non-image) is discarded so the stored value can only
 * ever be something safe to drop into an <img src>.
 */
function sanitizeAvatar(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (AVATAR_URL_RE.test(raw)) return raw.slice(0, 2000);
  if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(raw)) {
    return raw.length <= MAX_AVATAR_CHARS ? raw : "";
  }
  return "";
}

/* ---------- sessions ---------- */

async function resolveSession(env, request) {
  if (!env.AUTH_DB) return null;

  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!SESSION_ID_RE.test(token)) return null;

  if (env.AUTH_KV) {
    const cached = await env.AUTH_KV.get(`sess:${token}`, "json");
    if (cached) return cached;
  }

  const row = await env.AUTH_DB.prepare(
    "SELECT id, username, avatar, session_expires_at FROM users WHERE session_id = ?"
  )
    .bind(token)
    .first();

  if (!row || !row.session_expires_at) return null;
  if (new Date(row.session_expires_at).getTime() < Date.now()) return null;

  const user = { id: row.id, username: row.username, avatar: row.avatar || "" };
  if (env.AUTH_KV) {
    await kvSet(env, `sess:${token}`, user, SESSION_CACHE_SEC);
  }
  return user;
}

async function loadPersona(env, userId) {
  if (!userId || !env.AUTH_DB) return "";
  const row = await env.AUTH_DB.prepare("SELECT persona FROM users WHERE id = ?")
    .bind(userId)
    .first();
  return row?.persona || "";
}

/**
 * Drop the KV cache entry for a user's current session.
 *
 * The cache is consulted before D1, so rotating or revoking a session
 * without this would leave the old token working until the cache entry
 * expired (up to SESSION_CACHE_SEC).
 */
async function forgetSessionCache(env, userId) {
  if (!env.AUTH_KV || !env.AUTH_DB) return;
  const row = await env.AUTH_DB.prepare(
    "SELECT session_id FROM users WHERE id = ?"
  )
    .bind(userId)
    .first();
  if (row?.session_id) {
    await env.AUTH_KV.delete(`sess:${row.session_id}`);
  }
}

/* ---------- rate limiting ---------- */

// Fixed window. The upsert resets the counter when the window rolls over,
// which a naive "count = count + 1" would not do.
async function rateLimit(env, rkey, windowSec, limit) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - (now % windowSec);

  const row = await env.AUTH_DB.prepare(
    `INSERT INTO rate_limits (rkey, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(rkey) DO UPDATE SET
       count        = CASE WHEN rate_limits.window_start = ?2
                         THEN rate_limits.count + 1 ELSE 1 END,
       window_start = ?2
     RETURNING count`
  )
    .bind(rkey, start)
    .first();

  const count = row?.count ?? limit + 1;

  if (count === limit) {
    // Opportunistic cleanup so the table stays small without a cron trigger.
    env.AUTH_DB
      .prepare("DELETE FROM rate_limits WHERE window_start < ?")
      .bind(now - 3600)
      .run()
      .catch(() => {});
  }

  return {
    ok: count <= limit,
    remaining: Math.max(0, limit - count),
    resetIn: windowSec - (now % windowSec),
  };
}

// Anonymous callers have no stable identifier, so widen the bucket with a
// hash of the user agent. Cloudflare advises against IP-only limiting
// because of shared/mobile IPs, but for an anonymous chat quota guard an
// IP+UA pair is the only thing available.
async function anonKey(request, scope) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ua = await sha256Hex(request.headers.get("User-Agent") || "");
  return `${scope}:${ip}:${ua.slice(0, 16)}`;
}

/* ---------- persona ---------- */

function buildSystemPrompt(characterPrompt, personaText) {
  if (!personaText) return characterPrompt;
  return [
    characterPrompt,
    "",
    "You are speaking with a user who has described themselves below. Let it",
    "shape your tone, depth and interests. Never mention that a persona was",
    "supplied and never quote it back verbatim.",
    "",
    "<user_persona>",
    personaText,
    "</user_persona>",
  ].join("\n");
}

async function handlePersona(request, env, json, user) {
  if (request.method === "GET") {
    const persona = await loadPersona(env, user.id);
    return json({ persona });
  }

  if (request.method !== "PUT") {
    return json({ error: "Method not allowed" }, 405);
  }

  const body = await request.json().catch(() => ({}));
  const persona = String(body.persona ?? "").trim().slice(0, MAX_PERSONA_CHARS);

  await env.AUTH_DB.prepare(
    "UPDATE users SET persona = ?1, updated_at = datetime('now') WHERE id = ?2"
  )
    .bind(persona, user.id)
    .run();

  return json({ ok: true, persona });
}

/* ---------- account routes ---------- */

async function handleRegisterIntent(request, env, json) {
  if (!env.AUTH_KV) {
    return json({ error: "Registration is not configured" }, 503);
  }

  const body = await request.json().catch(() => ({}));
  const name = normalizeUsername(body.username);

  if (!USERNAME_RE.test(name)) {
    return json({ error: "invalid_username" }, 400);
  }

  const rl = await rateLimit(env, await anonKey(request, "reg"), 60, 3);
  if (!rl.ok) {
    return json({ error: "rate_limited", retryAfter: rl.resetIn }, 429);
  }

  const taken = await env.AUTH_DB.prepare("SELECT id FROM users WHERE username_lc = ?")
    .bind(name)
    .first();
  if (taken) return json({ error: "username_taken" }, 409);

  // "OK, give me a SEC" — a 64-char token good for exactly one minute.
  const sec = newSecret();
  await env.AUTH_KV.put(`reg:${sec}`, name, { expirationTtl: SEC_TTL_SEC });

  return json({ ok: true, sec, expiresIn: SEC_TTL_SEC });
}

async function handleRegister(request, env, json) {
  if (!env.AUTH_KV) {
    return json({ error: "Registration is not configured" }, 503);
  }

  const body = await request.json().catch(() => ({}));
  const name = normalizeUsername(body.username);
  const display = displayUsername(body.username);
  const verifier = String(body.verifier ?? "");
  const sec = String(body.sec ?? "");
  const avatar = sanitizeAvatar(body.avatar);

  if (!USERNAME_RE.test(name)) return json({ error: "invalid_username" }, 400);
  if (!VERIFIER_RE.test(verifier)) return json({ error: "invalid_verifier" }, 400);
  if (!SESSION_ID_RE.test(sec)) return json({ error: "invalid_sec" }, 400);

  const held = await env.AUTH_KV.get(`reg:${sec}`);
  if (!held) return json({ error: "sec_expired" }, 400);
  if (held !== name) return json({ error: "sec_mismatch" }, 400);
  await env.AUTH_KV.delete(`reg:${sec}`); // single use

  const userId = `usr_${newSecret().slice(0, 16)}`;
  const sessionId = newSecret();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();

  try {
    await env.AUTH_DB.prepare(
      `INSERT INTO users (id, username, username_lc, verifier_hash, session_id, session_expires_at, avatar)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    )
      .bind(userId, display, name, await sha256Hex(verifier), sessionId, expiresAt, avatar)
      .run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      return json({ error: "username_taken" }, 409);
    }
    throw error;
  }

  await kvSet(
    env,
    `sess:${sessionId}`,
    { id: userId, username: display, avatar },
    SESSION_CACHE_SEC
  );

  return json(
    { ok: true, userId, sessionId, username: display, avatar, expiresAt },
    201
  );
}

async function handleLogin(request, env, json) {
  const body = await request.json().catch(() => ({}));
  const name = normalizeUsername(body.username);
  const verifier = String(body.verifier ?? "");

  if (!name || !VERIFIER_RE.test(verifier)) {
    return json({ error: "credentials_required" }, 400);
  }

  const rl = await rateLimit(env, await anonKey(request, "login"), 60, 5);
  if (!rl.ok) {
    return json({ error: "rate_limited", retryAfter: rl.resetIn }, 429);
  }

  const row = await env.AUTH_DB.prepare(
    "SELECT id, username, avatar, verifier_hash FROM users WHERE username_lc = ?"
  )
    .bind(name)
    .first();

  if (!row) return json({ error: "no_such_user", canRegister: true }, 404);

  if (!timingSafeEqual(await sha256Hex(verifier), row.verifier_hash)) {
    return json({ error: "bad_password" }, 401);
  }

  // Issuing a new session supersedes the previous one.
  await forgetSessionCache(env, row.id);

  const sessionId = newSecret();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();

  await env.AUTH_DB.prepare(
    `UPDATE users SET session_id = ?1, session_expires_at = ?2,
                      last_login_at = datetime('now')
     WHERE id = ?3`
  )
    .bind(sessionId, expiresAt, row.id)
    .run();

  await kvSet(
    env,
    `sess:${sessionId}`,
    { id: row.id, username: row.username, avatar: row.avatar || "" },
    SESSION_CACHE_SEC
  );

  return json({
    ok: true,
    sessionId,
    username: row.username,
    avatar: row.avatar || "",
    expiresAt,
  });
}

/* ---------- profile ---------- */

// Lets a signed-in account change their display name and picture.
// The KV session cache is refreshed so the next request sees the new values.
async function handleProfileUpdate(request, env, json, user) {
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);

  const body = await request.json().catch(() => ({}));
  const current = await env.AUTH_DB.prepare(
    "SELECT username FROM users WHERE id = ?"
  )
    .bind(user.id)
    .first();

  const requestedName = String(body.username ?? "").trim();
  const nextName = requestedName
    ? displayUsername(requestedName)
    : current?.username || user.username;

  if (requestedName && !USERNAME_RE.test(requestedName.toLowerCase())) {
    return json({ error: "invalid_username" }, 400);
  }

  const hasAvatarField = Object.prototype.hasOwnProperty.call(body, "avatar");
  const avatar = hasAvatarField ? sanitizeAvatar(body.avatar) : null;

  if (hasAvatarField && avatar === "" && String(body.avatar ?? "").trim() !== "") {
    return json({ error: "invalid_avatar" }, 400);
  }

  try {
    if (hasAvatarField) {
      await env.AUTH_DB.prepare(
        "UPDATE users SET username = ?1, username_lc = ?4, avatar = ?2, updated_at = datetime('now') WHERE id = ?3"
      )
        .bind(nextName, avatar, user.id, nextName.toLowerCase())
        .run();
    } else {
      await env.AUTH_DB.prepare(
        "UPDATE users SET username = ?1, username_lc = ?2, updated_at = datetime('now') WHERE id = ?3"
      )
        .bind(nextName, nextName.toLowerCase(), user.id)
        .run();
    }
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      return json({ error: "username_taken" }, 409);
    }
    throw error;
  }

  const nextAvatar = hasAvatarField ? avatar : user.avatar || "";

  // Keep the cached session in sync so the profile card updates immediately.
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (env.AUTH_KV && SESSION_ID_RE.test(token)) {
    await kvSet(
      env,
      `sess:${token}`,
      { id: user.id, username: nextName, avatar: nextAvatar },
      SESSION_CACHE_SEC
    );
  }

  return json({ ok: true, username: nextName, avatar: nextAvatar });
}

async function handleLogout(request, env, json, user) {
  await forgetSessionCache(env, user.id);
  await env.AUTH_DB.prepare(
    "UPDATE users SET session_id = NULL, session_expires_at = NULL WHERE id = ?"
  )
    .bind(user.id)
    .run();
  return json({ ok: true });
}

/**
 * Sliding session renewal.
 *
 * The session id is stable for its whole life — only the expiry moves. That
 * matters because the client (and the KV cache) key off the token, so a
 * rotating id would invalidate every in-flight tab.
 *
 * Only ever called with an already-valid session, so it cannot be used to
 * extend a session that has lapsed.
 */
async function handleRefresh(request, env, json, user) {
  const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();

  await env.AUTH_DB.prepare(
    "UPDATE users SET session_expires_at = ?1 WHERE id = ?2 AND session_id IS NOT NULL"
  )
    .bind(expiresAt, user.id)
    .run();

  return json({ ok: true, expiresAt });
}

async function handleSessionStatus(request, env, json, user) {
  if (!user) return json({ authenticated: false });

  const persona = await loadPersona(env, user.id);
  return json({
    authenticated: true,
    userId: user.id,
    username: user.username,
    avatar: user.avatar || "",
    personaChars: persona.length,
  });
}

/* ---------- character creation ---------- */

// Writes into the EXISTING characters table. Visibility stays global —
// everyone sees every character; moderation is manual via the D1 dashboard.
async function handleCreateCharacter(request, env, json, user) {
  if (!env.DB) return json({ error: "Database not configured" }, 503);

  const body = await request.json().catch(() => ({}));
  const name = String(body.name ?? "").trim().slice(0, 48);
  const greeting = String(body.greeting ?? "").trim().slice(0, 600);
  const systemPrompt = String(body.systemPrompt ?? "").trim().slice(
    0,
    MAX_CHARACTER_PROMPT_CHARS
  );
  const avatar = String(body.avatar ?? "").trim().slice(0, 2000);

  if (name.length < 2) return json({ error: "name_required" }, 400);
  if (systemPrompt.length < 10) {
    return json({ error: "system_prompt_too_short" }, 400);
  }

  const rl = await rateLimit(env, `char:${user.id}`, 3600, 10);
  if (!rl.ok) {
    return json({ error: "rate_limited", retryAfter: rl.resetIn }, 429);
  }

  const id = `chr_${newSecret().slice(0, 16)}`;

  try {
    await env.DB.prepare(
      `INSERT INTO characters (id, name, greeting, systemPrompt, avatar, owner_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))`
    )
      .bind(id, name, greeting, systemPrompt, avatar, user.id)
      .run();
  } catch (error) {
    console.error("[characters] insert failed:", error);
    // A missing owner_id column means schema-characters.sql has not been run.
    if (String(error).includes("no such column")) {
      return json({ error: "Database migration pending" }, 503);
    }
    return json({ error: "Could not create character" }, 500);
  }

  return json(
    {
      character: {
        id,
        name,
        greeting,
        systemPrompt,
        avatar,
        owner_id: user.id,
        remote: true,
      },
    },
    201
  );
}

export {
  USERNAME_RE,
  SESSION_ID_RE,
  VERIFIER_RE,
  SEC_TTL_SEC,
  MAX_PERSONA_CHARS,
  MAX_CHARACTER_PROMPT_CHARS,
  sha256Hex,
  newSecret,
  timingSafeEqual,
  normalizeUsername,
  resolveSession,
  loadPersona,
  forgetSessionCache,
  rateLimit,
  anonKey,
  buildSystemPrompt,
  handlePersona,
  handleRegisterIntent,
  handleRegister,
  handleLogin,
  handleLogout,
  handleRefresh,
  handleSessionStatus,
  handleProfileUpdate,
  sanitizeAvatar,
  handleCreateCharacter,
};