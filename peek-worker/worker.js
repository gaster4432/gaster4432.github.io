// ==========================================
// Peek — WebRTC signaling relay
//
// Screen media never touches this worker. It pairs exactly two browsers per
// room code and ferries offer/answer/ICE text between them over WebSockets;
// the video itself flows peer-to-peer after the STUN handshake.
//
// The WebSocket Hibernation API is used so an idle waiting room costs
// nothing: the DO sleeps, sockets stay attached, and messages wake it.
// ==========================================

const CODE_RE = /^[A-Z0-9]{4,10}$/;
const MAX_MSG_CHARS = 65536;

// Public STUN only. If both peers ever sit behind carrier-grade NAT and the
// connection stalls, add a TURN service here — the client already reads
// whatever this endpoint returns.
const ICE_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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
  constructor(state, env) {
    this.ctx = state;
  }

  otherRole(role) {
    return role === "host" ? "joiner" : "host";
  }

  peerSocket(role) {
    return this.ctx.getWebSockets(this.otherRole(role))[0] || null;
  }

  roleOf(ws) {
    try {
      return (ws.serializeAttachment() || {}).role || null;
    } catch {
      return null;
    }
  }

  acceptAndClose(ws, code, reason) {
    // Accepting first lets the browser see the real close code instead of a
    // generic 1006, so the UI can say "no room with that code".
    this.ctx.acceptWebSocket(ws, ["rejected"]);
    ws.close(code, reason);
    return new Response(null, { status: 101, webSocket: ws });
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ error: "websocket_required" }, 426);
    }

    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    const code = url.searchParams.get("code") || "";

    if (role !== "host" && role !== "joiner") return json({ error: "bad_role" }, 400);
    if (!CODE_RE.test(code)) return json({ error: "bad_code" }, 400);

    const pair = new WebSocketPair();

    // One host, one joiner, nothing else. A joiner reaching an empty room
    // gets a distinctive close code the client can explain.
    if (role === "host" && this.ctx.getWebSockets("host").length > 0) {
      return this.acceptAndClose(pair[1], 4409, "host_already");
    }
    if (role === "joiner" && this.ctx.getWebSockets("host").length === 0) {
      return this.acceptAndClose(pair[1], 4404, "no_such_room");
    }
    if (role === "joiner" && this.ctx.getWebSockets("joiner").length > 0) {
      return this.acceptAndClose(pair[1], 4409, "room_full");
    }

    this.ctx.acceptWebSocket(pair[1], [role]);
    pair[1].serializeAttachment({ role });

    if (role === "host") {
      pair[1].send(JSON.stringify({ t: "host_ok", code }));
    } else {
      const peer = this.peerSocket(role);
      if (peer) {
        try {
          peer.send(JSON.stringify({ t: "peer_joined" }));
        } catch {
          // The host socket vanished between check and send; the close
          // handler will sort the room out.
        }
      }
    }

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Everything the peers send is opaque signaling text — relayed verbatim.
  // No validation beyond size, because the peer's browser is the validator.
  webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > MAX_MSG_CHARS) return;
    try {
      if (JSON.parse(message).t === "ping") return; // keepalive, not relayable
    } catch {
      return;
    }
    const peer = this.peerSocket(this.roleOf(ws));
    if (peer) {
      try {
        peer.send(message);
      } catch {
        // Peer went away mid-relay; its close event handles cleanup.
      }
    }
  }

  webSocketClose(ws) {
    const role = this.roleOf(ws);
    const peer = role ? this.peerSocket(role) : null;
    if (peer) {
      try {
        peer.send(JSON.stringify({ t: "peer_left" }));
      } catch {}
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/ws") {
      const id = env.ROOMS.idFromName(url.searchParams.get("code") || "");
      return env.ROOMS.get(id).fetch(request);
    }

    if (url.pathname === "/ice") {
      return json({ iceServers: ICE_SERVERS });
    }

    return json({ ok: true, service: "peek-signal" });
  },
};
