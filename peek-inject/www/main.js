'use strict';
/* Peek Remote — the share page, hosted two ways:
 *   · from the injector daemon at http://127.0.0.1:8753/  (host mode + viewer)
 *   · as the public watcher at https://gaster4432.github.io/peek-remote/watch/  (viewer only)
 * The host flow needs the daemon's localhost origin (token in <meta>) for input
 * injection; without it only watching is possible. Both directions ride the
 * same v4 mailbox + WebRTC — the signaling server never changes.
 */
const SIGNAL = 'https://peek-signal.duckdns.org:25789';
const PROTOCOL_VERSION = 4;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DAEMON = window.location.origin; // same-origin when served by the daemon
const TOKEN = (document.querySelector('meta[name="peek-token"]')?.content || '').trim();
const CAN_INJECT = TOKEN.length > 0 && TOKEN !== '__PEEK_TOKEN__';
const $ = id => document.getElementById(id);
const CAPPY = 'cappy.wav';
function playCappy() { try { new Audio(CAPPY).play().catch(() => {}); } catch {} }
function playBlip() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
    const ctx = new Ctx(); const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(220, ctx.currentTime + 0.16);
    g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.2);
  } catch {}
}
const remoteVideo = $('remoteVideo');
const controlReqBtn = $('controlReqBtn');
const playOverlay = $('playOverlay');
const controlChip = $('controlChip');
const mySid = genSid();
let session = null;
let hostStarting = false;
let wantingControl = false;
let hostAllowed = false;
const hostCtl = { gate: false, grabbed: false };

const ERRORS = {
  no_host: 'No room with that code — the share may have stopped.',
  room_full: 'That room already has a viewer.',
  unknown_host: 'Room expired or the server restarted — stop and start sharing for a new code.',
  unknown_joiner: 'This viewer session was replaced — retry.',
  not_host: 'Host session mismatch — start sharing again.',
  not_joiner: 'Viewer session mismatch — retry.',
  stale_negotiation: 'The connection changed — retry.',
  network: 'Could not reach the signaling server.',
  protocol_mismatch: 'The page and signaling server need the same Peek update.',
  bad_code: 'That code looks off — it is 6 letters/numbers.',
};

function genSid() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
}
function current(s) { return session === s && !s.controller.signal.aborted; }
function show(panel) {
  $('menu').classList.toggle('show', panel === 'menu');
  $('hostView').classList.toggle('show', panel === 'hostView');
  $('joinView').classList.toggle('show', panel === 'joinView');
}
function setStatus(el, textEl, text, cls) {
  textEl.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
  el.hidden = false;
}
function status(s, text, cls = 'wait') {
  if (!s || !current(s)) return;
  const prefix = s.role === 'host' ? 'host' : 'join';
  const target = s.role === 'joiner' && s.stage === 'connected' ? 'live' : prefix;
  setStatus($(target + 'Status'), $(target + 'StatusText'), text, cls);
}
function newSession(role, code) {
  return { role, code, attempt: genSid(), negotiation: 0, controller: new AbortController(),
    pc: null, dc: null, stream: null, remoteStream: new MediaStream(), ice: [], outgoingIce: [],
    localSent: false, offerHandled: false, answerHandled: false, stage: 'signaling', timer: null };
}
async function request(s, path, body, timeout = 10000) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  s.controller.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, timeout);
  if (!current(s)) controller.abort();
  try {
    const r = await fetch(SIGNAL + path, { method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
    const data = await r.json();
    if (!r.ok || data.error) {
      const error = new Error(ERRORS[data.error] || data.error || `Server error (${r.status}).`);
      error.code = data.error;
      throw error;
    }
    return data;
  } catch (e) {
    if (!current(s)) throw e;
    if (e.name === 'AbortError' || e instanceof TypeError) throw new Error(ERRORS.network);
    throw e;
  } finally {
    clearTimeout(timer);
    s.controller.signal.removeEventListener('abort', cancel);
  }
}
function roomPath(s) {
  return `/room?code=${encodeURIComponent(s.code)}&role=${s.role}&sid=${mySid}&attempt=${s.attempt}`;
}
function post(s, a, msg) {
  return request(s, roomPath(s), { a, attempt: s.attempt, negotiation: s.negotiation, msg });
}
async function prepare(s) {
  const health = await request(s, '/');
  if (health.protocol !== PROTOCOL_VERSION) throw new Error(ERRORS.protocol_mismatch);
  const ice = await request(s, '/ice');
  return { iceServers: ice.iceServers };
}
function notifyLeave(s) {
  if (!s?.code) return;
  const body = s.role === 'host' ? { a: 'close' } : { a: 'leave', attempt: s.attempt, negotiation: s.negotiation };
  fetch(SIGNAL + roomPath(s), { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), keepalive: true }).catch(() => {});
}
function closePc(s) {
  const pc = s.pc;
  s.pc = null; s.dc = null;
  if (pc) pc.close();
}
function dispose(s, notify = true) {
  if (!s) return;
  if (notify) notifyLeave(s);
  clearTimeout(s.timer);
  s.controller.abort();
  closePc(s);
  s.stream?.getTracks().forEach(t => t.stop());
}
function teardown() {
  dispose(session);
  session = null;
  wantingControl = false; hostAllowed = false;
  hostCtl.gate = false; hostCtl.grabbed = false;
  renderHostCtl();
  resetControlButton();
  controlChip.classList.add('hidden');
  playOverlay.classList.add('hidden');
  setAudioChip(false, 'audio pending…');
  show('menu');
  $('joinStatus').hidden = true;
  $('joinBtn').disabled = false;
  $('retryBtn').disabled = false;
}
function fail(s, error) {
  if (!current(s)) return;
  console.error(`PeekRemote ${s.role} ${s.stage}:`, error);
  status(s, error.message || String(error), 'bad');
  dispose(s);
  if (s.role === 'joiner') {
    $('joinView').classList.add('show');
    $('joinBtn').disabled = false;
    $('retryBtn').disabled = false;
  }
}
function armDeadline(s) {
  clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    const text = !s.offerHandled ? 'No offer arrived — check that the share is still open.'
      : s.stage === 'answer' ? 'Could not finish sending the answer — retry.'
      : 'Offer and answer exchanged, but the machines could not connect directly.';
    fail(s, new Error(text));
  }, 45000);
}
function createPc(s, config) {
  const pc = new RTCPeerConnection(config);
  const generation = s.negotiation;
  s.pc = pc;
  const active = () => current(s) && s.pc === pc && s.negotiation === generation;
  pc.addEventListener('icecandidate', e => {
    if (!active() || !e.candidate) return;
    const msg = { t: 'ice', data: e.candidate.toJSON(), negotiation: generation };
    if (!s.localSent) s.outgoingIce.push(msg);
    else post(s, 'message', msg).catch(error => {
      if (active() && error.code !== 'stale_negotiation') fail(s, error);
    });
  });
  pc.addEventListener('connectionstatechange', () => {
    if (!active()) return;
    if (pc.connectionState === 'connected') {
      clearTimeout(s.timer);
      s.stage = 'connected';
      if (s.role === 'host') {
        status(s, 'LIVE — your friend sees your screen', 'live');
      } else {
        status(s, 'live', 'live');
        $('joinView').classList.remove('show');
        $('vidWrap').classList.add('show');
        $('retryBtn').disabled = false;
      }
    } else if (pc.connectionState === 'failed') {
      fail(s, new Error('Offer and answer exchanged, but the direct connection failed — retry.'));
    } else if (pc.connectionState === 'disconnected') {
      status(s, 'connection interrupted — waiting to reconnect…');
    }
  });
  if (s.role === 'host') {
    s.stream.getTracks().forEach(t => pc.addTrack(t, s.stream));
    s.dc = pc.createDataChannel('peek-remote-control', { ordered: true });
    wireHostChannel(s);
    s.dc.addEventListener('open', () => announceGate(s));
  } else {
    pc.addEventListener('track', e => { if (active()) gotRemoteStream(s, e); });
    pc.addEventListener('datachannel', e => {
      if (!active()) return;
      if (e.channel.label !== 'peek-remote-control') return;
      s.dc = e.channel;
      e.channel.addEventListener('open', () => {
        status(s, 'live — waiting for the sharer to arm control…', 'wait');
        resetControlButton();
      });
      e.channel.addEventListener('close', () => { releaseControl(s, { announce: false }); status(s, 'control channel closed', 'wait'); });
      e.channel.addEventListener('message', e => handleHostGate(s, e));
    });
  }
  return pc;
}
function announceGate(s) {
  if (!current(s) || !s.dc || s.dc.readyState !== 'open') return;
  try { s.dc.send(JSON.stringify({ t: 'gate', on: hostCtl.gate })); } catch {}
}
function handleHostGate(s, e) {
  if (!current(s)) return;
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }
  if (msg.t !== 'gate') return;
  hostAllowed = !!msg.on;
  controlReqBtn.disabled = !hostAllowed || !CAN_INJECT;
  if (!hostAllowed && wantingControl) {
    releaseControl(s, { announce: true });
    status(s, 'sharer released control', 'wait');
  } else {
    status(s, hostAllowed ? 'sharer armed control — take the wheel' : 'waiting for the sharer to arm control…', hostAllowed ? 'live' : 'wait');
  }
}
function wireHostChannel(s) {
  const dc = s.dc;
  dc.addEventListener('message', e => {
    if (!current(s)) return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg && msg.t === 'grab') {
      hostCtl.grabbed = !!msg.on;
      renderHostCtl();
      if (msg.on) playCappy(); else playBlip();
      return;
    }
    // Everything else is an input event → uinput via the daemon (same origin).
    fetch(DAEMON + '/inject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Peek-Token': TOKEN },
      body: JSON.stringify(msg),
    }).catch(() => {});
  });
}
async function sendDescription(s, pc, desc) {
  await pc.setLocalDescription(desc);
  if (!current(s) || s.pc !== pc) return;
  await post(s, 'message', { t: desc.type, data: pc.localDescription.toJSON(), negotiation: s.negotiation });
  if (!current(s) || s.pc !== pc) return;
  s.localSent = true;
  const candidates = s.outgoingIce.splice(0);
  for (const msg of candidates) await post(s, 'message', msg);
}
async function hostOffer(s) {
  const pc = s.pc;
  s.stage = 'offer';
  await sendDescription(s, pc, await pc.createOffer());
  s.stage = 'waiting';
}
async function joinAnswer(s, offer) {
  if (s.offerHandled) return;
  s.offerHandled = true;
  s.stage = 'answer';
  const pc = createPc(s, s.config);
  await pc.setRemoteDescription(offer);
  await flushIce(s, pc);
  await sendDescription(s, pc, await pc.createAnswer());
  if (current(s)) { s.stage = 'connecting'; status(s, 'answer sent — connecting…'); }
}
async function handleCandidate(s, data) {
  if (!s.pc?.remoteDescription) { s.ice.push(data); return; }
  await s.pc.addIceCandidate(data);
}
async function flushIce(s, pc) {
  for (const data of s.ice.splice(0)) {
    if (!current(s) || s.pc !== pc) return;
    await pc.addIceCandidate(data);
  }
}
async function handleSignal(s, msg) {
  if (!current(s) || !msg) return;
  if (msg.t === 'ready' && s.role === 'host') {
    if (msg.negotiation <= s.negotiation) return;
    closePc(s);
    s.negotiation = msg.negotiation;
    s.ice = []; s.outgoingIce = []; s.localSent = false; s.answerHandled = false;
    status(s, 'friend is connecting…');
    createPc(s, s.config);
    await hostOffer(s);
    return;
  }
  if (msg.negotiation !== s.negotiation) return;
  switch (msg.t) {
    case 'offer':
      if (s.role === 'joiner') await joinAnswer(s, msg.data);
      break;
    case 'answer':
      if (s.role === 'host' && s.pc && !s.answerHandled) {
        s.answerHandled = true;
        await s.pc.setRemoteDescription(msg.data);
        await flushIce(s, s.pc);
        await post(s, 'ack');
      }
      break;
    case 'ice': await handleCandidate(s, msg.data); break;
    case 'bye':
      if (s.role === 'host') { closePc(s); status(s, 'friend left — waiting for a new connection'); }
      else fail(s, new Error('The host closed the share.'));
      break;
    default: console.warn('Unknown Peek signal:', msg.t);
  }
}
async function signalLoop(s) {
  while (current(s)) {
    try {
      const d = await request(s, roomPath(s), null, 22000);
      for (const msg of d.msgs || []) {
        if (!current(s)) break;
        await handleSignal(s, msg);
      }
    } catch (e) {
      if (current(s) && !(s.role === 'host' && e.code === 'stale_negotiation')) fail(s, e);
    }
  }
}

/* ── host ── */
function setAudioChip(on, text) {
  const c = $('chipAudio');
  if (!c) return;
  c.textContent = (on ? '🔊 ' : '🔇 ') + text;
  c.className = 'chip chip-audio ' + (on ? 'on' : 'off');
}
function renderHostCtl() {
  const btn = $('controlBtn');
  btn.setAttribute('aria-pressed', String(hostCtl.gate));
  btn.textContent = !hostCtl.gate ? 'Allow control of this machine'
    : hostCtl.grabbed ? 'Release the wheel' : 'Release control';
  const banner = $('hostBanner');
  if (!hostCtl.gate) {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden');
    banner.textContent = hostCtl.grabbed
      ? '🐾 FRIEND IS DRIVING — Ctrl+Alt+Q to release'
      : '🐾 CONTROL ARMED — friend can take it (Ctrl+Alt+Q releases)';
  }
  const chip = $('chipControl');
  chip.textContent = !hostCtl.gate ? 'control off' : hostCtl.grabbed ? 'FRIEND DRIVING' : 'control armed';
  chip.className = 'chip chip-control' + (hostCtl.gate ? ' on' : '');
}
function setHostControlUI(on) {
  hostCtl.gate = !!on;
  renderHostCtl();
}
function armGate(on) {
  hostCtl.gate = on;
  if (!on) hostCtl.grabbed = false;
  renderHostCtl();
  announceGate(session);
}
function beginHost() {
  if (hostStarting) return;
  hostStarting = true;
  dispose(session);
  const s = session = newSession('host', null);
  show('hostView');
  $('codeOut').textContent = '······';
  setHostControlUI(false);
  setAudioChip(false, 'audio pending…');
  status(s, 'pick a screen to share…');
  if (!CAN_INJECT) {
    console.warn('peek: no daemon token — control injection will be refused (open from 127.0.0.1:8753)');
  }
  // WebKit/Firefox require getDisplayMedia synchronously in the gesture body.
  let mediaPromise;
  try {
    mediaPromise = navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (e) {
    fail(s, e);
    hostStarting = false;
    return;
  }
  mediaPromise.then(
    stream => finishHostStart(s, stream),
    e => { fail(s, e); hostStarting = false; },
  );
}
async function finishHostStart(s, stream) {
  try {
    s.stream = stream;
    if (stream.getAudioTracks().length) {
      setAudioChip(true, 'desktop audio — display capture');
    } else {
      setAudioChip(false, 'video only — no audio offered');
    }
    stream.getVideoTracks()[0].addEventListener('ended', () => { if (current(s)) teardown(); });
    $('previewVideo').srcObject = s.stream;
    status(s, 'asking the server for a code…');
    s.config = await prepare(s);
    const created = await request(s, `/room/create?role=host&sid=${mySid}`, {});
    if (!current(s)) return;
    s.code = created.code;
    s.negotiation = created.negotiation;
    $('codeOut').textContent = s.code;
    createPc(s, s.config);
    await hostOffer(s);
    status(s, 'waiting for your friend…');
    signalLoop(s);
  } catch (e) {
    if (e.name === 'NotAllowedError') fail(s, new Error('Screen pick cancelled.'));
    else fail(s, e);
  } finally {
    hostStarting = false;
  }
}

/* ── joiner ── */
async function startJoin() {
  const code = $('codeInput').value.trim().toUpperCase();
  if ($('joinBtn').disabled) return;
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    setStatus($('joinStatus'), $('joinStatusText'), ERRORS.bad_code, 'bad');
    return;
  }
  dispose(session, session?.code !== code);
  const s = session = newSession('joiner', code);
  wantingControl = false; hostAllowed = false;
  controlChip.classList.add('hidden');
  playOverlay.classList.add('hidden');
  remoteVideo.srcObject = null;
  show('joinView');
  $('joinBtn').disabled = true;
  $('retryBtn').disabled = true;
  resetControlButton();
  status(s, 'contacting the signaling server…');
  armDeadline(s);
  try {
    s.config = await prepare(s);
    const joined = await request(s, roomPath(s), { a: 'join', attempt: s.attempt });
    if (!current(s)) return;
    s.negotiation = joined.negotiation;
    status(s, 'waiting for the host offer…');
    signalLoop(s);
  } catch (e) { fail(s, e); }
}
function gotRemoteStream(s, e) {
  if (!s.remoteStream.getTracks().includes(e.track)) s.remoteStream.addTrack(e.track);
  if (remoteVideo.srcObject !== s.remoteStream) remoteVideo.srcObject = s.remoteStream;
  $('vidWrap').classList.add('show');
  remoteVideo.play().then(() => playOverlay.classList.add('hidden')).catch(() => playOverlay.classList.remove('hidden'));
}
function grabControl(s) {
  wantingControl = true;
  controlReqBtn.setAttribute('aria-pressed', 'true');
  controlReqBtn.textContent = 'Release control';
  controlChip.classList.remove('hidden');
  if (session?.dc?.readyState === 'open') {
    try { session.dc.send(JSON.stringify({ t: 'grab', on: true })); } catch {}
  }
  playCappy();
}
function releaseControl(s, opts) {
  const announce = !opts || opts.announce !== false;
  const wasActive = wantingControl;
  wantingControl = false;
  controlReqBtn.setAttribute('aria-pressed', 'false');
  controlReqBtn.textContent = 'Take control';
  controlChip.classList.add('hidden');
  if (announce && session?.dc?.readyState === 'open') {
    try { session.dc.send(JSON.stringify({ t: 'grab', on: false })); } catch {}
  }
  if (wasActive) playBlip();
}
function resetControlButton() {
  controlReqBtn.setAttribute('aria-pressed', 'false');
  controlReqBtn.textContent = 'Take control';
  controlReqBtn.disabled = !hostAllowed || !CAN_INJECT;
}
function controlActive() {
  return wantingControl && session?.dc?.readyState === 'open' && $('vidWrap').classList.contains('show');
}
function sendControl(payload) {
  if (!controlActive()) return;
  try { session.dc.send(JSON.stringify(payload)); } catch {}
}
function normalizedPoint(e) {
  const rect = remoteVideo.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}
remoteVideo.addEventListener('mousemove', e => { const p = normalizedPoint(e); sendControl({ t: 'mousemove', ...p }); });
remoteVideo.addEventListener('mousedown', e => { e.preventDefault(); sendControl({ t: 'mousedown', button: e.button }); });
remoteVideo.addEventListener('mouseup', e => { e.preventDefault(); sendControl({ t: 'mouseup', button: e.button }); });
remoteVideo.addEventListener('contextmenu', e => { if (controlActive()) e.preventDefault(); });
remoteVideo.addEventListener('wheel', e => { if (controlActive()) { e.preventDefault(); sendControl({ t: 'wheel', dy: e.deltaY }); } }, { passive: false });
window.addEventListener('keydown', e => {
  if (wantingControl && e.ctrlKey && e.altKey && e.code === 'KeyQ') {
    e.preventDefault();
    releaseControl(session, { announce: true });
    status(session, 'wheel released', 'wait');
    return;
  }
  if (!controlActive() || e.target === $('codeInput')) return;
  e.preventDefault();
  sendControl({ t: 'keydown', code: e.code });
});
window.addEventListener('keyup', e => {
  if (!controlActive() || e.target === $('codeInput')) return;
  e.preventDefault();
  sendControl({ t: 'keyup', code: e.code });
});

/* ── wiring ── */
$('optHost').onclick = beginHost;
$('optJoin').onclick = () => { show('joinView'); $('codeInput').focus(); };
$('joinBtn').onclick = startJoin;
$('retryBtn').onclick = () => { $('joinBtn').disabled = false; startJoin(); };
$('stopBtn').onclick = teardown;
$('leaveBtn').onclick = teardown;
$('fsBtn').onclick = () => remoteVideo.requestFullscreen?.().catch(() => {});
$('copyBtn').onclick = () => navigator.clipboard.writeText($('codeOut').textContent).then(() => {
  $('copyBtn').textContent = 'Copied!';
  setTimeout(() => { $('copyBtn').textContent = 'Copy'; }, 1500);
}).catch(() => {});
$('controlBtn').onclick = () => {
  if (!CAN_INJECT) {
    status(session, 'input injection needs the daemon — open this page from http://127.0.0.1:8753/', 'bad');
    return;
  }
  const now = !hostCtl.gate;
  hostCtl.grabbed = false;
  armGate(now);
  status(session, now ? 'control armed — waiting for friend to take it' : 'control released', now ? 'live' : 'wait');
};
$('playOverlay')?.addEventListener('click', () => {
  remoteVideo.play().then(() => playOverlay.classList.add('hidden')).catch(() => {});
});
$('controlReqBtn').onclick = () => {
  if (!session) return;
  if (wantingControl) { releaseControl(session, { announce: true }); status(session, 'wheel released', 'wait'); return; }
  if (!hostAllowed) {
    status(session, 'the sharer hasn’t armed control yet — the wheel stays off until they do', 'wait');
    return;
  }
  grabControl(session);
  status(session, 'you have the wheel', 'live');
};
$('codeInput').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(new RegExp('[^' + CODE_ALPHABET + ']', 'g'), '').slice(0, 6);
});
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') startJoin(); });
// Host-local panic: Ctrl+Alt+Q releases control from this page too.
window.addEventListener('keydown', e => {
  if (e.ctrlKey && e.altKey && e.code === 'KeyQ' && hostCtl.gate) {
    e.preventDefault();
    armGate(false);
    playBlip();
    if (session) status(session, 'control released (Ctrl+Alt+Q)', 'wait');
  }
});
show('menu');
