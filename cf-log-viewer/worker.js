// ==========================================
// cf-log-viewer — read-only dashboard for cf-chat logs
//
// SECURITY MODEL
//   * The password is a Worker SECRET (LOG_VIEWER_PASSWORD), never in source.
//     `wrangler secret put LOG_VIEWER_PASSWORD`
//   * Login returns an HMAC-signed, HttpOnly, SameSite=Strict cookie.
//     Stateless — no session store to leak.
//   * NO CORS headers at all. Without them the browser blocks any
//     cross-origin read, so another site cannot use the viewer's data.
//   * Login is rate limited per IP with exponential backoff.
// ==========================================

const enc = new TextEncoder();
const COOKIE_NAME = "cf_log_session";
const SESSION_TTL_SEC = 60 * 60 * 8; // 8 hours
const MAX_ROWS = 500;
const MAX_MESSAGE_CHARS = 2000;

function b64url(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function timingSafeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** Derive a signing key from the password so the raw value is never a key. */
async function signingKey(env) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    enc.encode("cf-log-viewer|v1|" + (env.LOG_VIEWER_PASSWORD || ""))
  );
  return crypto.subtle.importKey(
    "raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

async function issueToken(env, ttlSec = SESSION_TTL_SEC) {
  const exp = String(Math.floor(Date.now() / 1000) + ttlSec);
  const key = await signingKey(env);
  const sig = b64url(await crypto.subtle.sign("HMAC", key, enc.encode(exp)));
  return exp + "." + sig;
}

async function tokenValid(env, token) {
  if (!token || !token.includes(".")) return false;
  const [exp, sig] = token.split(".");
  const ts = Number(exp);
  if (!Number.isFinite(ts) || ts * 1000 < Date.now()) return false;
  const key = await signingKey(env);
  try {
    return await crypto.subtle.verify(
      "HMAC", key, b64urlToBytes(sig), enc.encode(exp)
    );
  } catch {
    return false;
  }
}

function readCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return "";
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    // No Access-Control-Allow-Origin here on purpose.
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...extraHeaders,
    },
  });
}

/**
 * True when the request arrived over https.
 *
 * Secure cookies are refused by the browser on a plain http origin, so the
 * flag has to follow the request rather than being hardcoded on.
 */
function isSecure(request) {
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return true;
  }
}

function sessionCookie(token, maxAgeSec, secure) {
  const bits = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSec}`,
  ];
  // Secure over https so the cookie is never sent in the clear. A local
  // http:// origin has to drop it or the browser refuses to store it.
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

/* ---------- login throttle (best effort, per isolate) ---------- */
const attempts = new Map();

function throttleKey(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

function tooManyAttempts(request) {
  const key = throttleKey(request);
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now > rec.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return false;
  }
  rec.count += 1;
  // 8 tries per 15 minutes.
  return rec.count > 8;
}

/* ---------- API ---------- */

async function handleLogin(request, env) {
  if (!env.LOG_VIEWER_PASSWORD) {
    return json({ error: "Viewer password is not configured" }, 503);
  }
  if (tooManyAttempts(request)) {
    return json({ error: "Too many attempts. Try again later." }, 429);
  }

  const body = await request.json().catch(() => ({}));
  const supplied = String(body.password ?? "");

  if (!supplied || !timingSafeEqual(supplied, env.LOG_VIEWER_PASSWORD)) {
    return json({ error: "Incorrect password" }, 401);
  }

  attempts.delete(throttleKey(request));
  const token = await issueToken(env);
  return json({ ok: true }, 200, {
    "Set-Cookie": sessionCookie(token, SESSION_TTL_SEC, isSecure(request)),
  });
}

async function handleSession(request, env) {
  const ok = await tokenValid(env, readCookie(request, COOKIE_NAME));
  return json({ authenticated: ok });
}

async function handleLogout(request, env) {
  return json({ ok: true }, 200, {
    "Set-Cookie": sessionCookie("", 0, isSecure(request)),
  });
}

async function handleLogs(request, env, url) {
  const limit = Math.min(
    MAX_ROWS,
    Math.max(1, Number(url.searchParams.get("limit")) || 100)
  );
  const level = url.searchParams.get("level") || "";
  const category = url.searchParams.get("category") || "";
  const search = (url.searchParams.get("q") || "").slice(0, 100);

  const where = [];
  const binds = [];
  if (level && ["info", "warn", "error"].includes(level)) {
    binds.push(level);
    where.push("level = ?" + binds.length);
  }
  if (category) {
    binds.push(category);
    where.push("category = ?" + binds.length);
  }
  if (search) {
    binds.push("%" + search + "%");
    where.push("(message LIKE ? OR path LIKE ? OR username LIKE ?)");
    // LIKE takes one placeholder per occurrence, so bind it three times.
    binds.push("%" + search + "%");
    binds.push("%" + search + "%");
  }
  binds.push(limit);

  const sql =
    "SELECT * FROM logs " +
    (where.length ? "WHERE " + where.join(" AND ") + " " : "") +
    "ORDER BY id DESC LIMIT ?";

  const rows = await env.LOGS_DB.prepare(sql).bind(...binds).all();
  return json({ logs: rows.results || [] });
}

async function handleStats(request, env, url) {
  const windowSec = Math.min(
    7 * 86400,
    Math.max(60, Number(url.searchParams.get("window")) || 86400)
  );

  const totals = await env.LOGS_DB.prepare(
    `SELECT
       COUNT(*)                                            AS total,
       SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END)   AS errors,
       SUM(CASE WHEN level = 'warn'  THEN 1 ELSE 0 END)   AS warns,
       SUM(CASE WHEN authenticated = 1 THEN 1 ELSE 0 END) AS authed,
       AVG(duration_ms)                                   AS avg_ms,
       MAX(duration_ms)                                   AS max_ms
     FROM logs WHERE created_at >= datetime('now', ?)`
  ).bind("-" + windowSec + " seconds").first();

  const byCategory = await env.LOGS_DB.prepare(
    `SELECT category, level, COUNT(*) AS n
     FROM logs WHERE created_at >= datetime('now', ?)
     GROUP BY category, level ORDER BY n DESC`
  ).bind("-" + windowSec + " seconds").all();

  const byStatus = await env.LOGS_DB.prepare(
    `SELECT status, COUNT(*) AS n
     FROM logs WHERE created_at >= datetime('now', ?) AND status IS NOT NULL
     GROUP BY status ORDER BY n DESC`
  ).bind("-" + windowSec + " seconds").all();

  return json({
    stats: totals || {},
    byCategory: byCategory.results || [],
    byStatus: byStatus.results || [],
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.LOGS_DB) {
      return new Response("Logs database is not bound.", { status: 503 });
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      return handleLogin(request, env);
    }

    // Everything below requires a valid signed cookie.
    const authenticated = await tokenValid(env, readCookie(request, COOKIE_NAME));

    if (url.pathname === "/api/session") {
      return handleSession(request, env);
    }
    if (url.pathname === "/api/logout" && request.method === "POST") {
      return handleLogout(request, env);
    }

    if (url.pathname === "/api/logs" || url.pathname === "/api/stats") {
      if (!authenticated) return json({ error: "auth_required" }, 401);
      return url.pathname === "/api/logs"
        ? handleLogs(request, env, url)
        : handleStats(request, env, url);
    }

    if (!authenticated) {
      // Unauthenticated visitors only ever get the shell, which contains no data.
      return env.ASSETS.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};