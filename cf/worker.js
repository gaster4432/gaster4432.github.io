// ==========================================
// CF Chat Worker - Chat + Characters + Vision
// OpenCode model backend
// ==========================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function cleanStr(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// --- Character CRUD ---

async function handleCharacters(request, env) {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/api/characters') {
    const { results } = await env.DB.prepare(
      'SELECT id, name, greeting, systemPrompt, avatar, created_at FROM characters ORDER BY created_at ASC'
    ).all();

    return json({ characters: results || [] });
  }

  if (request.method === 'POST' && url.pathname === '/api/characters') {
    let body = {};

    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid JSON' }, 400);
    }

    const name = cleanStr(body.name, 200);

    if (!name) {
      return json({ error: 'name required' }, 400);
    }

    const greeting = cleanStr(body.greeting, 2000);
    const systemPrompt = cleanStr(body.systemPrompt, 20000);

    const avatar =
      typeof body.avatar === 'string'
        ? body.avatar.slice(0, 1500000)
        : '';

    const id =
      'char_' +
      crypto.randomUUID().replace(/-/g, '').slice(0, 16);

    await env.DB.prepare(
      'INSERT INTO characters (id, name, greeting, systemPrompt, avatar) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(id, name, greeting, systemPrompt, avatar)
      .run();

    return json(
      {
        character: {
          id,
          name,
          greeting,
          systemPrompt,
          avatar,
        },
      },
      201
    );
  }

  const m = url.pathname.match(/^\/api\/characters\/([\w-]+)$/);

  if (m) {
    const id = m[1];

    if (request.method === 'PUT') {
      let body = {};

      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid JSON' }, 400);
      }

      const existing = await env.DB.prepare(
        'SELECT * FROM characters WHERE id = ?'
      )
        .bind(id)
        .first();

      if (!existing) {
        return json({ error: 'not found' }, 404);
      }

      const next = {
        name: cleanStr(body.name, 200) || existing.name,

        greeting:
          typeof body.greeting === 'string'
            ? cleanStr(body.greeting, 2000)
            : existing.greeting,

        systemPrompt:
          typeof body.systemPrompt === 'string'
            ? cleanStr(body.systemPrompt, 20000)
            : existing.systemPrompt,

        avatar:
          typeof body.avatar === 'string'
            ? body.avatar.slice(0, 1500000)
            : existing.avatar,
      };

      if (!next.name) {
        return json({ error: 'name required' }, 400);
      }

      await env.DB.prepare(
        "UPDATE characters SET name = ?, greeting = ?, systemPrompt = ?, avatar = ?, updated_at = datetime('now') WHERE id = ?"
      )
        .bind(
          next.name,
          next.greeting,
          next.systemPrompt,
          next.avatar,
          id
        )
        .run();

      const row = await env.DB.prepare(
        'SELECT * FROM characters WHERE id = ?'
      )
        .bind(id)
        .first();

      return json({ character: row });
    }

    if (request.method === 'DELETE') {
      const existing = await env.DB.prepare(
        'SELECT id FROM characters WHERE id = ?'
      )
        .bind(id)
        .first();

      if (!existing) {
        return json({ error: 'not found' }, 404);
      }

      await env.DB.prepare(
        'DELETE FROM characters WHERE id = ?'
      )
        .bind(id)
        .run();

      return json({ success: true });
    }
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: CORS,
      });
    }

    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/characters')) {
      return handleCharacters(request, env);
    }

    if (url.pathname !== '/api/chat' || request.method !== 'POST') {
      return json({ error: 'Not found' }, 404);
    }

    const {
      message,
      character,
      history,
      image
    } = await request.json();

    if (!character) {
      return json({ error: 'character required' }, 400);
    }

    if (!message) {
      return json({ error: 'message required' }, 400);
    }

    const greeting = character.greeting || '';

    const sysPrompt =
      character.systemPrompt ||
      `You are ${character.name || 'a helpful assistant'}.`;

    const inCharReasoning = `You MUST reason and think as ${character.name || 'this character'} described in the system prompt above. Use the reasoning_content field ONLY for your internal thinking, deliberation, and character-consistent thought process. Use the content field ONLY for your actual spoken response and actions. Never put your spoken response or actions into reasoning_content. Never put your thinking or deliberation into content. Think in character, speak in character.`;

    const sysPromptWithReasoning = sysPrompt + '\n\n' + inCharReasoning;

    let userContent = message;

    // ==========================================
    // IMAGE UNDERSTANDING
    // ==========================================

    if (image) {
      try {
        const visionResp = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/@cf/mistralai/mistral-small-3.1-24b-instruct`,
          {
            method: 'POST',

            headers: {
              Authorization: `Bearer ${env.CF_AUTH_TOKEN}`,
              'Content-Type': 'application/json',
            },

            body: JSON.stringify({
              messages: [
                {
                  role: 'system',
                  content: 'Describe the image in detail.',
                },
                {
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: 'Describe this image accurately and in detail:',
                    },
                    {
                      type: 'image_url',
                      image_url: {
                        url: image.startsWith('data:')
                          ? image
                          : `data:image/png;base64,${image}`,
                      },
                    },
                  ],
                },
              ],
              max_tokens: 1024,
            }),
          }
        );

        if (visionResp.ok) {
          const visionData = await visionResp.json();

          const description =
            visionData.result?.response ||
            'An image was provided.';

          userContent =
            `${message}\n\n[Image Description]: ${description}`;
        }
      } catch {
        userContent =
          `${message}\n\n[Image could not be analyzed]`;
      }
    }

    // ==========================================
    // BUILD CONVERSATION
    // ==========================================

    const msgs = [
      {
        role: 'system',
        content: sysPromptWithReasoning,
      },
    ];

    if (greeting) {
      msgs.push({
        role: 'assistant',
        content: greeting,
      });
    }

    for (const m of history || []) {
      msgs.push(m);
    }

    msgs.push({
      role: 'user',
      content: userContent,
    });

    // ==========================================
    // OPENCODE MODEL
    // ==========================================

    const model = 'ling-3.0-flash-fin-free';

    const aiResp = await fetch(
      'https://opencode.ai/inference/openai/v1/chat/completions',
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
        },

        body: JSON.stringify({
          model,
          messages: msgs,
          stream: true,
          max_tokens: 2048,
          temperature: 0.7,
        }),
      }
    );

    if (!aiResp.ok) {
      const errorText = await aiResp.text();

      console.error(
        'OpenCode request failed:',
        aiResp.status,
        errorText
      );

      return json(
        {
          error: 'AI request failed',
          status: aiResp.status,
        },
        502
      );
    }

    // ==========================================
    // STREAMING RESPONSE
    // ==========================================

    const { readable, writable } = new TransformStream();

    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const reader = aiResp.body.getReader();
    const decoder = new TextDecoder();

    let buf = '';

    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();

          if (done) break;

          buf += decoder.decode(value, {
            stream: true,
          });

          const lines = buf.split('\n');

          buf = lines.pop() || '';

          for (const line of lines) {
            const t = line.trim();

            if (!t.startsWith('data: ')) {
              continue;
            }

            const payload = t.slice(6);

            if (payload === '[DONE]') {
              continue;
            }

            try {
              const chunk = JSON.parse(payload);

              const delta =
                chunk?.choices?.[0]?.delta;

              // Normal response text
              const content =
                delta?.content || '';

              if (content) {
                await writer.write(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      content,
                    })}\n\n`
                  )
                );
              }

              // Reasoning / thinking text
              const reasoning =
                delta?.reasoning_content ??
                delta?.reasoning ??
                delta?.thinking ??
                '';

              if (reasoning) {
                await writer.write(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      reasoning,
                    })}\n\n`
                  )
                );
              }

            } catch {
              // Ignore malformed SSE chunks
            }
          }
        }

        await writer.write(
          encoder.encode(
            `data: ${JSON.stringify({
              done: true,
            })}\n\n`
          )
        );

      } catch (e) {
        await writer.write(
          encoder.encode(
            `data: ${JSON.stringify({
              error:
                e?.message ||
                'Streaming error',
            })}\n\n`
          )
        );

      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...CORS,
      },
    });
  },
};