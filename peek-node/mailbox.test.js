import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, handleAction, poll, FRESH_MS } from './mailbox.js';

const sdp = (type, negotiation = 0) => ({ t: type, negotiation, data: { type, sdp: 'v=0\r\n' } });
const ice = negotiation => ({ t: 'ice', negotiation, data: { candidate: 'candidate:test', sdpMid: '0' } });
function room() { return createRoom('host').data.code; }
function action(code, role, sid, a, extra = {}) { return handleAction(code, role, sid, { a, ...extra }); }
function join(code, attempt = 'attempt001', sid = 'viewer') {
  return action(code, 'joiner', sid, 'join', { attempt });
}
function message(code, role, msg, attempt = 'attempt001', sid = role === 'host' ? 'host' : 'viewer') {
  return action(code, role, sid, 'message', { attempt, msg });
}
function close(code) { action(code, 'host', 'host', 'close'); }

test('first join gets pre-deposited offer and SDP survives a lost response', async () => {
  const code = room();
  assert.equal(message(code, 'host', sdp('offer')).status, 200);
  assert.equal(join(code).data.negotiation, 0);
  assert.equal((await poll(code, 'joiner', 'viewer', 'attempt001')).data.msgs[0].t, 'offer');
  assert.equal((await poll(code, 'joiner', 'viewer', 'attempt001')).data.msgs[0].t, 'offer');
  assert.equal(message(code, 'joiner', sdp('answer')).status, 200);
  assert.equal((await poll(code, 'host', 'host')).data.msgs[0].t, 'answer');
  assert.equal(action(code, 'host', 'host', 'ack', { negotiation: 0 }).status, 200);
  close(code);
});

test('same-tab retry is explicit and idempotent, old ICE cannot enter new call', async () => {
  const code = room();
  message(code, 'host', sdp('offer'));
  join(code);
  message(code, 'host', ice(0));
  assert.equal(join(code, 'attempt002').data.negotiation, 1);
  assert.equal(join(code, 'attempt002').data.negotiation, 1);
  assert.equal(message(code, 'host', ice(0)).data.error, 'stale_negotiation');
  assert.equal(message(code, 'joiner', sdp('answer'), 'attempt001').data.error, 'unknown_joiner');
  assert.deepEqual((await poll(code, 'host', 'host')).data.msgs, [{ t: 'ready', negotiation: 1 }]);
  message(code, 'host', sdp('offer', 1));
  const reply = await poll(code, 'joiner', 'viewer', 'attempt002');
  assert.deepEqual(reply.data.msgs.map(m => m.t), ['offer']);
  close(code);
});

test('leave releases seat and new viewer gets a fresh negotiation immediately', async () => {
  const code = room();
  join(code);
  assert.equal(action(code, 'joiner', 'viewer', 'leave', { attempt: 'attempt001', negotiation: 0 }).status, 200);
  assert.equal(join(code, 'attempt003', 'viewer2').data.negotiation, 1);
  assert.equal((await poll(code, 'host', 'host')).data.msgs[0].t, 'ready');
  close(code);
});

test('heartbeat protects a connected seat beyond its original freshness deadline', async () => {
  const original = Date.now;
  let now = original();
  Date.now = () => now;
  const code = room();
  try {
    join(code);
    for (let i = 0; i < 4; i++) {
      now += FRESH_MS / 2;
      message(code, 'host', ice(0));
      await poll(code, 'joiner', 'viewer', 'attempt001');
    }
    assert.equal(join(code, 'attempt004', 'viewer2').data.error, 'room_full');
    now += FRESH_MS + 1;
    message(code, 'host', ice(0));
    assert.equal(join(code, 'attempt004', 'viewer2').data.negotiation, 1);
  } finally { Date.now = original; close(code); }
});

test('aborted polls do not consume an answer or prevent the next poll', async () => {
  const code = room(); join(code);
  const controller = new AbortController();
  const parked = poll(code, 'host', 'host', null, controller.signal);
  controller.abort();
  message(code, 'joiner', sdp('answer'));
  assert.equal((await parked).data.error, 'cancelled');
  assert.equal((await poll(code, 'host', 'host')).data.msgs[0].t, 'answer');
  close(code);
});

test('closing a room wakes parked viewers with no_host instead of an empty success', async () => {
  const code = room(); join(code);
  const parked = poll(code, 'joiner', 'viewer', 'attempt001');
  close(code);
  assert.equal((await parked).data.error, 'no_host');
  assert.equal(action(code, 'host', 'host', 'create').data.error, 'unknown_host');
});

test('ownership, SDP shape, and nonexistent rooms are checked', () => {
  const code = room(); join(code);
  assert.equal(action(code, 'host', 'impostor', 'close').data.error, 'not_host');
  assert.equal(action(code, 'joiner', 'viewer', 'close', { attempt: 'attempt001' }).data.error, 'not_host');
  assert.equal(message(code, 'host', { t: 'offer', negotiation: 0, data: null }).data.error, 'bad_message');
  assert.equal(message(code, 'joiner', sdp('answer'), 'attempt001', 'impostor').data.error, 'unknown_joiner');
  close(code);
  assert.equal(join(code).data.error, 'no_host');
});

test('unauthorized polls cannot cancel an admitted viewer poll', async () => {
  const code = room(); join(code);
  const parked = poll(code, 'joiner', 'viewer', 'attempt001');
  assert.equal((await poll(code, 'joiner', 'impostor', 'attempt001')).data.error, 'unknown_joiner');
  message(code, 'host', sdp('offer'));
  assert.equal((await parked).data.msgs[0].t, 'offer');
  close(code);
});

test('superseded polls cannot drain a replacement negotiation', async () => {
  const code = room(); join(code);
  const old = poll(code, 'joiner', 'viewer', 'attempt001');
  join(code, 'attempt002');
  message(code, 'host', sdp('offer', 1));
  const next = await poll(code, 'joiner', 'viewer', 'attempt002');
  assert.equal((await old).data.error, 'poll_replaced');
  assert.equal(next.data.msgs[0].negotiation, 1);
  close(code);
});
