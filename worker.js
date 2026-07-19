// ─── CF Chat Worker — Chat Proxy Only ───
// Credentials are stored as encrypted Worker secrets (Settings > Variables > Add secret)
// No KV needed. No auth needed. Frontend handles everything in localStorage.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/api/chat' || request.method !== 'POST') {
      return json({ error: 'Not found' }, 404);
    }

    const { message, character, history } = await request.json();
    if (!message || !character) {
      return json({ error: 'message and character required' }, 400);
    }

    const greeting = character.greeting || '';
    const sysPrompt = character.systemPrompt || `You are ${character.name || 'a helpful assistant'}. Be helpful.`;
    const msgs = [{ role: 'system', content: sysPrompt }];
    if (greeting) msgs.push({ role: 'assistant', content: greeting });
    for (const m of (history || [])) msgs.push(m);
    msgs.push({ role: 'user', content: message });

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
      const err = await aiResp.text();
      return json({ error: `API error: ${err.slice(0, 500)}` }, 502);
    }

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
        await writer.write(encoder.encode(`data: ${JSON.stringify({ error: e.message })}\n\n`));
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
