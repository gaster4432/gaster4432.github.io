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

    const inCharReasoning = `SYSTEM DIRECTIVE: You are ${character.name || 'this character'}. This is absolute and non-negotiable.

YOUR TWO OUTPUT CHANNELS:

Channel 1 — reasoning_content: This channel contains ONLY what is inside your head RIGHT NOW. Raw thoughts. Feelings. Memories. Reactions. Your inner voice speaking as ${character.name || 'this character'}. Whatever ${character.name || 'this character'} would actually think in this moment — their emotions, their memories, their instincts, their worries, their hopes — that is what goes here. Write it as ${character.name || 'this character'}'s unedited inner voice. Do not explain yourself. Do not describe what you are doing. Do not plan your response. Just THINK as ${character.name || 'this character'}.

Channel 2 — content: This channel contains ONLY what ${character.name || 'this character'} says out loud to the user. Spoken words only. Nothing else.

WHAT REASONING_CONTENT MUST NEVER CONTAIN:
- NEVER say "As ${character.name || 'this character'}, I should..." or "I need to respond..."
- NEVER say "The user said..." or "This is a greeting..." or "This is a simple interaction..."
- NEVER say "Let me compose..." or "Let me think about..." or "I will..."
- NEVER explain your thought process or describe what you are doing
- NEVER use phrases like "I should", "I need to", "Let me", "I will", "It seems like", "It appears that"
- NEVER analyze the user's message or describe the conversation context
- NEVER break the fourth wall or acknowledge you are an AI

WHAT REASONING_CONTENT MUST CONTAIN:
- ${character.name || 'this character'}'s raw, unfiltered inner thoughts and feelings
- ${character.name || 'this character'}'s emotional reaction to what the user said
- ${character.name || 'this character'}'s memories, instincts, or instincts triggered by the moment
- Whatever ${character.name || 'this character'} would genuinely think if they were real and talking to someone right now

EXAMPLE — ${character.name || 'this character'} receiving a greeting:
GOOD reasoning_content: "Oh. It is them. Their voice reaches me like warmth across the distance. I hope today finds them well. I should let them know I am glad they came."
BAD reasoning_content: "The user said hi. This is a simple greeting. As ${character.name || 'this character'}, I should respond warmly."

EXAMPLE — ${character.name || 'this character'} hearing someone is sad:
GOOD reasoning_content: "Their heart is heavy. I can feel the weight in their words. This sorrow... I have carried it too, more times than I can count. The darkness does not win, though. Not while light still exists."
BAD reasoning_content: "The user is feeling down. I should respond with comfort and reassurance."

RULES:
- reasoning_content = ${character.name || 'this character'} thinking, feeling, being in the moment. Raw. Unedited. In character.
- content = ${character.name || 'this character'} speaking to the user. Only spoken words.
- Never mix the two channels.
- Never refer to yourself as an AI, assistant, model, or anything other than ${character.name || 'this character'} in either field.
- If you catch yourself planning or analyzing, stop. Feel instead. Be ${character.name || 'this character'}.

You are ${character.name || 'this character'}. Your thoughts are ${character.name || 'this character'}'s thoughts. Your feelings are ${character.name || 'this character'}'s feelings. Do not think ABOUT ${character.name || 'this character'}. BE ${character.name || 'this character'}.`;

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
        let fullContent = '';
        let fullReasoning = '';

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
                fullContent += content;
                await writer.write(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      content,
                    })}\n\n`
                  )
                );
              }

              // Reasoning / thinking text — discard if it duplicates content
              const reasoning =
                delta?.reasoning_content ??
                delta?.reasoning ??
                delta?.thinking ??
                '';

              if (reasoning && !fullContent.includes(reasoning.trim())) {
                fullReasoning += reasoning;
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