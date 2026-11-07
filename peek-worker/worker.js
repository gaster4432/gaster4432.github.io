// ==========================================
// Peek — WebRTC signaling mailbox
//
// The entire job: host registers a code, joiner drops a complete offer in
// the mailbox, host drops a complete answer back. Both blobs carry their
// ICE candidates inline (non-trickle), so after two deliveries the worker
// is never contacted again — video flows peer-to-peer.
//
// STORAGE IS THE ONLY SOURCE OF TRUTH. A long-poll that waits in memory can
// miss a write delivered to a sibling instance of the same DO (observed in
// production: the parked request never saw the wake-up), so the waiting side
// polls storage itself inside one held-open request. Memory is just a cache.
// ==========================================

const FRESH_MS = 40000;  // how long a departed peer's claim lingers
const PARK_MS = 15000;   // max time one long-poll waits before answering "nothing yet"
const POLL_EVERY = 400;  // storage poll cadence inside a parked request

const CODE_RE = /^[A-Z0-9]{4,10}$/;
const MAX_SDP_CHARS = 65536;

const ICE_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Room {
  constructor(state) {
    this.ctx = state;
    this.nonce = Math.random().toString(36).slice(2, 8); // debug: instance identity
  }

  async load() {
    return (await this.ctx.storage.get("room")) || {
      hostSid: null, hostSeen: 0,
      joinerSid: null, joinerSeen: 0,
      offer: null, answer: null,
    };
  }

  /** One-shot take of this role's payload, storage first. */
  async take(role, R) {
    const key = role === "host" ? "offer" : "answer";
    if (R[key]) {
      const p = R[key];
      R[key] = null;
      await this.ctx.storage.put("room", R);
      return p;
    }
    const stored = await this.ctx.storage.get("room");
    if (stored && stored[key]) {
      const p = stored[key];
      stored[key] = null;
      await this.ctx.storage.put("room", stored);
      return p;
    }
    return null;
  }

  /** Hold the request open, watching storage, until the payload shows up. */
  async watch(role) {
    const key = role === "host" ? "offer" : "answer";
    const deadline = Date.now() + PARK_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_EVERY);
      const stored = await this.ctx.storage.get("room");
      if (stored && stored[key]) return true;
    }
    return false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    const sid = String(url.searchParams.get("sid") || "").slice(0, 48);
    if ((role !== "host" && role !== "joiner") || !sid) {
      return json({ error: "bad_request" }, 400);
    }

    const R = await this.load();
    const now = Date.now();

    /* ── deliveries ── */
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const data = body.data ?? null;
      if (data != null && JSON.stringify(data).length > MAX_SDP_CHARS) {
        return json({ error: "too_big" }, 413);
      }

      if (body.a === "create") {
        // A departed host's claim expires after FRESH_MS, so a refreshed tab
        // can take the room back; a live second host may not steal it.
        if (R.hostSid && R.hostSid !== sid && now - R.hostSeen < FRESH_MS) {
          return json({ error: "host_already" }, 409);
        }
        const reclaim = !!R.hostSid && R.hostSid !== sid;
        R.hostSid = sid;
        R.hostSeen = now;
        R.joinerSid = null;
        R.joinerSeen = 0;
        R.offer = null;
        R.answer = null;
        await this.ctx.storage.put("room", R);
        return json({ ok: true, reclaimed: reclaim, nonce: this.nonce });
      }

      if (body.a === "offer") {
        if (!R.hostSid || now - R.hostSeen > FRESH_MS) return json({ error: "no_host" }, 404);
        if (R.joinerSid && R.joinerSid !== sid && now - R.joinerSeen < FRESH_MS) {
          return json({ error: "room_full" }, 409);
        }
        R.joinerSid = sid;
        R.joinerSeen = now;
        R.offer = data;
        R.answer = null; // a new offer invalidates any stale answer
        await this.ctx.storage.put("room", R);
        return json({ ok: true, nonce: this.nonce });
      }

      if (body.a === "answer") {
        if (R.hostSid !== sid) return json({ error: "not_host" }, 403);
        R.hostSeen = now;
        R.answer = data;
        await this.ctx.storage.put("room", R);
        return json({ ok: true, nonce: this.nonce });
      }

      if (body.a === "close") {
        await this.ctx.storage.delete("room");
        return json({ ok: true, nonce: this.nonce });
      }

      return json({ error: "bad_action" }, 400);
    }

    /* ── long-poll: hold one request open, watching storage, until the
     * counterpart's blob lands (or PARK_MS passes → "try again") ── */
    if (role === "host") {
      if (R.hostSid !== sid) return json({ error: "unknown_host" }, 404);
      R.hostSeen = now;
      await this.ctx.storage.put("room", R); // refresh the claim while we wait

      let payload = await this.take(role, R);
      let polls = 0;
      if (!payload) {
        await this.watch(role);
        polls = 1;
        payload = await this.take(role, R);
      }
      if (payload) return json({ t: "offer", data: payload });
      return json({ t: "continue", polls, nonce: this.nonce });
    }

    // joiner
    if (!R.hostSid || now - R.hostSeen > FRESH_MS) return json({ error: "no_host" }, 404);
    if (R.joinerSid && R.joinerSid !== sid && now - R.joinerSeen < FRESH_MS) {
      return json({ error: "unknown_joiner" }, 404);
    }
    R.joinerSeen = now;
    await this.ctx.storage.put("room", R);

    let payload = await this.take(role, R);
    if (!payload) {
      await this.watch(role);
      payload = await this.take(role, R);
    }
    if (payload) return json({ t: "answer", data: payload });
    return json({ t: "continue", nonce: this.nonce });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/room") {
      if (!CODE_RE.test(url.searchParams.get("code") || "")) {
        return json({ error: "bad_code" }, 400);
      }
      const id = env.ROOMS.idFromName(url.searchParams.get("code"));
      return env.ROOMS.get(id).fetch(request);
    }

    if (url.pathname === "/ice") {
      return json({ iceServers: ICE_SERVERS });
    }

    return json({ ok: true, service: "peek-signal" });
  },
};
