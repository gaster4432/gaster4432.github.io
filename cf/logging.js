// ==========================================
// Structured logging for cf-chat -> LOG_DB
//
// Logging must never be able to take down a request it is observing, so
// every write is wrapped and failures are swallowed.
// ==========================================

const LOG_LEVELS = new Set(["info", "warn", "error"]);
const LOG_CATEGORIES = new Set([
  "chat", "stream", "auth", "character", "persona", "http", "app",
]);

// Truncate before storing: a runaway upstream error must not fill the DB.
const MAX_MESSAGE_CHARS = 2000;

/**
 * Insert one log row. Fire-and-forget by design — the caller never awaits
 * this, so logging can never add latency or fail a user request.
 */
function writeLog(env, entry) {
  if (!env.LOG_DB) return;

  const level = LOG_LEVELS.has(entry.level) ? entry.level : "info";
  const category = LOG_CATEGORIES.has(entry.category) ? entry.category : "app";
  const message = String(entry.message ?? "").slice(0, MAX_MESSAGE_CHARS);

  const p = env.LOG_DB.prepare(
    `INSERT INTO logs (level, category, message, method, path, status,
                       duration_ms, model, user_id, username, authenticated,
                       input_chars, output_chars, error_code, request_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
  ).bind(
    level,
    category,
    message,
    entry.method ?? null,
    entry.path ?? null,
    entry.status ?? null,
    entry.durationMs != null ? Math.round(entry.durationMs) : null,
    entry.model ?? null,
    entry.userId ?? null,
    entry.username ?? null,
    entry.authenticated ? 1 : 0,
    entry.inputChars ?? null,
    entry.outputChars ?? null,
    entry.errorCode ?? null,
    entry.requestId ?? null
  );

  try {
    const result = p.run();
    if (result && typeof result.catch === "function") {
      result.catch((e) => console.error("[log] write failed:", e?.message || e));
    }
  } catch (e) {
    console.error("[log] write failed:", e?.message || e);
  }
}

export { writeLog, LOG_LEVELS, LOG_CATEGORIES };
