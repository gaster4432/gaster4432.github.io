// ==========================================
// Peek signaling mailbox v3 — the room logic, no HTTP in here.
//
// The WebRTC docs (codelab + webrtc/samples) leave the signaling transport
// unspecified — the requirement is that two peers exchange an offer, an
// answer, and ICE candidates inside a two-client room.
//
// v3 model (matches how the user expects it to work):
//   - THE SERVER issues the room code; the client never invents one.
//   - The host deposits its offer immediately, before anyone joins — so a
//     joiner asking for the code receives the big SDP blob right away.
//   - ICE candidates trickle through per-role queues.
//   - Wake-ups are PER ROLE: a host action must never wake the joiner's
//     parked long-poll and vice versa (an empty wake-up would end the
//     poll prematurely).
// A long-lived Node process keeps its memory between requests, so the
// mailbox really is just a Map.
// ==========================================

import crypto from 'node:crypto';

export const FRESH_MS = 40000; // how long a departed peer's claim lingers
export const PARK_MS = 15000;  // max time one long-poll waits before "nothing yet"
export const CODE_RE = /^[A-Z0-9]{4,10}$/;
export const MAX_SDP_CHARS = 65536;

const ROOM_IDLE_MS = 2 * 60 * 60 * 1000; // sweep rooms nobody has touched for 2h
const SWEEP_EVERY_MS = 60000;

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const VALID_TYPES = new Set(['offer', 'answer', 'ice', 'bye']);

// Handshake visibility: the container console shows the whole exchange, so
// a failed session can be diagnosed from the logs instead of guessed at.
function roomLog(code, event) {
  console.log(`[${new Date().toISOString()}] ${code}: ${event}`);
}

function genCode() {
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** code -> room state. In-memory on purpose; a restart just means the
 *  current hosts re-share their codes. */
const rooms = new Map();

function freshRoom() {
  return {
    hostSid: null, hostSeen: 0,
    joinerSid: null, joinerSeen: 0,
    offer: null,    // the host's current SDP offer — a room property, not a message
    offerTo: null,  // sid the offer was last delivered to
    answer: null,   // one-shot: the joiner's answer
    hostIce: [],    // inbox: messages waiting FOR the host (ice/ready/bye)
    joinerIce: [],  // inbox: messages waiting FOR the joiner (ice/bye)
    waiters: { host: new Set(), joiner: new Set() },
  };
}

function wake(room, role) {
  for (const resolve of room.waiters[role]) resolve();
  room.waiters[role].clear();
}

function wakeAll(room) {
  wake(room, 'host');
  wake(room, 'joiner');
}

function dropRoom(code) {
  const room = rooms.get(code);
  if (room) {
    wakeAll(room);
    rooms.delete(code);
  }
}

/** Periodic sweep so abandoned rooms can't accumulate. */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const lastTouched = Math.max(room.hostSeen, room.joinerSeen);
    const empty = !room.hostSid && !room.offer && !room.answer &&
      room.hostIce.length === 0 && room.joinerIce.length === 0 &&
      room.waiters.host.size === 0 && room.waiters.joiner.size === 0;
    if ((lastTouched && now - lastTouched > ROOM_IDLE_MS) || (empty && lastTouched === 0)) {
      wakeAll(room);
      rooms.delete(code);
    }
  }
}, SWEEP_EVERY_MS).unref();

/**
 * THE SERVER issues the code. Returns { status, data } with the new code.
 */
export function createRoom(sid) {
  let code;
  do {
    code = genCode();
  } while (rooms.has(code)); // ~1e9 space — collisions practically impossible

  const room = freshRoom();
  room.hostSid = sid;
  room.hostSeen = Date.now();
  rooms.set(code, room);
  roomLog(code, 'host claimed — code issued by server');
  return { status: 200, data: { ok: true, code } };
}

/**
 * POST actions. Returns { status, data } — pure logic, the HTTP layer just
 * serialises whatever comes back.
 */
export function handleAction(code, role, sid, body) {
  const action = body && body.a;
  const room = getRoom(code);
  const now = Date.now();

  if (action === 'message') {
    const msg = body.msg;
    if (!msg || !VALID_TYPES.has(msg.t)) return { status: 400, data: { error: 'bad_message' } };
    if (msg.t === 'offer' && role !== 'host') return { status: 403, data: { error: 'not_host' } };
    if (msg.t === 'answer' && role !== 'joiner') return { status: 403, data: { error: 'not_joiner' } };
    if (JSON.stringify(msg).length > MAX_SDP_CHARS) {
      return { status: 413, data: { error: 'too_big' } };
    }

    if (role === 'host') room.hostSeen = now;
    else {
      room.joinerSid = sid;
      room.joinerSeen = now;
    }

    switch (msg.t) {
      case 'offer':
        // Fresh offer replaces any old one and is (re)delivered to the joiner.
        room.offer = msg.data ?? null;
        room.offerTo = null;
        room.answer = null; // a new offer invalidates any stale answer
        roomLog(code, 'host → offer');
        wake(room, 'joiner');
        break;
      case 'answer':
        room.answer = msg.data ?? null;
        roomLog(code, 'joiner → answer');
        wake(room, 'host');
        break;
      case 'ice':
        if (role === 'host') {
          room.joinerIce.push({ t: 'ice', data: msg.data ?? null });
          roomLog(code, 'host → ice');
          wake(room, 'joiner');
        } else {
          room.hostIce.push({ t: 'ice', data: msg.data ?? null });
          roomLog(code, 'joiner → ice');
          wake(room, 'host');
        }
        break;
      case 'bye':
        room.hostIce.push({ t: 'bye' });
        roomLog(code, 'bye');
        wake(room, 'host');
        break;
    }
    return { status: 200, data: { ok: true } };
  }

  if (action === 'close') {
    roomLog(code, 'closed by host');
    dropRoom(code);
    return { status: 200, data: { ok: true } };
  }

  return { status: 400, data: { error: 'bad_action' } };
}

/** What the HOST'S long-poll picks up: the answer (one-shot) + joiner ICE. */
function hostDrain(room) {
  const msgs = [];
  if (room.answer) {
    msgs.push({ t: 'answer', data: room.answer });
    room.answer = null;
  }
  while (room.hostIce.length) msgs.push(room.hostIce.shift());
  return msgs;
}

/** What the JOINER'S long-poll picks up: the offer (once per joiner session)
 * + host ICE. The offer is a property, so a joiner asking for the code gets
 * it immediately, even if it was deposited long before they arrived. */
function joinerDrain(room, sid, code) {
  const msgs = [];
  if (room.offer && room.offerTo !== sid) {
    msgs.push({ t: 'offer', data: room.offer });
    room.offerTo = sid;
    roomLog(code, 'offer delivered to joiner');
  }
  while (room.joinerIce.length) msgs.push(room.joinerIce.shift());
  return msgs;
}

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = freshRoom();
    rooms.set(code, room);
  }
  return room;
}

function park(room, role) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, PARK_MS);
    function done() {
      clearTimeout(timer);
      room.waiters[role].delete(done);
      resolve();
    }
    room.waiters[role].add(done);
  });
}

/**
 * GET long-poll. Registers the joiner on first contact; a joiner taking
 * over a stale seat triggers a 'ready' to the host, which re-offers.
 */
export async function poll(code, role, sid) {
  const room = getRoom(code);
  const now = Date.now();

  if (role === 'host') {
    if (room.hostSid !== sid) return { status: 404, data: { error: 'unknown_host' } };
    room.hostSeen = now;
    const drain = () => hostDrain(room);
    let msgs = drain();
    if (msgs.length === 0) {
      await park(room, role);
      msgs = drain();
    }
    return { status: 200, data: { t: 'messages', msgs } };
  }

  // joiner
  if (!room.hostSid || now - room.hostSeen > FRESH_MS) {
    return { status: 404, data: { error: 'no_host' } };
  }
  if (room.joinerSid && room.joinerSid !== sid && now - room.joinerSeen < FRESH_MS) {
    return { status: 404, data: { error: 'unknown_joiner' } };
  }
  if (room.joinerSid !== sid) {
    const takeover = !!room.joinerSid;
    room.joinerSid = sid;
    room.joinerSeen = now;
    room.answer = null;
    room.hostIce = [];
    room.offerTo = null; // re-deliver whatever offer the host posts next
    roomLog(code, takeover ? 'joiner took over the stale seat' : 'joiner joined');
    if (takeover) {
      // The host's pc1 may be mid-session with the departed joiner — ask it
      // to re-offer (codelab room lifecycle: 'ready' → caller re-offers).
      room.offer = null;
      room.hostIce.push({ t: 'ready' });
      wake(room, 'host');
    }
  } else {
    room.joinerSeen = now;
  }

  const drain = () => joinerDrain(room, sid, code);
  let msgs = drain();
  if (msgs.length === 0) {
    await park(room, role);
    msgs = drain();
  }
  return { status: 200, data: { t: 'messages', msgs } };
}
