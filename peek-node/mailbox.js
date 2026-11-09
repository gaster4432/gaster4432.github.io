// ==========================================
// Peek signaling mailbox v4 — room logic, no HTTP in here.
// Server-issued codes, pre-deposited offers, and one viewer per room.
// Each explicit join owns a negotiation; late messages from an old call
// cannot change its replacement. Media still flows directly over WebRTC.
// ==========================================

import crypto from 'node:crypto';

export const PROTOCOL_VERSION = 4;
export const FRESH_MS = 40000;
export const PARK_MS = 15000;
export const CODE_RE = /^[A-Z0-9]{4,10}$/;
export const MAX_SDP_CHARS = 65536;

const ROOM_IDLE_MS = 2 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const VALID_TYPES = new Set(['offer', 'answer', 'ice', 'bye']);
const rooms = new Map();
const ok = data => ({ status: 200, data: { ok: true, ...data } });
const fail = (error, status = 409) => ({ status, data: { error } });

function roomLog(code, event) {
  console.log(`[${new Date().toISOString()}] ${code}: ${event}`);
}

function wake(room, role) {
  for (const done of room.waiters[role]) done();
}

function dropRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  rooms.delete(code);
  wake(room, 'host');
  wake(room, 'joiner');
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - Math.max(room.hostSeen, room.joinerSeen) > ROOM_IDLE_MS) dropRoom(code);
  }
}, 60000).unref();

export function createRoom(sid) {
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  } while (rooms.has(code));
  rooms.set(code, {
    hostSid: sid, hostSeen: Date.now(), joinerSid: null, joinerSeen: 0,
    attempt: null, negotiation: 0, everJoined: false,
    offer: null, answered: false, answer: null,
    hostIce: [], joinerIce: [],
    waiters: { host: new Set(), joiner: new Set() },
    polls: { host: null, joiner: null },
  });
  roomLog(code, 'host claimed — code issued by server');
  return ok({ code, negotiation: 0, protocol: PROTOCOL_VERSION });
}

function resetNegotiation(room) {
  room.negotiation++;
  room.offer = null;
  room.answered = false;
  room.answer = null;
  room.hostIce = [{ t: 'ready', negotiation: room.negotiation }];
  room.joinerIce = [];
  wake(room, 'host');
  wake(room, 'joiner');
}

export function handleAction(code, role, sid, body) {
  const room = rooms.get(code);
  if (!room) return fail(role === 'host' ? 'unknown_host' : 'no_host', 404);
  if (!body || typeof body !== 'object') return fail('bad_action', 400);
  const now = Date.now();

  if (role === 'host' && room.hostSid !== sid) return fail('not_host', 403);

  if (body.a === 'join') {
    if (role !== 'joiner') return fail('not_joiner', 403);
    if (now - room.hostSeen > FRESH_MS) return fail('no_host', 404);
    if (typeof body.attempt !== 'string' || !/^[a-zA-Z0-9_-]{8,48}$/.test(body.attempt)) {
      return fail('bad_request', 400);
    }
    if (room.joinerSid && room.joinerSid !== sid && now - room.joinerSeen < FRESH_MS) {
      return fail('room_full');
    }
    if (room.joinerSid !== sid || room.attempt !== body.attempt) {
      if (room.everJoined) resetNegotiation(room);
      room.joinerSid = sid;
      room.attempt = body.attempt;
      room.everJoined = true;
      roomLog(code, `joiner joined — negotiation ${room.negotiation}`);
      wake(room, 'joiner');
    }
    room.joinerSeen = now;
    return ok({ negotiation: room.negotiation, protocol: PROTOCOL_VERSION });
  }

  if (role === 'joiner' && (room.joinerSid !== sid || room.attempt !== body.attempt)) {
    return fail('unknown_joiner', 403);
  }

  if (body.a === 'close') {
    if (role !== 'host') return fail('not_host', 403);
    roomLog(code, 'closed by host');
    dropRoom(code);
    return ok();
  }

  if (body.a === 'leave') {
    if (role !== 'joiner') return fail('not_joiner', 403);
    if (body.negotiation !== room.negotiation) return fail('stale_negotiation');
    room.joinerSid = null;
    room.attempt = null;
    room.joinerSeen = 0;
    room.answer = null;
    room.hostIce = [{ t: 'bye', negotiation: room.negotiation }];
    room.joinerIce = [];
    wake(room, 'host');
    wake(room, 'joiner');
    roomLog(code, 'viewer left');
    return ok();
  }

  if (body.a === 'ack') {
    if (role !== 'host') return fail('not_host', 403);
    if (body.negotiation !== room.negotiation) return fail('stale_negotiation');
    room.answer = null;
    room.hostSeen = now;
    return ok();
  }

  if (body.a !== 'message') return fail('bad_action', 400);
  const msg = body.msg;
  if (!msg || !VALID_TYPES.has(msg.t)) return fail('bad_message', 400);
  if (msg.negotiation !== room.negotiation) return fail('stale_negotiation');
  if (msg.t === 'offer' && role !== 'host') return fail('not_host', 403);
  if (msg.t === 'answer' && role !== 'joiner') return fail('not_joiner', 403);
  if (JSON.stringify(msg).length > MAX_SDP_CHARS) return fail('too_big', 413);
  if ((msg.t === 'offer' || msg.t === 'answer') &&
      (!msg.data || msg.data.type !== msg.t || typeof msg.data.sdp !== 'string' || !msg.data.sdp)) {
    return fail('bad_message', 400);
  }
  if (msg.t === 'ice' && (!msg.data || typeof msg.data.candidate !== 'string')) {
    return fail('bad_message', 400);
  }
  if (role === 'host') room.hostSeen = now;
  else room.joinerSeen = now;

  switch (msg.t) {
    case 'offer':
      room.offer = msg.data;
      room.answered = false;
      room.answer = null;
      wake(room, 'joiner');
      break;
    case 'answer':
      room.answer = msg.data;
      room.answered = true;
      wake(room, 'host');
      break;
    case 'ice':
      if (role === 'host') { room.joinerIce.push(msg); wake(room, 'joiner'); }
      else { room.hostIce.push(msg); wake(room, 'host'); }
      break;
    case 'bye':
      if (role === 'host') dropRoom(code);
      else return handleAction(code, role, sid, { a: 'leave', attempt: body.attempt, negotiation: msg.negotiation });
      break;
  }
  roomLog(code, `${role} → ${msg.t} (${room.negotiation})`);
  return ok();
}

function drain(room, role) {
  const msgs = [];
  // Keep SDP until the receiving side confirms it. A lost poll response
  // must not permanently lose an offer or answer.
  if (role === 'host' && room.answer) {
    msgs.push({ t: 'answer', data: room.answer, negotiation: room.negotiation });
  } else if (role === 'joiner' && room.offer && !room.answered) {
    msgs.push({ t: 'offer', data: room.offer, negotiation: room.negotiation });
  }
  const queue = role === 'host' ? room.hostIce : room.joinerIce;
  msgs.push(...queue.splice(0));
  return msgs;
}

function park(room, role, signal) {
  return new Promise(resolve => {
    const timer = setTimeout(done, PARK_MS);
    function done() {
      clearTimeout(timer);
      room.waiters[role].delete(done);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    room.waiters[role].add(done);
    signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
  });
}

export async function poll(code, role, sid, attempt = null, signal) {
  const room = rooms.get(code);
  if (!room) return fail(role === 'host' ? 'unknown_host' : 'no_host', 404);
  if (signal?.aborted) return fail('cancelled', 499);
  if (role === 'host' && room.hostSid !== sid) return fail('unknown_host', 403);
  if (role === 'joiner' && (room.joinerSid !== sid || room.attempt !== attempt)) {
    return fail('unknown_joiner', 403);
  }
  const token = {};
  // Only an admitted peer can replace its previous poll.
  wake(room, role);
  room.polls[role] = token;
  function invalid() {
    if (signal?.aborted) return fail('cancelled', 499);
    if (rooms.get(code) !== room) return fail(role === 'host' ? 'unknown_host' : 'no_host', 404);
    if (room.polls[role] !== token) return fail('poll_replaced');
    if (role === 'host' && room.hostSid !== sid) return fail('unknown_host', 403);
    if (role === 'joiner') {
      if (room.joinerSid !== sid || room.attempt !== attempt) return fail('unknown_joiner', 403);
      if (Date.now() - room.hostSeen > FRESH_MS) return fail('no_host', 404);
    }
    return null;
  }
  try {
    let error = invalid();
    if (error) return error;
    if (role === 'host') room.hostSeen = Date.now();
    else room.joinerSeen = Date.now();
    const generation = room.negotiation;
    let msgs = drain(room, role);
    if (!msgs.length) {
      await park(room, role, signal);
      error = invalid();
      if (error) return error;
      if (role === 'joiner' && generation !== room.negotiation) return fail('stale_negotiation');
      msgs = drain(room, role);
    }
    return { status: 200, data: { t: 'messages', msgs, negotiation: room.negotiation } };
  } finally {
    if (room.polls[role] === token) room.polls[role] = null;
  }
}
