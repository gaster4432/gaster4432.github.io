// ==========================================
// CF Chat Worker - Chat + Characters + Vision
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

// Only accept safe avatar schemes from API clients
function cleanAvatar(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s) return '';
  if (/^data:image\//i.test(s)) return s.slice(0, 1500000);
  if (/^https?:\/\//i.test(s)) return s.slice(0, 2000);
  return '';
}

// ─── Character CRUD ───
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
    try { body = await request.json(); } catch (e) { return json({ error: 'invalid JSON' }, 400); }
    const name = cleanStr(body.name, 200);
    if (!name) return json({ error: 'name required' }, 400);
    const greeting = cleanStr(body.greeting, 2000);
    const systemPrompt = cleanStr(body.systemPrompt, 20000);
    const avatar = cleanAvatar(body.avatar);
    const id = 'char_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    await env.DB.prepare(
      'INSERT INTO characters (id, name, greeting, systemPrompt, avatar) VALUES (?, ?, ?, ?, ?)'
    ).bind(id, name, greeting, systemPrompt, avatar).run();
    return json({ character: { id, name, greeting, systemPrompt, avatar } }, 201);
  }

  const m = url.pathname.match(/^\/api\/characters\/([\w-]+)$/);
  if (m) {
    const id = m[1];

    if (request.method === 'PUT') {
      let body = {};
      try { body = await request.json(); } catch (e) { return json({ error: 'invalid JSON' }, 400); }
      const existing = await env.DB.prepare('SELECT * FROM characters WHERE id = ?').bind(id).first();
      if (!existing) return json({ error: 'not found' }, 404);
      const next = {
        name: cleanStr(body.name, 200) || existing.name,
        greeting: typeof body.greeting === 'string' ? cleanStr(body.greeting, 2000) : existing.greeting,
        systemPrompt: typeof body.systemPrompt === 'string' ? cleanStr(body.systemPrompt, 20000) : existing.systemPrompt,
        avatar: body.avatar !== undefined ? cleanAvatar(body.avatar) : existing.avatar,
      };
      if (!next.name) return json({ error: 'name required' }, 400);
      await env.DB.prepare(
        "UPDATE characters SET name = ?, greeting = ?, systemPrompt = ?, avatar = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(next.name, next.greeting, next.systemPrompt, next.avatar, id).run();
      const row = await env.DB.prepare('SELECT * FROM characters WHERE id = ?').bind(id).first();
      return json({ character: row });
    }

    if (request.method === 'DELETE') {
      const existing = await env.DB.prepare('SELECT id FROM characters WHERE id = ?').bind(id).first();
      if (!existing) return json({ error: 'not found' }, 404);
      await env.DB.prepare('DELETE FROM characters WHERE id = ?').bind(id).run();
      return json({ success: true });
    }
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/characters')) {
      return handleCharacters(request, env);
    }

    if (url.pathname !== '/api/chat' || request.method !== 'POST') {
      return json({ error: 'Not found' }, 404);
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return json({ error: 'invalid JSON' }, 400);
    }

    const { message, character, image } = payload;

    if (!character || typeof character !== 'object') {
      return json({ error: 'character required' }, 400);
    }

    const msgText = cleanStr(message, 16000);
    if (!msgText) {
      return json({ error: 'message required' }, 400);
    }

    // Sanitize conversation history before forwarding to the model
    const sanitizedHistory = Array.isArray(payload.history)
      ? payload.history
          .slice(-80)
          .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
          .map(m => ({ role: m.role, content: m.content.slice(0, 16000) }))
      : [];

    const greeting = cleanStr(character.greeting, 2000);
    let sysPrompt = cleanStr(character.systemPrompt, 20000) || `You are ${cleanStr(character.name, 200) || 'a helpful assistant'}.`;

    let userContent = msgText;

    // === IMAGE UNDERSTANDING ===
    if (image && typeof image === 'string' && image.length <= 5242880) {
      const visionModel = env.CF_VISION_MODEL || '@cf/mistralai/mistral-small-3.1-24b-instruct';
      try {
        const visionResp = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${visionModel}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${env.CF_AUTH_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              messages: [
                { role: "system", content: "Describe the image in detail." },
                {
                  role: "user",
                  content: [
                    { type: "text", text: "Describe this image accurately and in detail:" },
                    { type: "image_url", image_url: { url: image.startsWith("data:") ? image : `data:image/png;base64,${image}` } }
                  ]
                }
              ],
              max_tokens: 1024
            })
          }
        );

        if (visionResp.ok) {
          const visionData = await visionResp.json();
          const description = visionData.result?.response || "An image was provided.";
          userContent = `${msgText}\n\n[Image Description]: ${description}`;
        }
      } catch (e) {
        userContent = `${msgText}\n\n[Image could not be analyzed]`;
      }
    }

    // Build conversation
    const msgs = [{ role: 'system', content: sysPrompt }];
    if (greeting) msgs.push({ role: 'assistant', content: greeting });
    for (const m of sanitizedHistory) msgs.push(m);
    msgs.push({ role: 'user', content: userContent });

    // Call main roleplay model
    const model = env.CF_MODEL || '@cf/qwen/qwen2.5-coder-32b-instruct';

    const aiResp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.CF_AUTH_TOKEN}`,
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
      return json({ error: 'AI request failed' }, 502);
    }

    // Streaming response
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
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';

          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data: ')) continue;
            const payload = t.slice(6);
            if (payload === '[DONE]') continue;
            try {
              const chunk = JSON.parse(payload);
              const content = chunk?.choices?.[0]?.delta?.content || '';
              if (content) {
                await writer.write(encoder.encode(`data: ${JSON.stringify({ content })}\n\n`));
              }
            } catch {}
          }
        }
        await writer.write(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
      } catch (e) {
        try {
          await writer.write(encoder.encode(`data: ${JSON.stringify({ error: e.message })}\n\n`));
        } catch {}
      } finally {
        try { await writer.close(); } catch {}
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