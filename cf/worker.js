const MODEL = "@cf/zai-org/glm-4.7-flash";
const HISTORY_LIMIT = 9999999999999;

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

function buildHistory(raw) {
  if (!Array.isArray(raw)) return [];

  return raw
    .slice(-HISTORY_LIMIT)
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        ["user", "assistant"].includes(item.role) &&
        typeof item.content === "string" &&
        item.content.length > 0
    )
    .map(({ role, content }) => ({ role, content }));
}

function systemPromptFor(character) {
  return typeof character.systemPrompt === "string" &&
    character.systemPrompt.trim()
    ? character.systemPrompt.trim()
    : `You are ${
        typeof character.name === "string"
          ? character.name.trim()
          : "a helpful assistant"
      }.`;
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
      SELECT id, name, greeting, systemPrompt, avatar, created_at
      FROM characters
      ORDER BY created_at ASC
    `).all();

    return json({ characters: result.results ?? [] });
  } catch (error) {
    console.error("[characters] query failed:", error);
    return json({ error: "Character query failed" }, 500);
  }
}

async function handleChat(request, env) {
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

  if (typeof message !== "string" || !message.trim()) {
    return json({ error: "message required" }, 400);
  }

  // Only allow the configured Workers AI model.
  const selectedModel = MODEL;

  if (model && model !== selectedModel) {
    return json(
      {
        error: `Unsupported model. Use ${selectedModel}.`,
        model: selectedModel,
      },
      400
    );
  }

  const messages = [
    {
      role: "system",
      content: systemPromptFor(character),
    },
  ];

  const greeting =
    typeof character.greeting === "string"
      ? character.greeting.trim()
      : "";

  if (greeting) {
    messages.push({
      role: "assistant",
      content: greeting,
    });
  }

  messages.push(...buildHistory(history));

  messages.push({
    role: "user",
    content: message,
  });

  // Workers AI accepts a stream of model-generated events.
  let aiStream;

  try {
    aiStream = await env.AI.run(selectedModel, {
      messages,
      stream: true,
    });
  } catch (error) {
    console.error("[chat] Workers AI request failed:", error);

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
      let completed = false;

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

        if (!data || data === "[DONE]") {
          completed = true;
          return;
        }

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
          emit(controller, encoder, { content });
        }

        if (event?.error) {
          const message =
            typeof event.error === "string"
              ? event.error
              : event.error.message ?? "Workers AI stream error";

          sendError(message);
          completed = true;
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

        emit(controller, encoder, {
          done: true,
          model: selectedModel,
        });

        controller.close();
      } catch (error) {
        console.error("[chat] stream failed:", error);

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
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS,
      });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/models") {
      return json({
        models: [MODEL],
        capabilities: {
          [MODEL]: {
            vision: true,
            streaming: true,
            functionCalling: true,
            contextWindow: 262144,
          },
        },
        provider: "cloudflare-workers-ai",
      });
    }

    if (url.pathname.startsWith("/api/characters")) {
      return handleCharacters(request, env);
    }

    if (
      url.pathname === "/api/chat" &&
      request.method === "POST"
    ) {
      return handleChat(request, env);
    }

    return json({ error: "Not found" }, 404);
  },
};
