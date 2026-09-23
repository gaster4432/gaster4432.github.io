// ==========================================
// PKAX Worker - Chat + Characters + Vision
// OpenCode model backend
// ==========================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

// --- Session ID gen for opencode free tier (fixes MissingSessionID 400) ---
// Required since 2026-09-06: pi-mono#2824, openclaw#137165, earendil-works/pi#4847
// Official CLI sends: x-opencode-client, x-opencode-session (stable per-conversation), x-opencode-project, x-opencode-request, User-Agent
function randId(len = 16) {
  try { return crypto.randomUUID().replace(/-/g, '').slice(0, len); }
  catch { return Math.random().toString(36).slice(2, 2+len).padEnd(len,'0'); }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// --- Characters: read-only ---
// Characters are managed by direct database writes.
// This API only serves them; no request can create, edit, or delete them.

async function handleCharacters(request, env) {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/api/characters') {
    const { results } = await env.DB.prepare(
      'SELECT id, name, greeting, systemPrompt, avatar, created_at FROM characters ORDER BY created_at ASC'
    ).all();

    return json({ characters: results || [] });
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
      history
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

    const sysPromptWithReasoning = sysPrompt;

    let userContent = message;

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
    // OPENCODE ZEN — official endpoint + exact CLI fingerprint + optional API key
    // Endpoint: https://opencode.ai/zen/v1/chat/completions (per https://opencode.ai/docs/zen/)
    // Free-tier gate is User-Agent based: must be exactly `opencode/<version>`
    // (gateway strips x-opencode-* but passes User-Agent through).
    // Anonymous free pool now 403s with FreeTierError outside the official
    // client — set OPENCODE_API_KEY secret (Zen API key) to authenticate.
    // ==========================================

    const PRIMARY_MODEL = 'ling-3.0-flash-fin-free';
    const FALLBACK_MODELS = ['big-pickle', 'mimo-v2.5-free', 'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free'];
    const CANDIDATES = [PRIMARY_MODEL, ...FALLBACK_MODELS];
    const MAX_ATTEMPTS = 6; // covers streaks of up to 10 when combined with frontend retry
    const BASE_DELAY_MS = 450;
    const ZEN_URL = 'https://opencode.ai/zen/v1/chat/completions';
    const OPENCODE_UA = 'opencode/1.3.15';
    const ZEN_KEY = (env.OPENCODE_API_KEY || env.ZEN_API_KEY || '').trim();

    function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
    function isRetryable(status, text){
      // 403 FreeTierError is NOT retryable — retrying just burns quota.
      // Frontend only retries Worker 429/5xx, so returning upstream 403 stops the 5x hammer.
      if (status === 403) return false;
      if (text && text.includes('FreeTierError')) return false;
      return status===429 || status===500 || status===502 || status===503 || status===504
        || (text && (text.includes('FreeUsageLimitError') || text.includes('Rate limit') || text.includes('server_error') || text.includes('Internal') || text.includes('overloaded') || text.includes('temporarily unavailable')));
    }

    let aiResp = null;
    let lastErrorText = '';
    let lastStatus = 0;
    let modelUsed = PRIMARY_MODEL;

    for(let attempt=0; attempt<MAX_ATTEMPTS; attempt++){
      const tryModel = CANDIDATES[attempt % CANDIDATES.length];
      modelUsed = tryModel;
      const sessionId = randId(24);
      const projectId = randId(24);
      const requestId = randId(16);

      try{
        const controller = new AbortController();
        const timeout = setTimeout(()=> controller.abort(), 20000);
        const headers = {
          'Content-Type': 'application/json',
          'x-opencode-client': 'cli',
          'x-opencode-session': sessionId,
          'x-opencode-project': projectId,
          'x-opencode-request': requestId,
          'User-Agent': OPENCODE_UA,
        };
        if (ZEN_KEY) headers['Authorization'] = `Bearer ${ZEN_KEY}`;
        const r = await fetch(
          ZEN_URL,
          {
            method: 'POST',
            signal: controller.signal,
            headers,
            body: JSON.stringify({
              model: tryModel,
              messages: msgs,
              stream: true,
              max_tokens: 2048,
              temperature: 0.7,
              stream_options: { include_usage: true },
            }),
          }
        );
        clearTimeout(timeout);
        if(r.ok){ aiResp=r; break; }
        lastErrorText = await r.text().catch(()=>'');
        lastStatus = r.status;
        console.error(`[Worker attempt ${attempt+1}/${MAX_ATTEMPTS}] ${tryModel} ${r.status}: ${lastErrorText.slice(0,400)}`);
        if(!isRetryable(r.status, lastErrorText)){
          aiResp=r; break;
        }
      } catch(e){
        lastErrorText = e?.message || String(e);
        lastStatus = 0;
        console.error(`[Worker attempt ${attempt+1}/${MAX_ATTEMPTS}] ${tryModel} exception: ${lastErrorText}`);
      }
      if(attempt < MAX_ATTEMPTS-1){
        // exponential backoff with jitter: 450ms * 1.8^attempt, capped 7s
        const delay = Math.min(7000, BASE_DELAY_MS * Math.pow(1.8, attempt) + Math.random()*400);
        await sleep(delay);
      }
    }

    if(!aiResp || !aiResp.ok){
      console.error('OpenCode all retries failed:', lastStatus, lastErrorText);
      // 403 FreeTierError = anonymous free pool blocked outside official client.
      // Return 403 (not 502) so the frontend does NOT retry 5x — retrying can't help.
      if (lastStatus === 403 || lastErrorText.includes('FreeTierError')) {
        return json({ error: 'OpenCode free tier blocked for outside clients (403 FreeTierError). Add a Zen API key as OPENCODE_API_KEY secret: wrangler secret put OPENCODE_API_KEY --cwd cf', status: 403, details: lastErrorText.slice(0,800), modelTried: modelUsed }, 403);
      }
      // Return retryable 502 so frontend can also retry with backoff (covers streaks > MAX_ATTEMPTS when combined)
      return json({ error: 'AI request failed after retries', status: lastStatus || 502, details: lastErrorText.slice(0,800), modelTried: modelUsed }, 502);
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
              const choice = chunk?.choices?.[0];

              // Reasoning (provider streams thinking separately) — handle all variants
              const reasoningRaw = delta?.reasoning_content ?? delta?.reasoning ?? delta?.thinking ?? choice?.reasoning ?? chunk?.reasoning ?? null;
              let reasoning = null;
              if (reasoningRaw) {
                reasoning = typeof reasoningRaw === 'string' ? reasoningRaw : (reasoningRaw.text ?? reasoningRaw.content ?? JSON.stringify(reasoningRaw));
              }
              // reasoning_details array variant
              if (delta?.reasoning_details && Array.isArray(delta.reasoning_details)) {
                for (const d of delta.reasoning_details) {
                  const t = d.text || d.content || '';
                  if (t) {
                    fullReasoning += t;
                    await writer.write(encoder.encode(`data: ${JSON.stringify({ reasoning: t })}\n\n`));
                  }
                }
              }
              if (reasoning) {
                fullReasoning += reasoning;
                await writer.write(encoder.encode(`data: ${JSON.stringify({ reasoning })}\n\n`));
              }

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

              // Also forward tool_calls if present (for MCP-like tools)
              if (delta?.tool_calls) {
                await writer.write(encoder.encode(`data: ${JSON.stringify({ tool_calls: delta.tool_calls })}\n\n`));
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