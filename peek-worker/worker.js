// ==========================================
// Peek — WebRTC signaling mailbox
//
// The entire job: host registers a code, joiner drops a complete offer in
// the mailbox, host drops a complete answer back. Both blobs carry their
// ICE candidates inline (non-trickle), so after two deliveries the worker
// is never contacted again — video flows peer-to-peer.
//
// "Waiting" costs nothing: the host holds ONE long-poll request open and
// the DO answers it the moment the joiner's offer lands. No intervals, no
// keepalives, no WebSockets. When both sides stop talking the DO is evicted
// and the room ceases to exist, which is exactly the desired lifetime.
// ==========================================

const FRESH_MS = 6000;   // a slot is "taken" while its owner touched it this recently
const PARK_MS = 20000;   // max time a long-poll waits before saying "nothing yet"

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

export class Room {
  constructor(state) {
    this.reset();
  }

  reset() {
    this.room = {
      hostSid: null, hostSeen: 0,
      joinerSid: null, joinerSeen: 0,
      offer: null, answer: null,
      waiters: new Set(),
    };
  }

  /** Resolve every parked long-poll; they re-check the mailbox themselves. */
  wake() {
    for (const resolve of this.room.waiters) resolve();
    this.room.waiters.clear();
  }

  park() {
    return new Promise((resolve) => {
      this.room.waiters.add(resolve);
      setTimeout(resolve, PARK_MS);
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    const sid = String(url.searchParams.get("sid") || "").slice(0, 48);
    if ((role !== "host" && role !== "joiner") || !sid) {
      return json({ error: "bad_request" }, 400);
    }

    const R = this.room;
    const now = Date.now();

    /* ── deliveries ── */
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const data = JSON.stringify(body.data ?? "");
      if (data.length > MAX_SDP_CHARS) return json({ error: "too_big" }, 413);

      if (body.a === "create") {
        // A fresh different host may take over (host refreshed the tab);
        // a live one may not (two host tabs open).
        if (R.hostSid && R.hostSid !== sid && now - R.hostSeen < FRESH_MS) {
          return json({ error: "host_already" }, 409);
        }
        const reclaim = R.hostSid !== sid;
        this.reset();
        R.hostSid = sid;
        R.hostSeen = now;
        return json({ ok: true, reclaimed: reclaim });
      }

      if (body.a === "offer") {
        if (!R.hostSid || now - R.hostSeen > FRESH_MS) return json({ error: "no_host" }, 404);
        if (R.joinerSid && R.joinerSid !== sid && now - R.joinerSeen < FRESH_MS) {
          return json({ error: "room_full" }, 409);
        }
        R.joinerSid = sid;
        R.joinerSeen = now;
        R.offer = body.data;
        R.answer = null; // a new offer invalidates any stale answer
        R.hostSeen = Math.max(R.hostSeen, 0);
        this.wake();
        return json({ ok: true });
      }

      if (body.a === "answer") {
        if (R.hostSid !== sid) return json({ error: "not_host" }, 403);
        R.hostSeen = now;
        R.answer = body.data;
        this.wake();
        return json({ ok: true });
      }

      if (body.a === "close") {
        this.reset();
        return json({ ok: true });
      }

      return json({ error: "bad_action" }, 400);
    }

    /* ── long-poll ── */
    if (role === "host") {
      if (R.hostSid !== sid) return json({ error: "unknown_host" }, 404);
      R.hostSeen = now;
      if (R.offer) {
        const offer = R.offer;
        R.offer = null;
        return json({ t: "offer", data: offer });
      }
      await this.park();
      if (R.offer) {
        const offer = R.offer;
        R.offer = null;
        return json({ t: "offer", data: offer });
      }
      return json({ t: "continue" });
    }

    // joiner
    if (!R.hostSid || now - R.hostSeen > FRESH_MS) return json({ error: "no_host" }, 404);
    if (R.joinerSid && R.joinerSid !== sid) return json({ error: "unknown_joiner" }, 404);
    R.joinerSeen = now;
    if (R.answer) {
      const answer = R.answer;
      R.answer = null;
      return json({ t: "answer", data: answer });
    }
    await this.park();
    if (R.answer) {
      const answer = R.answer;
      R.answer = null;
      return json({ t: "answer", data: answer });
    }
    return json({ t: "continue" });
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
