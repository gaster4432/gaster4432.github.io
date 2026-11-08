// ==========================================
// Peek signaling server — HTTP plumbing only; the logic lives in mailbox.js.
//
// Zero dependencies: node:http / node:https + the mailbox. Run plain for
// local testing, or with TLS env vars once a cert exists (see README —
// DuckDNS + DNS-01 is the way when only one non-standard port is open):
//
//   PORT=25789 TLS_KEY=./key.pem TLS_CERT=./fullchain.pem node server.js
// ==========================================

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleAction, poll, CODE_RE, MAX_SDP_CHARS } from './mailbox.js';

const PORT = Number(process.env.PORT || 25789);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = MAX_SDP_CHARS + 4096; // SDP blob plus JSON wrapper slack

// TLS cert auto-detection: explicit env vars win; otherwise look next to
// server.js and in the working directory. acme.sh's --install-cert drops
// key.pem + fullchain.pem there and TLS turns on by itself — no custom env
// vars needed, which panel eggs make awkward.
const HERE = path.dirname(fileURLToPath(import.meta.url));
function firstExisting(candidates) {
  for (const c of candidates) {
    if (!c) continue;
    try { fs.accessSync(c); return c; } catch { /* try next */ }
  }
  return '';
}
const TLS_KEY = process.env.TLS_KEY
  || firstExisting([path.join(HERE, 'key.pem'), path.join(process.cwd(), 'key.pem')]);
const TLS_CERT = process.env.TLS_CERT
  || firstExisting([path.join(HERE, 'fullchain.pem'), path.join(HERE, 'cert.pem'),
    path.join(process.cwd(), 'fullchain.pem'), path.join(process.cwd(), 'cert.pem')]);

// STUN alone can't crack every NAT pair — symmetric NAT / CGNAT (common on
// rural ISPs) defeats it, and the direct peer link fails even though the
// signaling worked. When TURN credentials are configured below, relayed
// candidates become a guaranteed fallback: media only relays when the direct
// path fails. Get free TURN (Cloudflare Calls ~1TB/mo, or metered.ca) and set
// TURN_URLS / TURN_USERNAME / TURN_CREDENTIAL in the start command.
const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
if (process.env.TURN_URLS) {
  ICE_SERVERS.push({
    urls: process.env.TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean),
    username: process.env.TURN_USERNAME || '',
    credential: process.env.TURN_CREDENTIAL || '',
  });
}

// The page lives on https://gaster4432.github.io, so this API must answer
// CORS or the browser eats every request. Wide open is fine: the only thing
// behind it is a mailbox keyed by an unguessable code.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...CORS,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null); // too big — handled by the caller as a 413
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(undefined); // unparsable — 400
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'local'}`);

  if (url.pathname === '/') {
    return json(res, { ok: true, service: 'peek-signal-node' });
  }

  if (url.pathname === '/ice') {
    return json(res, { iceServers: ICE_SERVERS });
  }

  if (url.pathname === '/room') {
    const code = url.searchParams.get('code') || '';
    const role = url.searchParams.get('role');
    const sid = String(url.searchParams.get('sid') || '').slice(0, 48);

    if (!CODE_RE.test(code)) return json(res, { error: 'bad_code' }, 400);
    if ((role !== 'host' && role !== 'joiner') || !sid) {
      return json(res, { error: 'bad_request' }, 400);
    }

    if (req.method === 'GET') {
      const out = await poll(code, role, sid);
      return json(res, out.data, out.status);
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body === null) return json(res, { error: 'too_big' }, 413);
      if (body === undefined) return json(res, { error: 'invalid_json' }, 400);
      const out = handleAction(code, role, sid, body);
      return json(res, out.data, out.status);
    }

    return json(res, { error: 'method_not_allowed' }, 405);
  }

  return json(res, { error: 'not_found' }, 404);
}

const handler = (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  route(req, res).catch((err) => {
    try { json(res, { error: 'internal' }, 500); } catch { /* socket gone */ }
    console.error('request failed:', err);
  });
};

// The server holds parked long-polls; an unhandled hiccup should not take
// every waiting host down with it. Log loudly, keep serving.
process.on('uncaughtException', (err) => console.error('uncaught exception:', err));
process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err));

const useTls = TLS_KEY && TLS_CERT;
const server = useTls
  ? https.createServer({ key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT) }, handler)
  : http.createServer(handler);

server.listen(PORT, HOST, () => {
  console.log(`peek-signal-node listening on ${HOST}:${PORT}${useTls ? ' (TLS)' : ' (plain HTTP — fine behind a TLS terminator, NOT for browser use from an https page)'}`);
  console.log('Done, the application is running');
});
