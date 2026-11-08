// ==========================================
// Peek signaling mailbox — the room logic, no HTTP in here.
//
// The WebRTC docs (codelab + webrtc/samples) say signaling transport is not
// specified — the only requirement is that the two peers exchange an offer,
// an answer, and ICE candidates, with the room limited to two clients
// (the codelab's created/joined/ready/full lifecycle). This mailbox does
// exactly that: each peer owns an inbox, every POST appends to the OTHER
// peer's inbox, and each GET drains it through one held-open long-poll.
//
// A long-lived Node process keeps its memory between requests, so the
// mailbox really is just a Map.
// ==========================================

export const FRESH_MS = 40000; // how long a departed peer's claim lingers
export const PARK_MS = 15000;  // max time one long-poll waits before "nothing yet"
export const CODE_RE = /^[A-Z0-9]{4,10}$/;
export const MAX_SDP_CHARS = 65536;

const ROOM_IDLE_MS = 2 * 60 * 60 * 1000; // sweep rooms nobody has touched for 2h
const SWEEP_EVERY_MS = 60000;

const VALID_TYPES = new Set(['offer', 'answer', 'ice', 'bye']);

// Handshake visibility: the container console shows the whole exchange, so
// a failed session can be diagnosed from the logs instead of guessed at.
function roomLog(code, event) {
  console.log(`[${new Date().toISOString()}] ${code}: ${event}`);
}

/** code -> room state. In-memory on purpose; a restart just means the
 *  current hosts re-share their codes. */
const rooms = new Map();

function freshRoom() {
  return {
    hostSid: null, hostSeen: 0,
    joinerSid: null, joinerSeen: 0,
    // Messages waiting FOR each role, in order.
    mail: { host: [], joiner: [] },
    waiters: new Set(), // pending long-poll resolvers
  };
}

function wake(room) {
  for (const resolve of room.waiters) resolve();
  room.waiters.clear();
}

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = freshRoom();
    rooms.set(code, room);
  }
  return room;
}

function dropRoom(code) {
  const room = rooms.get(code);
  if (room) {
    wake(room);
    rooms.delete(code);
  }
}

function otherRole(role) {
  return role === 'host' ? 'joiner' : 'host';
}

/** Periodic sweep so abandoned rooms can't accumulate. */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const lastTouched = Math.max(room.hostSeen, room.joinerSeen);
    const empty = !room.hostSid && room.mail.host.length === 0 &&
      room.mail.joiner.length === 0 && room.waiters.size === 0;
    if ((lastTouched && now - lastTouched > ROOM_IDLE_MS) || (empty && lastTouched === 0)) {
      dropRoom(code);
    }
  }
}, SWEEP_EVERY_MS).unref();

/**
 * POST actions. Returns { status, data } — pure logic, the HTTP layer just
 * serialises whatever comes back.
 */
export function handleAction(code, role, sid, body) {
  const action = body && body.a;
  const now = Date.now();

  if (action === 'create') {
    // A departed host's claim expires after FRESH_MS so a refreshed tab can
    // take the room back; a live second host may not steal it.
    const room = getRoom(code);
    if (room.hostSid && room.hostSid !== sid && now - room.hostSeen < FRESH_MS) {
      return { status: 409, data: { error: 'host_already' } };
    }
    const reclaim = !!room.hostSid && room.hostSid !== sid;
    wake(room);
    roomLog(code, `host claimed${reclaim ? ' (reclaim)' : ''}`);
    room.hostSid = sid;
    room.hostSeen = now;
    room.joinerSid = null;
    room.joinerSeen = 0;
    room.mail = { host: [], joiner: [] };
    return { status: 200, data: { ok: true, reclaimed: reclaim } };
  }

  if (action === 'message') {
    const room = getRoom(code);
    const msg = body.msg;
    if (!msg || !VALID_TYPES.has(msg.t)) return { status: 400, data: { error: 'bad_message' } };
    if (msg.t === 'offer' && role !== 'host') return { status: 403, data: { error: 'not_host' } };
    if (msg.t === 'answer' && role !== 'joiner') return { status: 403, data: { error: 'not_joiner' } };
    if (JSON.stringify(msg).length > MAX_SDP_CHARS) {
      return { status: 413, data: { error: 'too_big' } };
    }

    // Keep liveness fresh on whichever side is sending.
    if (role === 'host') room.hostSeen = now;
    else {
      room.joinerSid = sid;
      room.joinerSeen = now;
    }

    // Deliver to the other peer's inbox, in order.
    roomLog(code, `${role} → ${msg.t}`);
    room.mail[otherRole(role)].push({ t: msg.t, data: msg.data ?? null });
    wake(room);
    return { status: 200, data: { ok: true } };
  }

  if (action === 'close') {
    dropRoom(code);
    return { status: 200, data: { ok: true } };
  }

  return { status: 400, data: { error: 'bad_action' } };
}

/**
 * GET long-poll. Registers the joiner on first contact (codelab room
 * lifecycle: a fresh joiner triggers a 'ready' to the host, which answers
 * with a fresh offer) and drains that role's inbox.
 * Resolves with { status, data } — { t: 'messages', msgs: [...] }.
 */
export async function poll(code, role, sid) {
  const room = getRoom(code);
  const now = Date.now();

  if (role === 'host') {
    if (room.hostSid !== sid) return { status: 404, data: { error: 'unknown_host' } };
    room.hostSeen = now;
  } else {
    if (!room.hostSid || now - room.hostSeen > FRESH_MS) {
      return { status: 404, data: { error: 'no_host' } };
    }
    if (!room.joinerSid || room.joinerSid === sid) {
      // First contact or returning joiner.
      const isNew = room.joinerSid !== sid;
      room.joinerSid = sid;
      room.joinerSeen = now;
      if (isNew) {
        // Fresh joiner: any queued offer is for a previous session — drop it
        // so the host sends a fresh one (codelab 'ready' → caller re-offers).
        roomLog(code, 'joiner joined');
        room.mail.joiner = [];
        room.mail.host.push({ t: 'ready', data: null });
        wake(room);
      }
    } else if (now - room.joinerSeen > FRESH_MS) {
      // The previous joiner went stale — take the room over.
      room.joinerSid = sid;
      room.joinerSeen = now;
      room.mail.joiner = [];
      room.mail.host.push({ t: 'ready', data: null });
      wake(room);
    } else {
      return { status: 404, data: { error: 'unknown_joiner' } };
    }
  }

  const drain = () => {
    const msgs = room.mail[role];
    room.mail[role] = [];
    return msgs;
  };

  let msgs = drain();
  if (msgs.length === 0) {
    await park(room);
    msgs = drain();
  }
  return { status: 200, data: { t: 'messages', msgs } };
}

function park(room) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, PARK_MS);
    function done() {
      clearTimeout(timer);
      room.waiters.delete(done);
      resolve();
    }
    room.waiters.add(done);
  });
}
