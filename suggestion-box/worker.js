// ==========================================
// Suggestion Box Worker
// ==========================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/suggestions' && request.method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT id, text, created_at FROM suggestions ORDER BY created_at DESC'
      ).all();
      return json({ suggestions: results || [] });
    }

    if (url.pathname === '/api/suggestions' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch (e) { return json({ error: 'invalid JSON' }, 400); }
      const text = cleanStr(body.text, 2000);
      if (!text) return json({ error: 'text required' }, 400);
      const id = 'sug_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      await env.DB.prepare('INSERT INTO suggestions (id, text) VALUES (?, ?)').bind(id, text).run();
      const row = await env.DB.prepare('SELECT id, text, created_at FROM suggestions WHERE id = ?').bind(id).first();
      return json({ suggestion: row }, 201);
    }

    const m = url.pathname.match(/^\/api\/suggestions\/([\w-]+)$/);
    if (m && request.method === 'DELETE') {
      const id = m[1];
      const existing = await env.DB.prepare('SELECT id FROM suggestions WHERE id = ?').bind(id).first();
      if (!existing) return json({ error: 'not found' }, 404);
      await env.DB.prepare('DELETE FROM suggestions WHERE id = ?').bind(id).run();
      return json({ success: true });
    }

    return json({ error: 'Not found' }, 404);
  },
};