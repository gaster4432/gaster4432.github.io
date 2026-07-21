// ==========================================
// CF Chat Worker - Chat + Vision + Image Gen
// ==========================================

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

    const { message, character, history, image, generateImage } = await request.json();

    if (!character) {
      return json({ error: 'character required' }, 400);
    }

    // ========================
    // IMAGE GENERATION
    // ========================
    if (generateImage) {
      try {
        const resp = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.CF_AUTH_TOKEN}` },
            body: JSON.stringify({ prompt: generateImage }),
          }
        );

        if (resp.ok) {
          const buffer = await resp.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          const base64 = btoa(binary);
          return json({ image: `data:image/png;base64,${base64}` });
        }
      } catch (e) {}
      return json({ error: "Image generation failed" });
    }

    // ========================
    // CHAT + VISION
    // ========================
    if (!message) {
      return json({ error: 'message required' }, 400);
    }

    const greeting = character.greeting || '';
    let sysPrompt = (character.systemPrompt || `You are ${character.name || 'a helpful assistant'}.`)
      + `\n\nThe user can generate AI images. When they do, you'll receive the image and can describe or discuss it naturally.`;

    let userContent = message;

    // === IMAGE UNDERSTANDING ===
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
          userContent = `${message}\n\n[Image Description]: ${description}`;
        }
      } catch (e) {
        userContent = `${message}\n\n[Image could not be analyzed]`;
      }
    }

    // Build conversation
    const msgs = [{ role: 'system', content: sysPrompt }];
    if (greeting) msgs.push({ role: 'assistant', content: greeting });
    for (const m of (history || [])) msgs.push(m);
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
