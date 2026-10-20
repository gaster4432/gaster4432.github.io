import {
  buildSystemPrompt,
  handleCreateCharacter,
  handleLogin,
  handleLogout,
  handlePersona,
  handleProfileUpdate,
  handleRefresh,
  handleRegister,
  handleRegisterIntent,
  handleSessionStatus,
  loadPersona,
  resolveSession,
} from "./auth.js";
import { writeLog } from "./logging.js";

const MODEL = "@cf/zai-org/glm-4.7-flash";

/* ─── Context budget ───
 * CONTEXT_WINDOW is the docs-verified limit for @cf/zai-org/glm-4.7-flash.
 * This endpoint previously advertised 262144, which is 2x the real window.
 * Budget = window - output reserve - chat-template overhead - system prompt.
 */
const CONTEXT_WINDOW = 131072;
const MAX_OUTPUT_TOKENS = 8192;   // sent explicitly so the reserve is real
const TEMPLATE_OVERHEAD = 1024;   // GLM chat template + role markers
const SYSTEM_RESERVE = 8192;      // ceiling for system prompt + greeting
const PER_MESSAGE_OVERHEAD = 4;   // role marker + delimiters

/* Estimator constants. Deliberately pessimistic so estimate >= actual for any
 * input, which makes the budget a hard guarantee rather than a guess. GLM's
 * tokenizer is not public, so exact counting is not possible here.
 */
const CHARS_PER_TOKEN = 3.5;
const CJK_TOKENS_PER_CHAR = 2;

/* Ranges where a single character can cost ~1-2 tokens. Astral-plane ranges
 * need the /u flag and match one full codepoint, while String.length counts
 * them as 2 units — that skews the remainder upward, which is the safe side.
 */
const DENSE_RE =
  /[\u1100-\u11FF\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{20000}-\u{3FFFF}]/gu;

const MAX_SYSTEM_CHARS = 16000;
const MAX_MESSAGE_CHARS = 32000;

// How much chat text to keep per log row. Full enough to read the exchange,
// small enough that a marathon session cannot bloat the logs database.
const MAX_LOG_TEXT = 1500;

/* Reasoning adds ~4-8s of latency before the first token, because the
 * hidden thinking phase emits nothing the browser can render. Flip this to
 * true for hard questions. GLM-4.7-Flash exposes it as
 * chat_template_kwargs.enable_thinking (there is no reasoning_effort on
 * this model — that field belongs to GLM-5.2).
 */
const ENABLE_THINKING = false;

function estimateTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  const dense = text.match(DENSE_RE);
  const d = dense ? dense.length : 0;
  return Math.ceil((text.length - d) / CHARS_PER_TOKEN) + d * CJK_TOKENS_PER_CHAR;
}

function messageTokens(content) {
  return estimateTokens(content) + PER_MESSAGE_OVERHEAD;
}

/** Tokens available for history, after system prompt + output reserve. */
function historyBudgetFor(systemText, greetingText) {
  const used =
    messageTokens(systemText) +
    (greetingText ? messageTokens(greetingText) : 0);
  return CONTEXT_WINDOW - MAX_OUTPUT_TOKENS - TEMPLATE_OVERHEAD - Math.min(SYSTEM_RESERVE, used);
}

/**
 * Tokens left for history AND the incoming message, once system + greeting
 * are paid for. The message must be budgeted alongside history — reserving
 * only for history lets a max-length message push the request over the window.
 */
function conversationRoomFor(systemText, greetingText) {
  const used =
    messageTokens(systemText) +
    (greetingText ? messageTokens(greetingText) : 0);
  return Math.max(0, CONTEXT_WINDOW - MAX_OUTPUT_TOKENS - TEMPLATE_OVERHEAD
    - Math.min(SYSTEM_RESERVE, used));
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS,
    },
  });
}

function sseResponse(stream) {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      ...CORS,
    },
  });
}

function emit(controller, encoder, data) {
  controller.enqueue(
    encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
  );
}

function buildHistory(raw, budgetTokens) {
  if (!Array.isArray(raw)) return [];

  const clean = raw
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        ["user", "assistant"].includes(item.role) &&
        typeof item.content === "string" &&
        item.content.length > 0
    )
    .map(({ role, content }) => ({ role, content }));

  // Keep the newest contiguous run that fits. Walking backwards preserves
  // conversational coherence; dropping arbitrary turns would leave orphaned
  // replies with no question attached.
  const kept = [];
  let used = 0;

  for (let i = clean.length - 1; i >= 0; i--) {
    const cost = messageTokens(clean[i].content);
    if (used + cost > budgetTokens) break;
    kept.unshift(clean[i]);
    used += cost;
  }

  // One message can be larger than the entire budget on its own. Rather than
  // dropping the turn (losing the question entirely) slice its content.
  if (kept.length === 0 && clean.length > 0) {
    const last = clean[clean.length - 1];
    const room = Math.max(0, budgetTokens - PER_MESSAGE_OVERHEAD);
    const maxChars = Math.floor(room / CHARS_PER_TOKEN);
    const clipped = last.content.slice(0, maxChars);
    kept.push({
      role: last.role,
      content: clipped.length < last.content.length ? `${clipped}\n…[truncated]` : clipped,
    });
  }

  return kept;
}

function systemPromptFor(character) {
  const fallback = `You are ${
    typeof character.name === "string"
      ? character.name.trim()
      : "a helpful assistant"
  }.`;

  const raw =
    typeof character.systemPrompt === "string" && character.systemPrompt.trim()
      ? character.systemPrompt.trim()
      : fallback;

  // A 200KB system prompt must not be able to blow the context window.
  return raw.length > MAX_SYSTEM_CHARS ? raw.slice(0, MAX_SYSTEM_CHARS) : raw;
}

async function handleCharacters(request, env) {
  const url = new URL(request.url);

  if (
    request.method !== "GET" ||
    url.pathname !== "/api/characters"
  ) {
    return json({ error: "Not found" }, 404);
  }

  if (!env.DB) {
    return json({ error: "Database not configured" }, 503);
  }

  try {
    const result = await env.DB.prepare(`
      SELECT id, name, greeting, systemPrompt, avatar, created_at, owner_id
      FROM characters
      ORDER BY created_at ASC
    `).all();

    return json({ characters: result.results ?? [] });
  } catch (error) {
    console.error("[characters] query failed:", error);
    return json({ error: "Character query failed" }, 500);
  }
}

/**
 * The context for a continuation has to end on the model's own last turn.
 * Any trailing user messages are dropped, so "continue" always means "write
 * the next assistant turn" and never quietly turns into "answer this new
 * prompt".
 */
function trimToAssistantTurn(history) {
  if (!Array.isArray(history)) return [];
  const out = history.slice();
  while (
    out.length &&
    out[out.length - 1] &&
    out[out.length - 1].role !== "assistant"
  ) {
    out.pop();
  }
  return out;
}

async function handleChat(request, env, context = {}) {
  const { user = null } = context;
  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON request body" }, 400);
  }

  const {
    message,
    character,
    history,
    model,
    continue: continueRequested,
  } = body ?? {};

  if (!env.AI || typeof env.AI.run !== "function") {
    return json(
      { error: "Workers AI binding AI is not configured" },
      503
    );
  }

  if (!character || typeof character !== "object") {
    return json({ error: "character required" }, 400);
  }

  /* A continuation carries no new user message. The whole context is sent
   * again and ends on the model's own last turn, so it writes the next
   * assistant turn. Nothing new is asked — this is how "carry on" works.
   */
  const text = typeof message === "string" ? message.trim() : "";
  const isContinue = continueRequested === true;

  if (!isContinue && !text) {
    return json({ error: "message required" }, 400);
  }

  // Only allow the configured Workers AI model.
  const selectedModel = MODEL;

  // Log what the user actually asked for, not just "POST /api/chat -> 200".
  let loggedText = text;
  if (isContinue && Array.isArray(history)) {
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      if (h && h.role === "assistant" && typeof h.content === "string") {
        loggedText = h.content;
        break;
      }
    }
  }
  writeLog(env, {
    level: "info",
    category: "chat",
    message: (isContinue ? "continue: " : "user: ") + loggedText.slice(0, MAX_LOG_TEXT),
    path: "/api/chat",
    method: "POST",
    status: 200,
    model: selectedModel,
    userId: user ? user.id : null,
    username: user ? user.username : null,
    authenticated: !!user,
    inputChars: loggedText.length,
  });

  if (model && model !== selectedModel) {
    return json(
      {
        error: `Unsupported model. Use ${selectedModel}.`,
        model: selectedModel,
      },
      400
    );
  }

  // Persona is loaded server-side from the session, never read from the
// request body — a user cannot spoof another account's persona or push it
// past MAX_PERSONA_CHARS.
const personaText = user ? await loadPersona(env, user.id) : "";

let system = buildSystemPrompt(systemPromptFor(character), personaText);
if (system.length > MAX_SYSTEM_CHARS) system = system.slice(0, MAX_SYSTEM_CHARS);

const greeting =
    typeof character.greeting === "string"
      ? character.greeting.trim()
      : "";

  // Budget the incoming message together with history. MAX_MESSAGE_CHARS is
  // the hard cap, but a very large system prompt leaves less room, so the
  // message is also clamped to whatever actually fits.
  const room = conversationRoomFor(system, greeting);
  const messages = [{ role: "system", content: system }];

  if (greeting) {
    messages.push({
      role: "assistant",
      content: greeting,
    });
  }

  // How much text came in, for the log. A continuation has no incoming
  // turn, so it counts the context it carried on from.
  let inputChars = 0;

  if (isContinue) {
    // No incoming turn at all. The context ends on the model's own last
    // reply and the model writes the next one.
    messages.push(...buildHistory(trimToAssistantTurn(history), room));
    inputChars = loggedText.length;
  } else {
    const messageRoom = Math.floor(
      Math.max(0, room - PER_MESSAGE_OVERHEAD) / CHARS_PER_TOKEN
    );
    const userContent = text.slice(
      0,
      Math.min(MAX_MESSAGE_CHARS, messageRoom)
    );
    inputChars = userContent.length;

    // The persona is already folded into `system`, so history gets whatever
    // the message did not use.
    messages.push(
      ...buildHistory(history, Math.max(0, room - messageTokens(userContent)))
    );

    messages.push({
      role: "user",
      content: userContent,
    });
  }

  // Workers AI accepts a stream of model-generated events.
  let aiStream;

  try {
    aiStream = await env.AI.run(selectedModel, {
      messages,
      stream: true,
      max_tokens: MAX_OUTPUT_TOKENS,
      chat_template_kwargs: {
        enable_thinking: ENABLE_THINKING,
        clear_thinking: false,
      },
    });
  } catch (error) {
    console.error("[chat] Workers AI request failed:", error);
    writeLog(env, {
      level: "error",
      category: "chat",
      message: "upstream_ai_error: " + String((error && error.message) || error),
      path: "/api/chat",
      status: 502,
      model: selectedModel,
      userId: user ? user.id : null,
      username: user ? user.username : null,
      authenticated: !!user,
      inputChars: inputChars,
      errorCode: "upstream_error",
    });

    return json(
      {
        error: error instanceof Error
          ? error.message
          : "Workers AI request failed",
        code: "upstream_error",
        model: selectedModel,
      },
      502
    );
  }

  if (!(aiStream instanceof ReadableStream)) {
    writeLog(env, {
      level: "error",
      category: "stream",
      message: "upstream did not return a ReadableStream",
      path: "/api/chat",
      status: 502,
      model: selectedModel,
      authenticated: !!user,
      errorCode: "not_a_stream",
    });

    return json(
      {
        error: "Workers AI did not return a readable stream",
        code: "upstream_error",
        model: selectedModel,
      },
      502
    );
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const output = new ReadableStream({
    async start(controller) {
      const reader = aiStream.getReader();
      let buffer = "";
      let emittedChars = 0;
      let emittedText = '';
      const startedAt = Date.now();

      function sendError(message, code = "upstream_error") {
        emit(controller, encoder, {
          error: message,
          code,
          model: selectedModel,
        });
      }

      function processFrame(frame) {
        const dataLines = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart());

        if (dataLines.length === 0) return;

        const data = dataLines.join("\n");

        if (!data || data === "[DONE]") return;

        let event;

        try {
          event = JSON.parse(data);
        } catch {
          return;
        }

        // Handle either Workers AI native stream events
        // or OpenAI-compatible chat completion events.
        const content =
          event?.choices?.[0]?.delta?.content ??
          event?.response ??
          event?.delta?.text ??
          event?.content;

        if (typeof content === "string" && content.length > 0) {
          emittedChars += content.length;
          emittedText += content;
          emit(controller, encoder, { content });
        }

        if (event?.error) {
          const message =
            typeof event.error === "string"
              ? event.error
              : event.error.message ?? "Workers AI stream error";

          sendError(message);
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          let boundary;

          while (
            (boundary = buffer.search(/\r?\n\r?\n/)) !== -1
          ) {
            const frame = buffer.slice(0, boundary);
            const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)[0];

            buffer = buffer.slice(boundary + separator.length);
            processFrame(frame);
          }
        }

        buffer += decoder.decode();

        if (buffer.trim()) {
          processFrame(buffer);
        }

        writeLog(env, {
          level: "info",
          category: "stream",
          message: "assistant: " + emittedText.slice(0, MAX_LOG_TEXT),
          path: "/api/chat",
          status: 200,
          model: selectedModel,
          userId: user ? user.id : null,
          username: user ? user.username : null,
          authenticated: !!user,
          inputChars: inputChars,
          outputChars: emittedChars,
          durationMs: Date.now() - startedAt,
        });

        emit(controller, encoder, {
          done: true,
          model: selectedModel,
        });

        controller.close();
      } catch (error) {
        console.error("[chat] stream failed:", error);
        writeLog(env, {
          level: "error",
          category: "stream",
          message: "stream_pump_failed: " + String((error && error.message) || error),
          path: "/api/chat",
          status: 500,
          model: selectedModel,
          authenticated: !!user,
          errorCode: "stream_failed",
        });

        try {
          sendError(
            error instanceof Error
              ? error.message
              : "Stream failed"
          );

          emit(controller, encoder, {
            done: true,
            error: true,
            model: selectedModel,
          });

          controller.close();
        } catch {
          // The client may already have disconnected.
        }
      } finally {
        reader.releaseLock();
      }
    },

    async cancel() {
      // The consumer has disconnected.
      try {
        await aiStream.cancel();
      } catch {
        // The underlying stream may already be closed.
      }
    },
  });

  return sseResponse(output);
}

export default {
  async fetch(request, env) {
    const started = Date.now();
    const url = new URL(request.url);

    try {
      const res = await route(request, env, url);
      logRequest(request, env, url, res, started);
      return res;
    } catch (error) {
      // Last-resort net: without this a thrown handler returns a bare
      // Error 1102 and leaves no trace in the log database.
      console.error("[worker] unhandled:", error);
      writeLog(env, {
        level: "error",
        category: "app",
        message: `Unhandled: ${error?.message || error}`,
        method: request.method,
        path: url.pathname,
        status: 500,
        durationMs: Date.now() - started,
      });
      return json({ error: "Internal error" }, 500);
    }
  }
};

/** One structured row per API request. Skips static/noisy paths. */
function logRequest(request, env, url, res, started) {
  if (!env.LOG_DB) return;
  if (!url.pathname.startsWith("/api/")) return;
  if (url.pathname === "/api/chat") return;

  const status = res?.status ?? 0;
  const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";

  let category = "http";
  if (url.pathname === "/api/chat") category = "chat";
  else if (url.pathname.startsWith("/api/auth/")) category = "auth";
  else if (url.pathname.startsWith("/api/character")) category = "character";
  else if (url.pathname.startsWith("/api/persona")) category = "persona";

  writeLog(env, {
    level,
    category,
    message: `${request.method} ${url.pathname} -> ${status}`,
    method: request.method,
    path: url.pathname,
    status,
    durationMs: Date.now() - started,
    errorCode: status >= 400 ? url.searchParams.get("error") : null,
  });
}

async function route(request, env, url) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS,
      });
    }

    if (url.pathname === "/api/models") {
      return json({
        models: [MODEL],
        capabilities: {
          [MODEL]: {
            // GLM-4.7-Flash is text-only. GLM-5.3-Flash is the first
            // GLM-family model on Workers AI with vision.
            vision: false,
            streaming: true,
            functionCalling: true,
            reasoning: ENABLE_THINKING,
            contextWindow: CONTEXT_WINDOW,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          },
        },
        provider: "cloudflare-workers-ai",
        // Single source of truth for the client's budgeting so the two
        // implementations cannot drift apart.
        budget: {
          contextWindow: CONTEXT_WINDOW,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          templateOverhead: TEMPLATE_OVERHEAD,
          systemReserve: SYSTEM_RESERVE,
          perMessageOverhead: PER_MESSAGE_OVERHEAD,
          charsPerToken: CHARS_PER_TOKEN,
          cjkTokensPerChar: CJK_TOKENS_PER_CHAR,
          maxSystemChars: MAX_SYSTEM_CHARS,
          maxMessageChars: MAX_MESSAGE_CHARS,
        },
      });
    }

    if (url.pathname === "/api/characters") {
      if (request.method === "POST") {
        const user = await resolveSession(env, request);
        if (!user) return json({ error: "auth_required" }, 401);
        return handleCreateCharacter(request, env, json, user);
      }
      return handleCharacters(request, env);
    }

    if (url.pathname.startsWith("/api/auth/")) {
      const action = url.pathname.slice("/api/auth/".length);

      if (action === "login" && request.method === "POST") {
        return handleLogin(request, env, json);
      }
      if (action === "register-intent" && request.method === "POST") {
        return handleRegisterIntent(request, env, json);
      }
      if (action === "register" && request.method === "POST") {
        return handleRegister(request, env, json);
      }
      if (action === "session" && request.method === "GET") {
        const user = await resolveSession(env, request);
        return handleSessionStatus(request, env, json, user);
      }
      if (action === "profile" && (request.method === "POST" || request.method === "PUT")) {
        const user = await resolveSession(env, request);
        if (!user) return json({ error: "auth_required" }, 401);
        return handleProfileUpdate(request, env, json, user);
      }
      if (action === "refresh" && request.method === "POST") {
        const user = await resolveSession(env, request);
        if (!user) return json({ error: "auth_required" }, 401);
        return handleRefresh(request, env, json, user);
      }
      if (action === "logout" && request.method === "POST") {
        const user = await resolveSession(env, request);
        if (!user) return json({ ok: true });
        return handleLogout(request, env, json, user);
      }

      return json({ error: "Not found" }, 404);
    }

    if (url.pathname === "/api/persona") {
      const user = await resolveSession(env, request);
      if (!user) return json({ error: "auth_required" }, 401);
      return handlePersona(request, env, json, user);
    }

    if (
      url.pathname === "/api/chat" &&
      request.method === "POST"
    ) {
      // Chat is open to everyone and is not metered. The login and
      // registration endpoints still have their own limits, which is where
      // brute forcing would actually hurt.
      const user = await resolveSession(env, request);
      return handleChat(request, env, { user });
    }

    return json({ error: "Not found" }, 404);
}
