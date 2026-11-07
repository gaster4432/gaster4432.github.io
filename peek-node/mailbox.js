// ==========================================
// Peek signaling mailbox — the room logic, no HTTP in here.
//
// A long-lived Node process keeps its memory between requests (unlike
// Workers/DOs), so the mailbox really is just a Map. The host registers a
// code, the joiner deposits a complete offer (ICE candidates inline, no
// trickle), the host deposits a complete answer back — after which the
// browser peers talk directly and this server sees nothing.
//
// Waiting is one long-poll per side, capped at PARK_MS. While a room is
// genuinely idle the server holds no connections and costs nothing.
// ==========================================

export const FRESH_MS = 40000; // how long a departed peer's claim lingers
export const PARK_MS = 15000;  // max time one long-poll waits before "nothing yet"
export const CODE_RE = /^[A-Z0-9]{4,10}$/;
export const MAX_SDP_CHARS = 65536;

const ROOM_IDLE_MS = 2 * 60 * 60 * 1000; // sweep rooms nobody has touched for 2h
const SWEEP_EVERY_MS = 60000;

/** code -> room state. In-memory on purpose; a restart just means the
 *  current hosts re-share their codes. */
const rooms = new Map();

function freshRoom() {
  return {
    hostSid: null, hostSeen: 0,
    joinerSid: null, joinerSeen: 0,
    offer: null, answer: null,
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

/** Periodic sweep so abandoned rooms can't accumulate. */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const lastTouched = Math.max(room.hostSeen, room.joinerSeen);
    const empty = !room.hostSid && !room.offer && !room.answer && room.waiters.size === 0;
    if ((lastTouched && now - lastTouched > ROOM_IDLE_MS) || (empty && lastTouched === 0)) {
      dropRoom(code);
    }
  }
}, SWEEP_EVERY_MS).unref();

/** One-shot take of this role's pending payload. */
function take(room, role) {
  const key = role === 'host' ? 'offer' : 'answer';
  if (!room[key]) return null;
  const p = room[key];
  room[key] = null;
  return p;
}

/** Long-poll: resolve as soon as the counterpart's blob lands, else PARK_MS. */
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

/**
 * POST actions. Returns { status, data } — pure logic, the HTTP layer just
 * serialises whatever comes back.
 */
export function handleAction(code, role, sid, body) {
  const action = body && body.a;
  const data = body ? body.data ?? null : null;
  if (data != null && JSON.stringify(data).length > MAX_SDP_CHARS) {
    return { status: 413, data: { error: 'too_big' } };
  }

  const room = getRoom(code);
  const now = Date.now();

  if (action === 'create') {
    // A departed host's claim expires after FRESH_MS so a refreshed tab can
    // take the room back; a live second host may not steal it.
    if (room.hostSid && room.hostSid !== sid && now - room.hostSeen < FRESH_MS) {
      return { status: 409, data: { error: 'host_already' } };
    }
    const reclaim = !!room.hostSid && room.hostSid !== sid;
    wake(room);
    room.hostSid = sid;
    room.hostSeen = now;
    room.joinerSid = null;
    room.joinerSeen = 0;
    room.offer = null;
    room.answer = null;
    return { status: 200, data: { ok: true, reclaimed: reclaim } };
  }

  if (action === 'offer') {
    if (!room.hostSid || now - room.hostSeen > FRESH_MS) return { status: 404, data: { error: 'no_host' } };
    if (room.joinerSid && room.joinerSid !== sid && now - room.joinerSeen < FRESH_MS) {
      return { status: 409, data: { error: 'room_full' } };
    }
    room.joinerSid = sid;
    room.joinerSeen = now;
    room.offer = data;
    room.answer = null; // a new offer invalidates any stale answer
    wake(room);          // the host's parked long-poll wakes NOW
    return { status: 200, data: { ok: true } };
  }

  if (action === 'answer') {
    if (room.hostSid !== sid) return { status: 403, data: { error: 'not_host' } };
    room.hostSeen = now;
    room.answer = data;
    wake(room);          // the joiner's parked long-poll wakes NOW
    return { status: 200, data: { ok: true } };
  }

  if (action === 'close') {
    dropRoom(code);
    return { status: 200, data: { ok: true } };
  }

  return { status: 400, data: { error: 'bad_action' } };
}

/**
 * GET long-poll. Resolves with { status, data } — either the awaited payload
 * or { t: 'continue' } after PARK_MS, which just means "ask again".
 */
export async function poll(code, role, sid) {
  const room = getRoom(code);
  const now = Date.now();

  if (role === 'host') {
    if (room.hostSid !== sid) return { status: 404, data: { error: 'unknown_host' } };
    room.hostSeen = now;
    let payload = take(room, role);
    if (!payload) {
      await park(room);
      payload = take(room, role);
    }
    if (payload) return { status: 200, data: { t: 'offer', data: payload } };
    return { status: 200, data: { t: 'continue' } };
  }

  // joiner
  if (!room.hostSid || now - room.hostSeen > FRESH_MS) {
    return { status: 404, data: { error: 'no_host' } };
  }
  if (room.joinerSid && room.joinerSid !== sid && now - room.joinerSeen < FRESH_MS) {
    return { status: 404, data: { error: 'unknown_joiner' } };
  }
  room.joinerSeen = now;
  let payload = take(room, role);
  if (!payload) {
    await park(room);
    payload = take(room, role);
  }
  if (payload) return { status: 200, data: { t: 'answer', data: payload } };
  return { status: 200, data: { t: 'continue' } };
}
