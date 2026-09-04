/* ============================================================
   STARFALL PROTOCOL — "Best Game Ever"
   A neon roguelite twin-stick survivor. Vanilla JS, no deps.
   ============================================================ */
(() => {
'use strict';

/* ---------------- utils ---------------- */
const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const hyp2 = (x, y) => x * x + y * y;
const fmtTime = s => { s = Math.floor(s); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
const $ = id => document.getElementById(id);

/* ---------------- save / settings ---------------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('starfall_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('starfall_' + k, JSON.stringify(v)); } catch {} }
};
const settings = Object.assign({ vol: 70, mus: 55, shake: 100, particles: 1, autofire: true, dmg: true, mute: false, diff: 1 },
  store.get('settings', {}));
function saveSettings() { store.set('settings', settings); }

const DIFFS = [
  { name: 'CADET', hpM: 0.7, dmgM: 0.7, spdM: 0.9, scoreM: 0.7 },
  { name: 'PILOT', hpM: 1.0, dmgM: 1.0, spdM: 1.0, scoreM: 1.0 },
  { name: 'ACE', hpM: 1.45, dmgM: 1.3, spdM: 1.08, scoreM: 1.5 },
  { name: 'VOIDBORN', hpM: 2.1, dmgM: 1.7, spdM: 1.15, scoreM: 2.2 },
];

/* ---------------- audio ---------------- */
const AudioSys = {
  ctx: null, master: null, musGain: null, noiseBuf: null, musicTimer: null, step: 0,
  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = settings.mute ? 0 : settings.vol / 100 * 0.9;
      this.master.connect(this.ctx.destination);
      this.musGain = this.ctx.createGain();
      this.musGain.gain.value = settings.mus / 100 * 0.5;
      this.musGain.connect(this.master);
      const len = this.ctx.sampleRate * 1;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) { /* no audio */ }
  },
  setVolumes() {
    if (!this.ctx) return;
    this.master.gain.value = settings.mute ? 0 : settings.vol / 100 * 0.9;
    this.musGain.gain.value = settings.mus / 100 * 0.5;
  },
  tone(freq, dur, type, vol, slideTo, delay) {
    if (!this.ctx || settings.mute) return;
    type = type || 'square'; vol = vol || 0.2; delay = delay || 0;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  },
  noise(dur, vol, filterFreq, delay) {
    if (!this.ctx || settings.mute) return;
    delay = delay || 0;
    const t = this.ctx.currentTime + delay;
    const s = this.ctx.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filterFreq || 1200;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol || 0.3, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t); s.stop(t + dur + 0.02);
  },
  shoot() { this.tone(rand(700, 900), 0.09, 'square', 0.07, 220); },
  spread() { this.tone(rand(280, 340), 0.14, 'sawtooth', 0.1, 90); },
  rail() { this.tone(1600, 0.25, 'sawtooth', 0.12, 120); this.noise(0.15, 0.1, 4000); },
  missile() { this.tone(rand(300, 420), 0.2, 'sawtooth', 0.06, 900); },
  zap() { this.tone(rand(1400, 1900), 0.08, 'square', 0.06, 300); },
  hit() { this.noise(0.07, 0.12, 3000); },
  enemyDie() { this.noise(0.25, 0.22, 900); this.tone(rand(180, 260), 0.2, 'sawtooth', 0.1, 40); },
  bigBoom() { this.noise(0.7, 0.4, 500); this.tone(90, 0.6, 'sine', 0.3, 28); },
  pickup() { this.tone(rand(900, 1200), 0.07, 'sine', 0.08, 1800); },
  gem() { this.tone(rand(1200, 1600), 0.06, 'sine', 0.05, 2200); },
  levelup() { const n = [523, 659, 784, 1046]; n.forEach((f, i) => this.tone(f, 0.18, 'square', 0.1, 0, i * 0.07)); },
  hurt() { this.tone(140, 0.3, 'sawtooth', 0.22, 50); this.noise(0.2, 0.2, 600); },
  dash() { this.noise(0.18, 0.14, 2500); this.tone(300, 0.15, 'sine', 0.08, 900); },
  bomb() { this.noise(0.9, 0.4, 700); this.tone(60, 0.8, 'sine', 0.3, 24); },
  ui() { this.tone(600, 0.06, 'square', 0.07, 900); },
  warn() { for (let i = 0; i < 3; i++) this.tone(220, 0.25, 'sawtooth', 0.16, 0, i * 0.3); },
  power() { const n = [392, 523, 659, 880, 1174]; n.forEach((f, i) => this.tone(f, 0.16, 'square', 0.09, 0, i * 0.05)); this.noise(0.25, 0.06, 6000); },
  titan() { this.tone(70, 0.7, 'sawtooth', 0.25, 30); this.noise(0.6, 0.3, 400); const n = [98, 147, 196]; n.forEach((f, i) => this.tone(f, 0.4, 'square', 0.1, 0, 0.1 + i * 0.09)); },
  victory() { const n = [523, 659, 784, 1046, 1318, 1568]; n.forEach((f, i) => this.tone(f, 0.3, 'triangle', 0.14, 0, i * 0.12)); },
  // --- procedural dark-synth loop ---
  startMusic() {
    if (!this.ctx || this.musicTimer) return;
    const bass = [55, 55, 65.4, 49, 55, 55, 82.4, 73.4];       // A1 A1 C2 G1 ...
    const arp = [220, 261.6, 329.6, 440, 329.6, 261.6];
    this.step = 0;
    this.musicTimer = setInterval(() => {
      if (!this.ctx || settings.mute || G.state !== 'playing') return;
      const s = this.step++;
      const t = this.ctx.currentTime;
      // bass 8ths
      const bf = bass[Math.floor(s / 2) % bass.length];
      if (s % 2 === 0) {
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = 'sawtooth'; o.frequency.value = bf;
        const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420;
        g.gain.setValueAtTime(0.11, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.34);
        o.connect(f); f.connect(g); g.connect(this.musGain); o.start(t); o.stop(t + 0.4);
      }
      // arp 16ths sparkle + hats
      const af = arp[(s * 5 + Math.floor(s / 8)) % arp.length] * 2;
      const o2 = this.ctx.createOscillator(), g2 = this.ctx.createGain();
      o2.type = 'triangle'; o2.frequency.value = af;
      g2.gain.setValueAtTime(s % 8 === 0 ? 0.05 : 0.028, t);
      g2.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      o2.connect(g2); g2.connect(this.musGain); o2.start(t); o2.stop(t + 0.2);
      // kick on quarters
      if (s % 4 === 0) {
        const o3 = this.ctx.createOscillator(), g3 = this.ctx.createGain();
        o3.type = 'sine'; o3.frequency.setValueAtTime(120, t);
        o3.frequency.exponentialRampToValueAtTime(35, t + 0.12);
        g3.gain.setValueAtTime(0.22, t); g3.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
        o3.connect(g3); g3.connect(this.musGain); o3.start(t); o3.stop(t + 0.16);
      }
    }, 158);
  },
  stopMusic() { if (this.musicTimer) { clearInterval(this.musicTimer); this.musicTimer = null; } }
};

/* ---------------- canvas ---------------- */
const canvas = $('game'), ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.floor(W * DPR); canvas.height = Math.floor(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize); resize();

/* ---------------- input ---------------- */
const keys = {};
const mouse = { x: W / 2, y: H / 2, down: false, rdown: false };
window.addEventListener('keydown', e => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  keys[e.code] = true;
  AudioSys.ensure();
  if (e.code === 'KeyM') toggleMute();
  if (e.code === 'KeyE' || e.code === 'KeyF') activateItem(0);
  if (e.code === 'KeyP' || e.code === 'Escape') togglePause();
  if (e.code === 'KeyQ') fireBomb();
  if (e.code === 'Enter') enterConfirm();
});
window.addEventListener('keyup', e => { keys[e.code] = false; });
canvas.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
canvas.addEventListener('mousedown', e => {
  AudioSys.ensure();
  if (e.button === 0) mouse.down = true;
  if (e.button === 2) fireBomb();
});
window.addEventListener('mouseup', e => { if (e.button === 0) mouse.down = false; });
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  G.zoom = clamp(Math.round(G.zoom * (e.deltaY > 0 ? 0.9 : 1.111) * 100) / 100, 0.5, 2.5);
}, { passive: false });
window.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('visibilitychange', () => { if (document.hidden && G.state === 'playing') pauseGame(); });

/* touch */
const touch = { active: false, moveId: -1, aimId: -1, mx: 0, my: 0, ax: 0, ay: 0, firing: false };
(function initTouch() {
  if (!('ontouchstart' in window)) return;
  touch.active = true;
  const L = $('stick-left'), R = $('stick-right');
  $('touch-ui').classList.remove('hidden');
  function stickHandler(el, isMove) {
    const nub = el.querySelector('.nub');
    let tid = -1, cx = 0, cy = 0;
    el.addEventListener('touchstart', e => {
      e.preventDefault(); AudioSys.ensure();
      const t = e.changedTouches[0]; tid = t.identifier;
      const r = el.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2;
    }, { passive: false });
    el.addEventListener('touchmove', e => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier !== tid) continue;
        let dx = (t.clientX - cx) / 50, dy = (t.clientY - cy) / 50;
        const m = Math.hypot(dx, dy) || 1, c = Math.min(m, 1);
        dx = dx / m * c; dy = dy / m * c;
        nub.style.transform = `translate(calc(-50% + ${dx * 34}px), calc(-50% + ${dy * 34}px))`;
        if (isMove) { touch.mx = dx; touch.my = dy; }
        else { touch.ax = dx; touch.ay = dy; touch.firing = c > 0.35; }
      }
    }, { passive: false });
    const end = e => {
      for (const t of e.changedTouches) {
        if (t.identifier !== tid) continue;
        tid = -1; nub.style.transform = 'translate(-50%,-50%)';
        if (isMove) { touch.mx = 0; touch.my = 0; } else { touch.ax = 0; touch.ay = 0; touch.firing = false; }
      }
    };
    el.addEventListener('touchend', end); el.addEventListener('touchcancel', end);
  }
  stickHandler(L, true); stickHandler(R, false);
  $('btn-dash').addEventListener('touchstart', e => { e.preventDefault(); tryDash(); }, { passive: false });
  $('btn-bomb').addEventListener('touchstart', e => { e.preventDefault(); fireBomb(); }, { passive: false });
})();

/* ---------------- game data ---------------- */
const WEAPONS = {
  blaster: { name: 'PULSE BLASTER', ico: '🔫', color: '#35e0ff', desc: 'Rapid plasma bolts at your cursor.' },
  spread: { name: 'SCATTERGUN', ico: '💥', color: '#ffb020', desc: 'Fan of 5 shells. Delete crowds up close.' },
  railgun: { name: 'RAILSPIKE', ico: '⚡', color: '#b26bff', desc: 'Piercing hypersonic slug. Huge damage.' },
  missiles: { name: 'HORNET PODS', ico: '🚀', color: '#ff7a3d', desc: 'Homing missiles with splash damage.' },
  orbitals: { name: 'HALO BLADES', ico: '🌀', color: '#7cff6b', desc: 'Orbiting blades shred on contact.' },
  tesla: { name: 'TESLA ARC', ico: '🌩️', color: '#9ff3ff', desc: 'Chain lightning zaps nearest foes.' },
};
const STAT_POOL = [
  { id: 'hp', ico: '❤️', name: 'REINFORCED HULL', tag: 'STAT', desc: '+25 max hull & repair 25.' },
  { id: 'spd', ico: '👟', name: 'ION THRUSTERS', tag: 'STAT', desc: '+10% move speed.' },
  { id: 'mag', ico: '🧲', name: 'TRACTOR WEB', tag: 'STAT', desc: '+45% pickup radius.' },
  { id: 'armor', ico: '🛡️', name: 'ABLATIVE ARMOR', tag: 'STAT', desc: '-1 damage from every hit (min 1).' },
  { id: 'crit', ico: '🎯', name: 'DEADEYE', tag: 'STAT', desc: '+8% crit chance (2x dmg).' },
  { id: 'rate', ico: '🔥', name: 'OVERCLOCK', tag: 'STAT', desc: '+10% fire rate, all weapons.' },
  { id: 'regen', ico: '💚', name: 'NANOBOTS', tag: 'STAT', desc: 'Regenerate +0.8 hull/sec.' },
  { id: 'dash', ico: '💨', name: 'PHASE DRIVE', tag: 'STAT', desc: '-22% dash cooldown.' },
  { id: 'bomb', ico: '💣', name: '+1 BOMB', tag: 'STAT', desc: 'Gain a bomb (max 3). Bombs nuke bullets.' },
  { id: 'shield', ico: '🔷', name: 'AEGIS SHIELD', tag: 'STAT', desc: '+40 shield. Recharges after 6s calm.' },
  { id: 'heal', ico: '✚', name: 'FIELD REPAIR', tag: 'STAT', desc: 'Restore 50% hull now.' },
  { id: 'dmg', ico: '⚔️', name: 'HOT ROUNDS', tag: 'STAT', desc: '+12% all damage.' },
];
const ENEMY_TYPES = {
  chaser: { hp: 22, spd: 135, dmg: 10, r: 13, xp: 1, score: 50, color: '#ff2d78' },
  dasher: { hp: 34, spd: 100, dmg: 14, r: 13, xp: 2, score: 80, color: '#ffb020' },
  splitter: { hp: 70, spd: 80, dmg: 12, r: 19, xp: 3, score: 120, color: '#7cff6b' },
  mini: { hp: 10, spd: 175, dmg: 7, r: 8, xp: 1, score: 30, color: '#7cff6b' },
  stinger: { hp: 40, spd: 95, dmg: 9, r: 14, xp: 3, score: 140, color: '#b26bff' },
  bulwark: { hp: 230, spd: 52, dmg: 22, r: 26, xp: 8, score: 300, color: '#35e0ff' },
  weaver: { hp: 30, spd: 150, dmg: 11, r: 12, xp: 2, score: 90, color: '#ff7ae0' },
};

/* ---------------- power-ups (custom sprites, timed effects) ---------------- */
const POWERUPS = {
  overdrive: { name: 'OVERDRIVE', color: '#ffb020', dur: 10, desc: 'Double fire rate!' },
  splitfire: { name: 'SPLITFIRE', color: '#35e0ff', dur: 12, desc: 'Every gun fires a triple-shot fan!' },
  rampage: { name: 'RAMPAGE', color: '#ff2d78', dur: 10, desc: 'Double damage!' },
  titan: { name: 'TITAN FORM', color: '#7cff6b', dur: 8, desc: 'GIANT! Ram and crush the swarm!' },
  aegis: { name: 'AEGIS', color: '#4da6ff', dur: 6, desc: 'Invulnerable shield!' },
  frost: { name: 'DEEP FROST', color: '#bfefff', dur: 5, desc: 'Freezes every enemy solid!' },
};
const SPRITES = {};
function paintPowerSprite(kind) {
  const P = POWERUPS[kind];
  const S = 84, c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  const cx = S / 2, cy = S / 2;
  // dark core + glowing rim (shadowBlur is fine: one-time prerender)
  g.shadowColor = P.color; g.shadowBlur = 16;
  g.fillStyle = 'rgba(8,12,28,.95)';
  g.beginPath(); g.arc(cx, cy, 30, 0, TAU); g.fill();
  g.lineWidth = 4; g.strokeStyle = P.color;
  g.beginPath(); g.arc(cx, cy, 30, 0, TAU); g.stroke();
  g.shadowBlur = 8; g.lineWidth = 1.5; g.globalAlpha = 0.7;
  g.beginPath(); g.arc(cx, cy, 23, 0, TAU); g.stroke();
  g.globalAlpha = 1;
  g.fillStyle = P.color; g.strokeStyle = P.color;
  if (kind === 'overdrive') {
    // lightning bolt
    g.beginPath();
    g.moveTo(48, 14); g.lineTo(28, 46); g.lineTo(39, 46); g.lineTo(34, 70);
    g.lineTo(56, 38); g.lineTo(44, 38); g.closePath(); g.fill();
    g.shadowBlur = 0; g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(45, 24); g.lineTo(36, 43); g.lineTo(41, 43); g.lineTo(38, 57);
    g.lineTo(49, 40); g.lineTo(43, 40); g.closePath(); g.fill();
  } else if (kind === 'splitfire') {
    // three projectiles fanning upward
    for (const a of [-0.42, 0, 0.42]) {
      g.save(); g.translate(cx, cy + 8); g.rotate(a);
      g.fillRect(-3.5, -24, 7, 22);
      g.beginPath(); g.moveTo(-3.5, -24); g.lineTo(3.5, -24); g.lineTo(0, -31); g.closePath(); g.fill();
      g.shadowBlur = 0; g.fillStyle = '#fff'; g.fillRect(-1.2, -21, 2.4, 14);
      g.shadowBlur = 8; g.fillStyle = P.color;
      g.restore();
    }
    g.lineWidth = 3;
    g.beginPath(); g.moveTo(cx - 9, cy + 16); g.lineTo(cx + 9, cy + 16); g.lineTo(cx, cy + 25); g.closePath(); g.stroke();
  } else if (kind === 'rampage') {
    // spiked starburst
    g.beginPath();
    for (let i = 0; i < 16; i++) {
      const a = i * TAU / 16, r = i % 2 === 0 ? 24 : 11;
      const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
      i ? g.lineTo(px, py) : g.moveTo(px, py);
    }
    g.closePath(); g.fill();
    g.shadowBlur = 0; g.fillStyle = '#fff';
    g.beginPath(); g.arc(cx, cy, 5.5, 0, TAU); g.fill();
  } else if (kind === 'titan') {
    // titan helm: horns + trapezoid crown + glowing visor
    g.beginPath();
    g.moveTo(24, 28); g.lineTo(15, 13); g.lineTo(30, 23); g.closePath(); g.fill();
    g.beginPath();
    g.moveTo(60, 28); g.lineTo(69, 13); g.lineTo(54, 23); g.closePath(); g.fill();
    g.shadowBlur = 0; g.fillStyle = '#0d2b12';
    g.beginPath();
    g.moveTo(22, 28); g.lineTo(62, 28); g.lineTo(56, 61); g.lineTo(28, 61); g.closePath();
    g.fill(); g.shadowBlur = 8;
    g.lineWidth = 3; g.strokeStyle = P.color; g.stroke();
    g.fillStyle = '#eaffea';
    g.fillRect(31, 41, 22, 7);
  } else if (kind === 'aegis') {
    // heater shield
    g.beginPath();
    g.moveTo(42, 15); g.lineTo(61, 24); g.lineTo(59, 44);
    g.quadraticCurveTo(58, 57, 42, 67);
    g.quadraticCurveTo(26, 57, 25, 44);
    g.lineTo(23, 24); g.closePath();
    g.fillStyle = 'rgba(77,166,255,.28)'; g.fill();
    g.lineWidth = 4; g.stroke();
    g.shadowBlur = 0; g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(46, 26); g.lineTo(37, 44); g.lineTo(42, 44); g.lineTo(39, 56);
    g.lineTo(49, 40); g.lineTo(44, 40); g.closePath(); g.fill();
  } else if (kind === 'frost') {
    // snowflake
    g.strokeStyle = '#e8f8ff'; g.lineWidth = 3; g.lineCap = 'round';
    for (const a of [0, Math.PI / 3, 2 * Math.PI / 3]) {
      g.beginPath();
      g.moveTo(cx - Math.cos(a) * 20, cy - Math.sin(a) * 20);
      g.lineTo(cx + Math.cos(a) * 20, cy + Math.sin(a) * 20);
      g.stroke();
    }
    g.shadowBlur = 0; g.fillStyle = '#fff';
    for (const a of [0, Math.PI / 3, 2 * Math.PI / 3]) {
      for (const s of [-1, 1]) {
        g.fillRect(cx + Math.cos(a) * 20 * s - 2, cy + Math.sin(a) * 20 * s - 2, 4, 4);
      }
    }
    g.beginPath(); g.arc(cx, cy, 4.5, 0, TAU); g.fill();
  }
  g.shadowBlur = 0;
  return c;
}
function buildPowerSprites() {
  for (const k of Object.keys(POWERUPS)) {
    const img = paintPowerSprite(k);
    SPRITES[k] = { img, url: img.toDataURL() };
  }
}

/* ---------------- state ---------------- */
const G = {
  state: 'menu', time: 0, wave: 1, waveT: 0, kills: 0, score: 0,
  combo: 0, comboT: 0, bestCombo: 0, shake: 0, hitstop: 0, flashA: 0,
  endless: false, won: false, slowmo: 0, weeee: false, zoom: 1,
  rerolls: 1, pendingLevels: 0, boss: null, spawnT: 0, diffM: DIFFS[1],
};
let player = null;
let enemies = [], pBullets = [], eBullets = [], gems = [], pickups = [], parts = [], floaters = [], bolts = [], floatStars = [];
let powerups = [];
let stars = [];
let cam = { x: 0, y: 0 };
let bossWarnT = 0;

function makeStars() {
  stars = [];
  for (let i = 0; i < 220; i++) stars.push({ x: Math.random(), y: Math.random(), z: rand(0.15, 1), s: rand(0.5, 2.2), tw: rand(0, TAU) });
}
makeStars();

function newPlayer() {
  return {
    x: 0, y: 0, vx: 0, vy: 0, r: 14, aim: 0,
    hp: 100, maxHp: 100, shield: 0, maxShield: 0, shieldT: 0,
    speed: 300, level: 1, xp: 0, xpNext: 12,
    armor: 0, crit: 0.05, regen: 0, dmgM: 1, rateM: 1, magnet: 110,
    dashCd: 0, dashCdMax: 2.2, dashT: 0, dashDx: 1, dashDy: 0, invuln: 0,
    fx: { overdrive: 0, splitfire: 0, rampage: 0, titan: 0, aegis: 0, frost: 0 },
    items: [],
    bombs: 1, maxBombs: 3, fireHeld: false,
    weapons: { blaster: 1 },
    wcd: { blaster: 0, spread: 0, railgun: 0, missiles: 0, tesla: 0 },
    alive: true,
  };
}

function resetRun(endless, weeee) {
  enemies = []; pBullets = []; eBullets = []; gems = []; pickups = [];
  parts = []; floaters = []; bolts = []; powerups = [];
  player = newPlayer();
  G.weeee = !!weeee;
  if (G.weeee) {
    player.maxHp *= 100; player.hp = player.maxHp;
    player.magnet *= 100; player.rateM *= 100; player.dmgM *= 100;
  }
  G.state = 'playing'; G.time = 0; G.wave = 1; G.waveT = 0; G.kills = 0; G.score = 0;
  G.combo = 0; G.comboT = 0; G.bestCombo = 0; G.shake = 0; G.hitstop = 0; G.flashA = 0;
  G.endless = !!endless; G.won = false; G.rerolls = 1; G.pendingLevels = 0; G.boss = null; G.spawnT = 1;
  cam.x = 0; cam.y = 0;
  store.set('games', (store.get('games', 0)) + 1);
  refreshMenuStats();
  showScreen(null); $('hud').classList.remove('hidden');
  if (G.weeee) { announce('🌈 WEEEEEE!!', '#ffcf4d'); toast('100x fire rate, damage, score + 10x upgrades. Enemies: unchanged. WEEE!'); }
  else { announce('WAVE 1', '#35e0ff'); toast('Survive. Collect ◇. Get strong.'); }
  AudioSys.ensure(); AudioSys.startMusic();
  updateWeaponsHUD(); updatePouch();
}

/* ---------------- dom helpers ---------------- */
const screens = ['menu', 'howto', 'settings', 'pause', 'levelup', 'gameover', 'victory'];
function showScreen(id) { screens.forEach(s => $(s).classList.toggle('hidden', s !== id)); }
function announce(txt, color) {
  const a = $('announce'); a.textContent = txt;
  a.style.color = '#fff'; a.style.textShadow = `0 0 30px ${color || '#ff2d78'},0 0 70px ${color || '#ff2d78'}`;
  a.classList.remove('show'); void a.offsetWidth; a.classList.add('show');
}
function toast(txt) {
  const w = $('toast-wrap'); const d = document.createElement('div');
  d.className = 'toast'; d.textContent = txt; w.appendChild(d);
  setTimeout(() => d.remove(), 2500);
  while (w.children.length > 3) w.firstChild.remove();
}
function refreshMenuStats() {
  $('menu-best').textContent = (store.get('best', 0)).toLocaleString();
  $('menu-wave').textContent = store.get('bestWave', 0);
  $('menu-wins').textContent = store.get('wins', 0);
  $('menu-games').textContent = store.get('games', 0);
}

/* ---------------- fx ---------------- */
function partCap() { return [450, 1400, 3000][settings.particles] ?? 1400; }
function burst(x, y, color, n, spd, life, size) {
  n = Math.round(n * ([0.4, 1, 1.8][settings.particles] ?? 1));
  for (let i = 0; i < n; i++) {
    if (parts.length >= partCap()) return;
    const a = rand(0, TAU), s = rand(spd * 0.2, spd);
    parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(life * 0.5, life), max: life, size: rand(size * 0.5, size * 1.4), color, drag: 3 });
  }
}
function floater(x, y, txt, color, big) {
  if (!settings.dmg && !big) return;
  if (floaters.length > 160) floaters.shift();
  floaters.push({ x: x + rand(-8, 8), y, txt, color: color || '#fff', life: big ? 1.1 : 0.7, max: 1, big: !!big });
}
function addShake(v) { G.shake = Math.min(1, G.shake + v * (settings.shake / 100)); }
function flash(a) { G.flashA = Math.max(G.flashA, a); $('flash').style.opacity = a; }

/* ---------------- combat helpers ---------------- */
function critRoll(base) {
  if (Math.random() < player.crit) return { dmg: base * 2, crit: true };
  return { dmg: base, crit: false };
}
function damageEnemy(e, base, kx, ky, isCrit) {
  if (e.dead) return;
  let r = isCrit != null ? { dmg: base, crit: isCrit } : critRoll(base);
  e.hp -= r.dmg;
  e.hitT = 0.09;
  if (settings.dmg || r.crit) floater(e.x, e.y - e.r - 4, Math.round(r.dmg) + (r.crit ? '!' : ''), r.crit ? '#ffcf4d' : '#cfe9ff', r.crit);
  burst(e.x, e.y, e.color, r.crit ? 5 : 2, 260, 0.3, 3);
  AudioSys.hit();
  if (kx) { e.kx = (e.kx || 0) + kx; e.ky = (e.ky || 0) + ky; }
  if (e.hp <= 0) killEnemy(e);
}
function killEnemy(e, byBomb) {
  if (e.dead) return;
  e.dead = true;
  G.kills++;
  G.combo++; G.comboT = 3; G.bestCombo = Math.max(G.bestCombo, G.combo);
  const mult = 1 + Math.min(G.combo, 100) * 0.02;
  G.score += Math.round(e.score * mult * G.diffM.scoreM * (G.weeee ? 100 : 1));
  burst(e.x, e.y, e.color, e.boss ? 90 : e.r > 20 ? 26 : 12, e.boss ? 520 : 340, 0.6, e.boss ? 6 : 4);
  burst(e.x, e.y, '#ffffff', 6, 200, 0.3, 2.5);
  if (e.boss) {
    addShake(1); flash(0.35); G.hitstop = Math.max(G.hitstop, 0.22); AudioSys.bigBoom();
    floater(e.x, e.y - 40, 'BOSS DOWN +' + e.score, '#ffcf4d', true);
    dropPickup(e.x, e.y, 'heart'); dropPickup(e.x + 30, e.y, 'bomb'); dropPickup(e.x - 30, e.y, 'magnet');
    const nCores = G.weeee ? 8 : 2;
    for (let i = 0; i < nCores; i++) dropPowerup(e.x + rand(-50, 50), e.y + rand(-50, 50));
    for (let i = 0; i < 10; i++) dropGem(e.x + rand(-60, 60), e.y + rand(-60, 60), Math.random() < 0.4 ? 20 : 5);
    G.boss = null; $('boss-bar-wrap').classList.add('hidden');
    onBossDown(e);
  } else {
    AudioSys.enemyDie();
    if (e.type === 'splitter') {
      for (let i = 0; i < 3; i++) spawnEnemy('mini', e.x + rand(-14, 14), e.y + rand(-14, 14));
    }
    if (Math.random() < 0.012) dropPickup(e.x, e.y, 'heart');
    else if (Math.random() < 0.010) dropPickup(e.x, e.y, 'bomb');
    else if (Math.random() < 0.008) dropPickup(e.x, e.y, 'magnet');
    else if (Math.random() < 0.016 * (G.weeee ? 10 : 1)) dropPowerup(e.x, e.y);
    if (e.type === 'bulwark' && Math.random() < (G.weeee ? 1 : 0.15)) dropPowerup(e.x, e.y);
    dropGem(e.x, e.y, e.xp);
    if (e.r > 20) { addShake(0.25); G.hitstop = Math.max(G.hitstop, 0.03); }
  }
}
function hurtPlayer(dmg, sx, sy) {
  if (!player.alive || player.invuln > 0 || player.dashT > 0 || G.state !== 'playing') return;
  if (player.fx.titan > 0 || player.fx.aegis > 0) {
    burst(player.x, player.y, player.fx.titan > 0 ? '#7cff6b' : '#4da6ff', 6, 260, 0.3, 3);
    return;
  }
  player.shieldT = 0;
  if (player.shield > 0) {
    const absorbed = Math.min(player.shield, dmg);
    player.shield -= absorbed; dmg -= absorbed;
    burst(player.x, player.y, '#35e0ff', 8, 300, 0.35, 3);
    if (dmg <= 0) { AudioSys.hit(); return;
    }
  }
  dmg = Math.max(1, Math.round(dmg - player.armor));
  player.hp -= dmg;
  player.invuln = 0.6;
  addShake(0.5); flash(0.25); AudioSys.hurt();
  floater(player.x, player.y - 24, '-' + dmg, '#ff5d7a', true);
  burst(player.x, player.y, '#ff2d78', 14, 380, 0.5, 4);
  if (sx != null) { player.vx += (player.x - sx) * 4; player.vy += (player.y - sy) * 4; }
  if (player.hp <= 0) { player.hp = 0; gameOver(); }
}
function dropGem(x, y, v) {
  if (gems.length > 600) gems.shift();
  gems.push({ x: x + rand(-6, 6), y: y + rand(-6, 6), vx: rand(-60, 60), vy: rand(-60, 60), v, life: 25 });
}
function dropPickup(x, y, kind) {
  pickups.push({ x, y, kind, life: 18, bob: rand(0, TAU) });
}
function dropPowerup(x, y, kind) {
  if (powerups.length > 40) return;
  const ids = Object.keys(POWERUPS);
  powerups.push({ x: x + rand(-8, 8), y: y + rand(-8, 8), vx: rand(-50, 50), vy: rand(-50, 50), kind: kind || ids[randi(0, ids.length - 1)], life: 20, bob: rand(0, TAU) });
}
function collectPowerup(kind) {
  const P = POWERUPS[kind], p = player;
  if (p.items.length >= 3) return false; // pouch full — leave the core in the world
  p.items.push(kind);
  floater(p.x, p.y - 34, P.name + ' STORED', P.color, true);
  toast(P.name + ' stored — press E (or tap pouch) to unleash!');
  burst(p.x, p.y, P.color, 14, 300, 0.4, 3.5);
  AudioSys.pickup();
  updatePouch();
  return true;
}
function activateItem(i) {
  const p = player;
  if (G.state !== 'playing' || !p || !p.alive) return;
  if (i == null) i = 0;
  const kind = p.items[i];
  if (!kind) return;
  p.items.splice(i, 1);
  const P = POWERUPS[kind];
  p.fx[kind] = P.dur;
  floater(p.x, p.y - 34, P.name + '!', P.color, true);
  burst(p.x, p.y, P.color, 26, 380, 0.6, 4);
  if (kind === 'titan') { AudioSys.titan(); addShake(0.7); flash(0.2); G.hitstop = Math.max(G.hitstop, 0.08); }
  else AudioSys.power();
  updatePouch();
}
function updatePouch() {
  const w = $('pouch'); if (!w || !player) return;
  w.innerHTML = '';
  player.items.forEach((kind, i) => {
    const P = POWERUPS[kind];
    const el = document.createElement('div');
    el.className = 'pslot'; el.style.borderColor = P.color;
    el.innerHTML = `<img alt=""><span class="pkey">${i + 1}</span>`;
    if (SPRITES[kind]) el.querySelector('img').src = SPRITES[kind].url;
    el.title = P.name + ' — ' + P.desc + ' (press ' + (i + 1) + ' or E)';
    el.onclick = () => activateItem(i);
    w.appendChild(el);
  });
}
function gainXp(v) {
  if (G.weeee) v *= 10;
  player.xp += v;
  AudioSys.gem();
  while (player.xp >= player.xpNext) {
    player.xp -= player.xpNext;
    player.level++;
    player.xpNext = Math.floor(8 + player.level * 6 + Math.pow(player.level, 1.6));
    G.pendingLevels++;
    AudioSys.levelup();
    burst(player.x, player.y, '#ffcf4d', 30, 320, 0.7, 4);
  }
  if (G.pendingLevels > 0 && G.state === 'playing') {
    if (G.weeee) { while (G.pendingLevels > 0) { G.pendingLevels--; autoUpgrade(); } }
    else openLevelUp();
  }
}
function autoUpgrade() {
  const picks = rollUpgradeChoices();
  const c = picks[randi(0, picks.length - 1)];
  if (!c) return;
  if (c.kind === 'wnew') { player.weapons[c.id] = 1; player.wcd[c.id] = 0; }
  else if (c.kind === 'wup') player.weapons[c.id]++;
  else applyStat(c.id);
  floater(player.x, player.y - 40, 'AUTO LV ' + player.level, '#ffcf4d', true);
  updateWeaponsHUD();
}

/* ---------------- spawning ---------------- */
function scaleForWave() {
  const t = G.time / 60;
  return 1 + (G.wave - 1) * 0.22 + t * 0.28;
}
function spawnEnemy(type, x, y) {
  const b = ENEMY_TYPES[type]; if (!b) return;
  const d = G.diffM, s = scaleForWave();
  const e = {
    type, x, y, vx: 0, vy: 0, kx: 0, ky: 0,
    hp: b.hp * s * d.hpM, maxHp: b.hp * s * d.hpM,
    spd: b.spd * d.spdM * rand(0.9, 1.1), dmg: b.dmg * d.dmgM,
    r: b.r, xp: b.xp, score: b.score, color: b.color,
    t: rand(0, 10), fireT: rand(1, 2.5), dashT: 0, dashCd: rand(1, 3), dx: 0, dy: 0,
    hitT: 0, dead: false, boss: false,
  };
  enemies.push(e);
  return e;
}
function spawnPos() {
  const a = rand(0, TAU), R = (Math.hypot(W, H) / 2 + rand(60, 200)) / G.zoom;
  return { x: player.x + Math.cos(a) * R, y: player.y + Math.sin(a) * R };
}
function unlockedTypes() {
  const w = G.wave, t = [];
  t.push('chaser', 'chaser', 'chaser');
  if (w >= 1) t.push('weaver');
  if (w >= 2) t.push('dasher', 'dasher');
  if (w >= 2) t.push('splitter');
  if (w >= 3) t.push('stinger', 'stinger');
  if (w >= 4) t.push('bulwark');
  if (w >= 6) t.push('dasher', 'stinger', 'bulwark');
  return t;
}
const BOSS_DEFS = {
  5: { name: 'VOID WARDEN', hp: 1400, r: 42, spd: 70, color: '#ff4444', score: 2500 },
  10: { name: 'STAR REAPER', hp: 3400, r: 48, spd: 85, color: '#b26bff', score: 6000 },
  15: { name: 'LEVIATHAN', hp: 6500, r: 56, spd: 65, color: '#ff7a3d', score: 12000 },
  20: { name: '☠ VOID MOTHER ☠', hp: 11000, r: 70, spd: 55, color: '#ff2d78', score: 30000 },
};
function spawnBoss(wave) {
  const d = BOSS_DEFS[wave]; if (!d) return;
  const p = spawnPos();
  const e = {
    type: 'boss', bossWave: wave, name: d.name, x: p.x, y: p.y, vx: 0, vy: 0, kx: 0, ky: 0,
    hp: d.hp * (0.7 + G.diffM.hpM * 0.5) * (1 + G.time / 600), maxHp: 0,
    spd: d.spd, dmg: 25 * G.diffM.dmgM, r: d.r, xp: 0, score: d.score, color: d.color,
    t: 0, fireT: 2, dashT: 0, dashCd: 4, dx: 0, dy: 0, hitT: 0, dead: false, boss: true,
    pat: 0, patT: 3,
  };
  e.maxHp = e.hp;
  enemies.push(e);
  G.boss = e;
  $('boss-bar-wrap').classList.remove('hidden');
  $('boss-name').textContent = d.name;
  announce('⚠ ' + d.name + ' ⚠', '#ff4444');
  AudioSys.warn(); addShake(0.6);
}
function onBossDown(e) {
  if (e.bossWave === 20 && !G.endless && !G.won) {
    G.won = true;
    setTimeout(() => { if (G.state === 'playing') victory(); }, 1200);
  } else {
    toast('Boss destroyed! +1 bomb');
    player.bombs = Math.min(player.maxBombs, player.bombs + 1);
  }
}

/* ---------------- weapons fire ---------------- */
function aimAngle() { return player.aim; }
function fireBullet(x, y, ang, spd, dmg, r, color, pierce, homing, life) {
  if (pBullets.length > (G.weeee ? 2000 : 500)) return;
  pBullets.push({ x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, dmg: dmg * player.dmgM * (player.fx.rampage > 0 ? 2 : 1), r: r || 5, color, pierce: pierce || 0, homing: !!homing, life: life || 1.6, hitSet: homing ? null : new Set() });
}
function updateWeapons(dt) {
  const w = player.weapons, cd = player.wcd, m = player.rateM * (player.fx.overdrive > 0 ? 2 : 1);
  const split = player.fx.splitfire > 0;
  const firing = settings.autofire || mouse.down || touch.firing || keys['KeyJ'];
  const ax = aimAngle();
  // Blaster
  if (w.blaster) {
    cd.blaster -= dt;
    const lv = w.blaster;
    if (firing && cd.blaster <= 0) {
      cd.blaster = Math.max(0.07, 0.24 - lv * 0.014) / m;
      if (G.weeee) {
        for (let i = 0; i < 21; i++) {
          const a2 = ax + (i / 20 - 0.5) * 1.0;
          fireBullet(player.x + Math.cos(ax) * 20, player.y + Math.sin(ax) * 20, a2, 900, 11 + lv * 3.2, 5, '#35e0ff', 2);
        }
      } else {
        const n = lv >= 5 ? 2 : 1;
        for (let i = 0; i < n; i++) {
          const off = n === 2 ? (i === 0 ? -5 : 5) : 0;
          const px = player.x + Math.cos(ax) * 20 - Math.sin(ax) * off;
          const py = player.y + Math.sin(ax) * 20 + Math.cos(ax) * off;
          fireBullet(px, py, ax + rand(-0.03, 0.03), 900, 11 + lv * 3.2, 5, '#35e0ff', lv >= 7 ? 2 : lv >= 3 ? 1 : 0);
        }
        if (split) {
          for (const sa of [-0.14, 0.14]) fireBullet(player.x + Math.cos(ax) * 20, player.y + Math.sin(ax) * 20, ax + sa, 900, 11 + lv * 3.2, 5, '#35e0ff', 0);
        }
      }
      burst(player.x + Math.cos(ax) * 24, player.y + Math.sin(ax) * 24, '#35e0ff', 1, 120, 0.12, 3);
      AudioSys.shoot();
      player.vx -= Math.cos(ax) * 14; player.vy -= Math.sin(ax) * 14;
    }
  }
  // Spread
  if (w.spread) {
    cd.spread -= dt;
    const lv = w.spread;
    if (firing && cd.spread <= 0) {
      cd.spread = Math.max(0.3, 0.75 - lv * 0.035) / m;
      const n = (4 + Math.min(4, Math.floor(lv / 1.5)) + (split ? 2 : 0)) * (G.weeee ? 5 : 1);
      for (let i = 0; i < n; i++) {
        const a = ax + (i / (n - 1) - 0.5) * (0.7 + lv * 0.03 + (split ? 0.3 : 0) + (G.weeee ? 1.2 : 0));
        fireBullet(player.x, player.y, a, rand(700, 850), 8 + lv * 2.4, 5, '#ffb020', 0, false, 0.55);
      }
      addShake(0.08); AudioSys.spread();
    }
  }
  // Railgun
  if (w.railgun) {
    cd.railgun -= dt;
    const lv = w.railgun;
    if (firing && cd.railgun <= 0) {
      cd.railgun = Math.max(0.6, 1.5 - lv * 0.09) / m;
      fireBullet(player.x, player.y, ax, 1600, 50 + lv * 22, 7, '#b26bff', 6 + lv, false, 1.1);
      if (split) {
        for (const sa of [-0.1, 0.1]) fireBullet(player.x, player.y, ax + sa, 1600, 50 + lv * 22, 7, '#b26bff', 6 + lv, false, 1.1);
      }
      if (G.weeee) {
        for (let i = 0; i < 9; i++) fireBullet(player.x, player.y, ax + (i / 8 - 0.5) * 0.8, 1600, 50 + lv * 22, 7, '#b26bff', 6 + lv, false, 1.1);
      }
      burst(player.x, player.y, '#b26bff', 8, 300, 0.3, 4);
      addShake(0.15); AudioSys.rail();
    }
  }
  // Missiles
  if (w.missiles) {
    cd.missiles -= dt;
    const lv = w.missiles;
    if (cd.missiles <= 0) {
      cd.missiles = Math.max(0.3, 0.95 - lv * 0.07) / m;
      const n = (1 + Math.floor(lv / 3) + (split ? 1 : 0)) * (G.weeee ? 8 : 1);
      for (let i = 0; i < n; i++) fireBullet(player.x, player.y, ax + Math.PI + rand(-0.6, 0.6), 420, 16 + lv * 7, 6, '#ff7a3d', 0, true, 3);
      AudioSys.missile();
    }
  }
  // Orbitals — damage applied in collision step
  // Tesla
  if (w.tesla) {
    cd.tesla -= dt;
    const lv = w.tesla;
    if (cd.tesla <= 0) {
      cd.tesla = Math.max(0.4, 1.15 - lv * 0.07) / m;
      // find nearest
      let best = null, bd = 520 * 520;
      for (const e of enemies) {
        if (e.dead) continue;
        const d2 = hyp2(e.x - player.x, e.y - player.y);
        if (d2 < bd) { bd = d2; best = e; }
      }
      if (best) {
        const chains = 2 + Math.floor(lv / 2) + (player.fx.splitfire > 0 ? 1 : 0) + (G.weeee ? 8 : 0);
        let from = { x: player.x, y: player.y }, cur = best;
        const hit = new Set();
        for (let i = 0; i < chains && cur; i++) {
          hit.add(cur);
          bolts.push({ x1: from.x, y1: from.y, x2: cur.x, y2: cur.y, life: 0.18, max: 0.18 });
          damageEnemy(cur, (14 + lv * 8) * player.dmgM * (player.fx.rampage > 0 ? 2 : 1), 0, 0);
          from = { x: cur.x, y: cur.y };
          let nb = null, nd = 260 * 260;
          for (const e of enemies) {
            if (e.dead || hit.has(e)) continue;
            const d2 = hyp2(e.x - from.x, e.y - from.y);
            if (d2 < nd) { nd = d2; nb = e; }
          }
          cur = nb;
        }
        AudioSys.zap();
      }
    }
  }
}

/* ---------------- abilities ---------------- */
function tryDash() {
  if (G.state !== 'playing' || !player.alive) return;
  if (player.dashCd > 0) return;
  let dx = 0, dy = 0;
  if (keys['KeyW'] || keys['ArrowUp']) dy -= 1;
  if (keys['KeyS'] || keys['ArrowDown']) dy += 1;
  if (keys['KeyA'] || keys['ArrowLeft']) dx -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) dx += 1;
  if (touch.active && (touch.mx || touch.my)) { dx = touch.mx; dy = touch.my; }
  if (!dx && !dy) { dx = Math.cos(player.aim); dy = Math.sin(player.aim); }
  const m = Math.hypot(dx, dy) || 1;
  player.dashDx = dx / m; player.dashDy = dy / m;
  player.dashT = 0.18; player.dashCd = player.dashCdMax; player.invuln = Math.max(player.invuln, 0.35);
  burst(player.x, player.y, '#35e0ff', 16, 420, 0.4, 4);
  AudioSys.dash();
}
function fireBomb() {
  if (G.state !== 'playing' || !player.alive) return;
  if (player.bombs <= 0) { toast('No bombs! (Q)'); return; }
  player.bombs--;
  flash(0.5); addShake(1); G.hitstop = Math.max(G.hitstop, 0.1);
  AudioSys.bomb();
  burst(player.x, player.y, '#ffcf4d', 80, 700, 0.9, 6);
  burst(player.x, player.y, '#ff2d78', 50, 500, 0.8, 5);
  // clear enemy bullets -> score
  G.score += eBullets.length * 10;
  eBullets.length = 0;
  for (const e of enemies) {
    if (e.dead) continue;
    const d = Math.hypot(e.x - player.x, e.y - player.y);
    if (d < 620) damageEnemy(e, e.boss ? 400 : 220, (e.x - player.x) * 2, (e.y - player.y) * 2);
  }
  updateBombHUD();
}

/* ---------------- level up ---------------- */
function rollUpgradeChoices() {
  const pool = [];
  // weapon new / upgrades
  for (const id of Object.keys(WEAPONS)) {
    const lv = player.weapons[id] || 0;
    if (lv === 0) {
      if (Object.keys(player.weapons).length < 6) pool.push({ kind: 'wnew', id, w: 3 });
    } else if (lv < 8) pool.push({ kind: 'wup', id, w: 3 });
  }
  for (const s of STAT_POOL) {
    if (s.id === 'bomb' && player.bombs >= player.maxBombs) continue;
    if (s.id === 'heal' && player.hp >= player.maxHp) continue;
    pool.push({ kind: 'stat', id: s.id, w: 2 });
  }
  const picks = [];
  const bag = pool.slice();
  while (picks.length < 3 && bag.length) {
    let tot = 0; for (const p of bag) tot += p.w;
    let r = Math.random() * tot, idx = 0;
    for (; idx < bag.length; idx++) { r -= bag[idx].w; if (r <= 0) break; }
    idx = Math.min(idx, bag.length - 1);
    picks.push(bag.splice(idx, 1)[0]);
  }
  return picks;
}
let currentChoices = [];
function openLevelUp() {
  G.state = 'levelup';
  $('lvl-num').textContent = 'LV ' + player.level;
  buildCards();
  showScreen('levelup');
}
function buildCards() {
  currentChoices = rollUpgradeChoices();
  const wrap = $('cards'); wrap.innerHTML = '';
  $('reroll-count').textContent = G.rerolls + ' reroll(s) left';
  $('btn-reroll').textContent = `⟳ REROLL (${G.rerolls})`;
  currentChoices.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'card' + (c.kind === 'wnew' ? ' new' : '');
    let ico, name, tag, desc, lvl;
    if (c.kind === 'wnew') {
      const wdef = WEAPONS[c.id];
      ico = wdef.ico; name = wdef.name; tag = '★ NEW WEAPON'; desc = wdef.desc; lvl = '→ LV 1';
    } else if (c.kind === 'wup') {
      const wdef = WEAPONS[c.id];
      ico = wdef.ico; name = wdef.name; tag = 'WEAPON UP'; desc = upgradeText(c.id, player.weapons[c.id]); lvl = `LV ${player.weapons[c.id]} → ${player.weapons[c.id] + 1}`;
    } else {
      const s = STAT_POOL.find(s => s.id === c.id);
      ico = s.ico; name = s.name; tag = s.tag; desc = s.desc; lvl = '';
    }
    el.innerHTML = `<div class="c-ico">${ico}</div><div class="c-tag">${tag}</div><h3>${name}</h3><p>${desc}</p><div class="c-lvl">${lvl} &nbsp;·&nbsp; [${i + 1}]</div>`;
    el.onclick = () => pickUpgrade(i);
    wrap.appendChild(el);
  });
}
function upgradeText(id, lv) {
  switch (id) {
    case 'blaster': return `+damage, ${lv >= 4 ? 'double bolts, ' : ''}faster trigger.`;
    case 'spread': return `+${lv % 2 ? 'shell & ' : ''}damage, faster pump.`;
    case 'railgun': return `+massive damage & pierce. Deletes tanks.`;
    case 'missiles': return `+blast damage${lv >= 2 ? ', extra missile every 3 lv' : ''}, faster launch.`;
    case 'orbitals': return `+blade damage, size & spin${lv >= 3 ? ', +1 blade at 4/7' : ''}.`;
    case 'tesla': return `+zap damage & +1 chain every 2 lv.`;
    default: return 'More power.';
  }
}
function pickUpgrade(i) {
  const c = currentChoices[i]; if (!c) return;
  AudioSys.ui();
  if (c.kind === 'wnew') { player.weapons[c.id] = 1; player.wcd[c.id] = 0; toast(`Acquired ${WEAPONS[c.id].name}!`); }
  else if (c.kind === 'wup') { player.weapons[c.id]++; toast(`${WEAPONS[c.id].name} → LV ${player.weapons[c.id]}`); }
  else applyStat(c.id);
  updateWeaponsHUD();
  G.pendingLevels--;
  if (G.pendingLevels > 0) { buildCards(); $('lvl-num').textContent = 'LV ' + player.level; }
  else { showScreen(null); G.state = 'playing'; }
}
function applyStat(id) {
  switch (id) {
    case 'hp': player.maxHp += 25; player.hp = Math.min(player.maxHp, player.hp + 25); break;
    case 'spd': player.speed *= 1.10; break;
    case 'mag': player.magnet *= 1.45; break;
    case 'armor': player.armor += 1; break;
    case 'crit': player.crit += 0.08; break;
    case 'rate': player.rateM *= 1.10; break;
    case 'regen': player.regen += 0.8; break;
    case 'dash': player.dashCdMax = Math.max(0.8, player.dashCdMax * 0.78); break;
    case 'bomb': player.bombs = Math.min(player.maxBombs, player.bombs + 1); updateBombHUD(); break;
    case 'shield': player.maxShield += 40; player.shield = player.maxShield; break;
    case 'heal': player.hp = Math.min(player.maxHp, player.hp + player.maxHp * 0.5); break;
    case 'dmg': player.dmgM *= 1.12; break;
  }
}

/* ---------------- pause / over / victory ---------------- */
function pauseGame() {
  if (G.state !== 'playing') return;
  G.state = 'paused'; showScreen('pause'); AudioSys.ui();
}
function resumeGame() {
  if (G.state !== 'paused') return;
  G.state = 'playing'; showScreen(null); AudioSys.ui();
}
function togglePause() {
  if (G.state === 'playing') pauseGame();
  else if (G.state === 'paused') resumeGame();
}
function endStats() {
  const best = store.get('best', 0);
  const isBest = G.score > best;
  if (isBest) store.set('best', G.score);
  store.set('bestWave', Math.max(store.get('bestWave', 0), G.wave));
  return isBest;
}
function gameOver() {
  player.alive = false;
  G.state = 'over';
  addShake(1); flash(0.6); AudioSys.bigBoom(); AudioSys.stopMusic();
  burst(player.x, player.y, '#35e0ff', 70, 600, 1, 6);
  burst(player.x, player.y, '#ffffff', 40, 400, 0.8, 4);
  const isBest = endStats();
  setTimeout(() => {
    $('go-title').textContent = ['SIGNAL LOST', 'SHIP DESTROYED', 'VOID CLAIMS YOU'][randi(0, 2)];
    $('go-score').textContent = G.score.toLocaleString();
    $('go-wave').textContent = G.wave;
    $('go-time').textContent = fmtTime(G.time);
    $('go-kills').textContent = G.kills.toLocaleString();
    $('go-level').textContent = player.level;
    $('go-best').textContent = Math.max(store.get('best', 0), G.score).toLocaleString();
    $('go-newbest').classList.toggle('hidden', !isBest);
    showScreen('gameover'); $('hud').classList.add('hidden');
  }, 1100);
}
function victory() {
  G.state = 'victory';
  AudioSys.victory(); AudioSys.stopMusic();
  store.set('wins', store.get('wins', 0) + 1);
  const isBest = endStats();
  $('vic-score').textContent = G.score.toLocaleString();
  $('vic-time').textContent = fmtTime(G.time);
  $('vic-kills').textContent = G.kills.toLocaleString();
  $('vic-level').textContent = player.level;
  $('vic-newbest').classList.toggle('hidden', !isBest);
  showScreen('victory'); $('hud').classList.add('hidden');
}

/* ---------------- update ---------------- */
function update(dt) {
  G.time += dt;
  // wave clock
  G.waveT += dt;
  const WAVE_LEN = 30;
  if (G.waveT >= WAVE_LEN) {
    G.waveT -= dt; G.waveT = 0; G.wave++;
    if (!G.endless && BOSS_DEFS[G.wave]) { bossWarnT = 2; }
    else announce('WAVE ' + G.wave, '#35e0ff');
    AudioSys.warn();
    if (!G.endless && BOSS_DEFS[G.wave]) setTimeout(() => { if (G.state === 'playing' || G.state === 'levelup') spawnBoss(G.wave); }, 1500);
    if (G.wave % 3 === 0) { player.bombs = Math.min(player.maxBombs, player.bombs + 1); updateBombHUD(); toast('+1 bomb cache'); }
  }

  // combo decay
  if (G.comboT > 0) { G.comboT -= dt; if (G.comboT <= 0) G.combo = 0; }

  updatePlayer(dt);
  updateWeapons(dt);
  updateEnemies(dt);
  updateBullets(dt);
  updateGemsPickups(dt);
  updateFx(dt);

  // spawner
  G.spawnT -= dt;
  if (G.spawnT <= 0) {
    const bossAlive = !!G.boss && !G.boss.dead;
    const interval = clamp(1.1 - G.wave * 0.045 - G.time / 600, 0.18, 1.1) * (bossAlive ? 2.2 : 1);
    G.spawnT = interval;
    const cap = Math.min(40 + G.wave * 8, 240);
    if (enemies.length < cap) {
      const n = 1 + Math.floor(G.wave / 3) + (Math.random() < 0.3 ? 1 : 0);
      const types = unlockedTypes();
      for (let i = 0; i < n; i++) {
        const p = spawnPos();
        spawnEnemy(types[randi(0, types.length - 1)], p.x, p.y);
      }
    }
  }

  // camera
  cam.x = lerp(cam.x, player.x, 1 - Math.pow(0.0001, dt));
  cam.y = lerp(cam.y, player.y, 1 - Math.pow(0.0001, dt));
  G.shake = Math.max(0, G.shake - dt * 2.2);
  if (bossWarnT > 0) bossWarnT -= dt;

  updateHUD();
}

function updatePlayer(dt) {
  const p = player;
  if (!p.alive) return;
  const titanOn = p.fx.titan > 0;
  // aim
  if (touch.active && touch.firing) {
    p.aim = Math.atan2(touch.ay, touch.ax);
  } else if (!(touch.active && (touch.ax || touch.ay)) || true) {
    const sx = p.x - cam.x + W / 2, sy = p.y - cam.y + H / 2;
    // mouse screen pos -> world dir
    const wx = cam.x + (mouse.x - W / 2) / G.zoom, wy = cam.y + (mouse.y - H / 2) / G.zoom;
    p.aim = Math.atan2(wy - p.y, wx - p.x);
  }
  // move
  let dx = 0, dy = 0;
  if (keys['KeyW'] || keys['ArrowUp']) dy -= 1;
  if (keys['KeyS'] || keys['ArrowDown']) dy += 1;
  if (keys['KeyA'] || keys['ArrowLeft']) dx -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) dx += 1;
  if (touch.active) { dx += touch.mx; dy += touch.my; }
  const m = Math.hypot(dx, dy);
  if (m > 1) { dx /= m; dy /= m; }
  if ((keys['ShiftLeft'] || keys['ShiftRight'] || keys['Space']) ) { if (!G._dashHeld) { tryDash(); G._dashHeld = true; } }
  else G._dashHeld = false;
  if (p.dashT > 0) {
    p.dashT -= dt;
    p.vx = p.dashDx * 950; p.vy = p.dashDy * 950;
    if (Math.random() < 0.7) parts.push({ x: p.x, y: p.y, vx: rand(-50, 50), vy: rand(-50, 50), life: 0.35, max: 0.35, size: 4, color: '#35e0ff', drag: 2 });
  } else {
    const acc = 2600;
    p.vx += dx * acc * dt; p.vy += dy * acc * dt;
    const fr = Math.pow(0.0001, dt); // friction-ish
    // cap speed
    const sp = Math.hypot(p.vx, p.vy), max = p.speed * (m > 0.1 ? 1 : 0.3);
    if (sp > max && max > 0) { p.vx = p.vx / sp * lerp(sp, max, 1 - Math.pow(0.001, dt)); p.vy = p.vy / sp * lerp(sp, max, 1 - Math.pow(0.001, dt)); }
    if (m < 0.1) { p.vx *= Math.pow(0.001, dt); p.vy *= Math.pow(0.001, dt); }
  }
  p.x += p.vx * dt; p.y += p.vy * dt;
  // engine trail
  if (m > 0.1 && Math.random() < 0.5) {
    parts.push({ x: p.x - Math.cos(p.aim) * 10, y: p.y - Math.sin(p.aim) * 10, vx: rand(-60, 60) - p.vx * 0.1, vy: rand(-60, 60) - p.vy * 0.1, life: 0.3, max: 0.3, size: 2.5, color: '#35e0ff', drag: 2 });
  }
  // titan stomp trail
  if (titanOn && Math.random() < 0.7) {
    parts.push({ x: p.x + rand(-30, 30), y: p.y + rand(-30, 30), vx: rand(-80, 80), vy: rand(-80, 80), life: 0.45, max: 0.45, size: rand(4, 8), color: '#7cff6b', drag: 2 });
  }
  // timers
  p.dashCd = Math.max(0, p.dashCd - dt);
  p.invuln = Math.max(0, p.invuln - dt);
  p.shieldT += dt;
  // power-up timers
  for (const k of Object.keys(p.fx)) {
    if (p.fx[k] > 0) {
      p.fx[k] = Math.max(0, p.fx[k] - dt);
      if (p.fx[k] === 0 && k === 'titan') { burst(p.x, p.y, '#7cff6b', 24, 380, 0.5, 4); addShake(0.3); }
    }
  }
  if (p.regen > 0 && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + p.regen * dt);
  if (p.maxShield > 0 && p.shield < p.maxShield && p.shieldT > 6) p.shield = Math.min(p.maxShield, p.shield + p.maxShield * 0.25 * dt);
  // enemy contact (TITAN FORM crushes instead of being hurt)
  for (const e of enemies) {
    if (e.dead) continue;
    const rr = e.r + (titanOn ? 52 : p.r);
    if (hyp2(e.x - p.x, e.y - p.y) < rr * rr) {
      if (titanOn) {
        if (!e._crushT || G.time - e._crushT > 0.3) {
          e._crushT = G.time;
          const d = Math.hypot(e.x - p.x, e.y - p.y) || 1;
          damageEnemy(e, e.boss ? 350 : 500, (e.x - p.x) / d * 900, (e.y - p.y) / d * 900);
          burst(e.x, e.y, '#7cff6b', 10, 420, 0.4, 5);
          addShake(0.2); AudioSys.enemyDie();
        }
      } else {
        hurtPlayer(e.dmg, e.x, e.y);
        // push enemy back so it doesn't stick
        const d = Math.hypot(e.x - p.x, e.y - p.y) || 1;
        e.kx += (e.x - p.x) / d * 260; e.ky += (e.y - p.y) / d * 260;
        break;
      }
    }
  }
  // orbitals damage
  const orbLv = p.weapons.orbitals || 0;
  if (orbLv > 0) {
    const n = orbLv >= 7 ? 5 : orbLv >= 4 ? 4 : 3;
    const R = 70 + orbLv * 6, dmg = (16 + orbLv * 9) * p.dmgM * (p.fx.rampage > 0 ? 2 : 1);
    for (let i = 0; i < n; i++) {
      const a = G.time * (2.2 + orbLv * 0.12) + i * TAU / n;
      const bx = p.x + Math.cos(a) * R, by = p.y + Math.sin(a) * R;
      for (const e of enemies) {
        if (e.dead) continue;
        const rr = e.r + 16;
        if (hyp2(e.x - bx, e.y - by) < rr * rr) {
          if (!e._orbT || G.time - e._orbT > 0.28) { e._orbT = G.time; damageEnemy(e, dmg, (e.x - p.x) * 1.5, (e.y - p.y) * 1.5); }
        }
      }
    }
  }
}

function enemyShoot(e, ang, spd, dmg, r, color) {
  eBullets.push({ x: e.x, y: e.y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, dmg, r: r || 6, color: color || '#ff5d7a', life: 5 });
}
function updateEnemies(dt) {
  const p = player;
  for (const e of enemies) {
    if (e.dead) continue;
    e.t += dt; e.hitT = Math.max(0, (e.hitT || 0) - dt);
    const dx = p.x - e.x, dy = p.y - e.y;
    const d = Math.hypot(dx, dy) || 1, nx = dx / d, ny = dy / d;
    // knockback decay
    e.x += (e.kx || 0) * dt; e.y += (e.ky || 0) * dt;
    e.kx = (e.kx || 0) * Math.pow(0.001, dt); e.ky = (e.ky || 0) * Math.pow(0.001, dt);

    // DEEP FROST: normals freeze solid, bosses crawl and can't fire
    const frozen = player.fx.frost > 0;
    if (frozen && !e.boss) {
      if (Math.random() < 0.08) parts.push({ x: e.x + rand(-e.r, e.r), y: e.y + rand(-e.r, e.r), vx: 0, vy: -40, life: 0.5, max: 0.5, size: 3, color: '#bfefff', drag: 1 });
      continue;
    }

    if (e.boss) {
      const bSpd = frozen ? 0.35 : 1;
      e.x += nx * e.spd * bSpd * dt; e.y += ny * e.spd * bSpd * dt;
      e.patT -= dt; e.fireT -= dt;
      if (frozen) e.fireT = Math.max(e.fireT, 0.6);
      if (e.patT <= 0) { e.pat = randi(0, 2); e.patT = rand(2.5, 4); }
      if (e.fireT <= 0) {
        const w = e.bossWave;
        if (e.pat === 0) { // radial
          const n = 10 + w, base = rand(0, TAU);
          for (let i = 0; i < n; i++) enemyShoot(e, base + i * TAU / n, 200, 12 * G.diffM.dmgM, 6, e.color);
          e.fireT = 1.6; AudioSys.spread();
        } else if (e.pat === 1) { // aimed fan
          const base = Math.atan2(dy, dx);
          for (let i = -2; i <= 2; i++) enemyShoot(e, base + i * 0.16, 320, 14 * G.diffM.dmgM, 6, e.color);
          e.fireT = 1.1; AudioSys.shoot();
        } else { // spawn minions + charge
          for (let i = 0; i < 3 + Math.floor(w / 5); i++) spawnEnemy(Math.random() < 0.5 ? 'chaser' : 'weaver', e.x + rand(-60, 60), e.y + rand(-60, 60));
          e.kx += nx * 500; e.ky += ny * 500;
          e.fireT = 2.2;
        }
      }
      continue;
    }
    switch (e.type) {
      case 'chaser':
        e.x += nx * e.spd * dt; e.y += ny * e.spd * dt;
        break;
      case 'weaver': {
        const s = Math.sin(e.t * 5) * 120;
        e.x += (nx * e.spd - ny * s) * dt; e.y += (ny * e.spd + nx * s) * dt;
        break;
      }
      case 'dasher':
        e.dashCd -= dt;
        if (e.dashT > 0) { e.dashT -= dt; e.x += e.dx * 520 * dt; e.y += e.dy * 520 * dt; }
        else {
          e.x += nx * e.spd * 0.5 * dt; e.y += ny * e.spd * 0.5 * dt;
          if (e.dashCd <= 0 && d < 420) { e.dashT = 0.35; e.dashCd = rand(1.6, 2.8); e.dx = nx; e.dy = ny; }
        }
        break;
      case 'splitter':
        e.x += nx * e.spd * dt; e.y += ny * e.spd * dt;
        break;
      case 'mini':
        e.x += nx * e.spd * dt; e.y += ny * e.spd * dt;
        break;
      case 'stinger':
        e.fireT -= dt;
        if (d > 420) { e.x += nx * e.spd * dt; e.y += ny * e.spd * dt; }
        else if (d < 280) { e.x -= nx * e.spd * dt; e.y -= ny * e.spd * dt; }
        else { e.x += -ny * Math.sin(e.t * 2) * e.spd * 0.6 * dt; e.y += nx * Math.sin(e.t * 2) * e.spd * 0.6 * dt; }
        if (e.fireT <= 0 && d < 700) {
          e.fireT = rand(1.4, 2.2);
          const base = Math.atan2(dy, dx);
          enemyShoot(e, base, 280, e.dmg, 6, '#b26bff');
        }
        break;
      case 'bulwark':
        e.x += nx * e.spd * dt; e.y += ny * e.spd * dt;
        break;
    }
  }
  // remove dead + far cleanup
  if (enemies.length > 600) enemies = enemies.filter(e => !e.dead);
  else if (enemies.some(e => e.dead)) enemies = enemies.filter(e => !e.dead);
  // cull ultra-far non-boss
  for (const e of enemies) {
    if (!e.boss && Math.hypot(e.x - p.x, e.y - p.y) > 4000) { e.dead = true; }
  }
  enemies = enemies.filter(e => !e.dead);
}

function updateBullets(dt) {
  // player bullets
  for (const b of pBullets) {
    b.life -= dt;
    if (b.homing) {
      let best = null, bd = 700 * 700;
      for (const e of enemies) {
        if (e.dead) continue;
        const d2 = hyp2(e.x - b.x, e.y - b.y);
        if (d2 < bd) { bd = d2; best = e; }
      }
      if (best) {
        const want = Math.atan2(best.y - b.y, best.x - b.x);
        const cur = Math.atan2(b.vy, b.vx);
        let diff = want - cur;
        while (diff > Math.PI) diff -= TAU; while (diff < -Math.PI) diff += TAU;
        const turn = clamp(diff, -5 * dt, 5 * dt);
        const sp = Math.min(950, Math.hypot(b.vx, b.vy) + 900 * dt);
        const na = cur + turn;
        b.vx = Math.cos(na) * sp; b.vy = Math.sin(na) * sp;
      }
      if (Math.random() < 0.5) parts.push({ x: b.x, y: b.y, vx: rand(-40, 40), vy: rand(-40, 40), life: 0.25, max: 0.25, size: 2, color: '#ff7a3d', drag: 2 });
    }
    b.x += b.vx * dt; b.y += b.vy * dt;
    // collide
    for (const e of enemies) {
      if (e.dead) continue;
      if (b.hitSet && b.hitSet.has(e)) continue;
      const rr = e.r + b.r;
      if (hyp2(e.x - b.x, e.y - b.y) < rr * rr) {
        const sp = Math.hypot(b.vx, b.vy) || 1;
        const kx = b.vx / sp * (b.homing ? 300 : 120), ky = b.vy / sp * (b.homing ? 300 : 120);
        if (b.homing) {
          damageEnemy(e, b.dmg, kx, ky);
          burst(b.x, b.y, '#ff7a3d', 10, 300, 0.35, 3.5);
          // splash
          for (const e2 of enemies) {
            if (e2 === e || e2.dead) continue;
            if (hyp2(e2.x - b.x, e2.y - b.y) < 90 * 90) damageEnemy(e2, b.dmg * 0.5, 0, 0);
          }
          b.life = 0; AudioSys.enemyDie();
          break;
        } else {
          damageEnemy(e, b.dmg, kx, ky);
          if (b.pierce > 0) { b.pierce--; b.hitSet.add(e); }
          else { b.life = 0; break; }
        }
      }
    }
  }
  pBullets = pBullets.filter(b => b.life > 0 && Math.abs(b.x - player.x) < 2500 && Math.abs(b.y - player.y) < 2500);
  // enemy bullets
  for (const b of eBullets) {
    b.life -= dt;
    b.x += b.vx * dt; b.y += b.vy * dt;
    const rr = b.r + player.r - 2;
    if (player.alive && hyp2(b.x - player.x, b.y - player.y) < rr * rr) {
      b.life = 0;
      if (player.fx.titan > 0 || player.fx.aegis > 0) burst(b.x, b.y, '#ffffff', 4, 200, 0.25, 2.5);
      else hurtPlayer(b.dmg, b.x - b.vx, b.y - b.vy);
    }
  }
  eBullets = eBullets.filter(b => b.life > 0 && Math.abs(b.x - player.x) < 2000 && Math.abs(b.y - player.y) < 2000);
}

function updateGemsPickups(dt) {
  const p = player;
  for (const g of gems) {
    g.life -= dt;
    g.x += g.vx * dt; g.y += g.vy * dt;
    g.vx *= Math.pow(0.01, dt); g.vy *= Math.pow(0.01, dt);
    const d2 = hyp2(g.x - p.x, g.y - p.y);
    const mr = (g.v > 5 ? p.magnet * 1.3 : p.magnet);
    if (d2 < mr * mr) {
      const d = Math.sqrt(d2) || 1;
      const pull = 1400;
      g.vx += (p.x - g.x) / d * pull * dt * 3; g.vy += (p.y - g.y) / d * pull * dt * 3;
      g.x += g.vx * dt * 2; g.y += g.vy * dt * 2;
    }
    if (d2 < (p.r + 12) * (p.r + 12)) {
      g.life = 0; G.score += g.v * 5 * (G.weeee ? 100 : 1);
      gainXp(g.v);
      burst(g.x, g.y, '#35e0ff', 3, 160, 0.25, 2.5);
    }
  }
  gems = gems.filter(g => g.life > 0);
  for (const k of pickups) {
    k.life -= dt; k.bob += dt * 4;
    const d2 = hyp2(k.x - p.x, k.y - p.y);
    if (d2 < p.magnet * p.magnet) {
      const d = Math.sqrt(d2) || 1;
      k.x += (p.x - k.x) / d * 500 * dt; k.y += (p.y - k.y) / d * 500 * dt;
    }
    if (d2 < (p.r + 14) * (p.r + 14)) {
      k.life = 0;
      if (k.kind === 'heart') { p.hp = Math.min(p.maxHp, p.hp + 30); floater(p.x, p.y - 26, '+30 HULL', '#7cff6b', true); toast('Hull patched +30'); }
      if (k.kind === 'bomb') { p.bombs = Math.min(p.maxBombs, p.bombs + 1); updateBombHUD(); toast('Bomb acquired! (Q)'); }
      if (k.kind === 'magnet') { for (const g of gems) { g.vx += (p.x - g.x) * 4; g.vy += (p.y - g.y) * 4; } toast('Magnet surge!'); }
      AudioSys.pickup();
      burst(k.x, k.y, '#ffcf4d', 12, 260, 0.4, 3.5);
    }
  }
  for (const u of powerups) {
    u.life -= dt; u.bob += dt * 4;
    u.x += u.vx * dt; u.y += u.vy * dt;
    u.vx *= Math.pow(0.01, dt); u.vy *= Math.pow(0.01, dt);
    const d2 = hyp2(u.x - p.x, u.y - p.y);
    if (d2 < p.magnet * p.magnet) {
      const d = Math.sqrt(d2) || 1;
      u.x += (p.x - u.x) / d * 560 * dt; u.y += (p.y - u.y) / d * 560 * dt;
    }
    if (d2 < (p.r + 16) * (p.r + 16)) {
      if (collectPowerup(u.kind)) {
        u.life = 0;
      } else if (!u.fullT || G.time - u.fullT > 2) {
        u.fullT = G.time;
        floater(p.x, p.y - 30, 'POUCH FULL — press E!', '#ffcf4d', true);
      }
    } else if (Math.random() < 0.1) {
      parts.push({ x: u.x + rand(-14, 14), y: u.y + rand(-14, 14), vx: 0, vy: -40, life: 0.4, max: 0.4, size: 2, color: POWERUPS[u.kind].color, drag: 1 });
    }
  }
  powerups = powerups.filter(u => u.life > 0);
  pickups = pickups.filter(k => k.life > 0);
}

function updateFx(dt) {
  for (const q of parts) { q.life -= dt; q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= Math.pow(0.05, dt / (q.drag || 3)); q.vy *= Math.pow(0.05, dt / (q.drag || 3)); }
  parts = parts.filter(q => q.life > 0);
  for (const f of floaters) { f.life -= dt; f.y -= 55 * dt; }
  floaters = floaters.filter(f => f.life > 0);
  for (const b of bolts) b.life -= dt;
  bolts = bolts.filter(b => b.life > 0);
}

/* ---------------- HUD ---------------- */
let hudT = 0;
function updateHUD() {
  hudT -= 1;
  // hp
  const hpp = clamp(player.hp / player.maxHp, 0, 1);
  $('hp-fill').style.width = (hpp * 100) + '%';
  $('hp-ghost').style.width = (hpp * 100) + '%';
  $('hp-label').textContent = `HULL ${Math.ceil(player.hp)}/${player.maxHp}`;
  const shp = player.maxShield > 0 ? clamp(player.shield / player.maxShield, 0, 1) : 0;
  $('shield-fill').style.width = (shp * 100) + '%';
  $('wave-num').textContent = G.wave;
  $('timer').textContent = fmtTime(G.time);
  $('score-num').textContent = G.score.toLocaleString();
  $('kills-num').textContent = G.kills.toLocaleString() + ' KILLS';
  $('level-badge').textContent = 'LV ' + player.level;
  $('xp-fill').style.width = clamp(player.xp / player.xpNext * 100, 0, 100) + '%';
  // dash
  const dp = 1 - clamp(player.dashCd / player.dashCdMax, 0, 1);
  $('dash-fill').style.setProperty('--p', dp);
  $('dash-fill').firstElementChild; // noop
  $('dash-wrap').classList.toggle('ready', player.dashCd <= 0);
  document.querySelector('#dash-fill').style.background =
    `linear-gradient(90deg, #35e0ff ${dp * 100}%, rgba(53,224,255,.1) ${dp * 100}%)`;
  // combo
  const c = $('combo');
  if (G.combo >= 8) { c.style.opacity = 1; c.innerHTML = `<b>x${G.combo}</b><span>COMBO</span>`; }
  else c.style.opacity = 0;
  // boss bar
  if (G.boss && !G.boss.dead) $('boss-fill').style.width = clamp(G.boss.hp / G.boss.maxHp * 100, 0, 100) + '%';
  // active power-up chips
  updateFxChips();
}
let fxSig = '';
function updateFxChips() {
  const p = player;
  let sig = '';
  for (const k of Object.keys(POWERUPS)) if (p.fx[k] > 0) sig += k + Math.ceil(p.fx[k]);
  if (sig !== fxSig) {
    fxSig = sig;
    const w = $('fx-hud'); w.innerHTML = '';
    for (const k of Object.keys(POWERUPS)) {
      if (p.fx[k] <= 0) continue;
      const P = POWERUPS[k];
      const el = document.createElement('div');
      el.className = 'fxchip'; el.dataset.k = k;
      el.style.borderColor = P.color;
      el.innerHTML = `<img alt=""><div class="fxmeta"><span style="color:${P.color}">${P.name}</span><div class="fxbar"><i></i></div></div>`;
      if (SPRITES[k]) el.querySelector('img').src = SPRITES[k].url;
      w.appendChild(el);
    }
  }
  for (const el of $('fx-hud').children) {
    const k = el.dataset.k, bar = el.querySelector('i');
    bar.style.width = clamp(p.fx[k] / POWERUPS[k].dur * 100, 0, 100) + '%';
    bar.style.background = POWERUPS[k].color;
  }
}
function buildPowerLegend() {
  const w = $('power-legend'); if (!w) return;
  w.innerHTML = '<div class="pow-title">— POWER-UP CORES (pouch them, press E to unleash) —</div>';
  for (const k of Object.keys(POWERUPS)) {
    const P = POWERUPS[k];
    const d = document.createElement('div'); d.className = 'pow';
    d.innerHTML = `<img alt=""><div><b style="color:${P.color}">${P.name}</b><p>${P.desc}</p></div>`;
    if (SPRITES[k]) d.querySelector('img').src = SPRITES[k].url;
    w.appendChild(d);
  }
}
function updateBombHUD() {
  const w = $('bomb-pips'); w.innerHTML = '';
  for (let i = 0; i < player.maxBombs; i++) {
    const el = document.createElement('i');
    if (i < player.bombs) el.className = 'on';
    w.appendChild(el);
  }
}
function updateWeaponsHUD() {
  const w = $('weapons-hud'); w.innerHTML = '';
  for (const id of Object.keys(player.weapons)) {
    const d = WEAPONS[id], lv = player.weapons[id];
    const el = document.createElement('div');
    el.className = 'whud';
    el.innerHTML = `<div class="ico" style="background:${d.color}22;border:1px solid ${d.color}">${d.ico}</div>
      <div><div style="font-size:11px;letter-spacing:2px;opacity:.7">${d.name}</div>
      <div class="pips">${Array.from({ length: 8 }, (_, i) => `<i class="${i < lv ? 'on' : ''}"></i>`).join('')}</div></div>`;
    w.appendChild(el);
  }
}

/* ---------------- render ---------------- */
function render() {
  ctx.clearRect(0, 0, W, H);
  // shake offset
  const sh = G.shake * G.shake * 22 * (settings.shake / 100);
  const ox = rand(-sh, sh), oy = rand(-sh, sh);
  const cx = cam.x - W / 2 + ox, cy = cam.y - H / 2 + oy;

  drawBackground(cx, cy);
  drawGrid(cx, cy);

  ctx.save();
  ctx.translate(W / 2, H / 2); ctx.scale(G.zoom, G.zoom); ctx.translate(-cam.x + ox, -cam.y + oy);

  // gems
  for (const g of gems) {
    const col = g.v >= 20 ? '#ffcf4d' : g.v >= 5 ? '#b26bff' : '#35e0ff';
    const s = g.v >= 20 ? 7 : g.v >= 5 ? 6 : 4.5;
    const pulse = 1 + Math.sin(G.time * 6 + g.x) * 0.15;
    ctx.save(); ctx.translate(g.x, g.y); ctx.rotate(Math.PI / 4); ctx.scale(pulse, pulse);
    ctx.fillStyle = col; ctx.globalAlpha = 0.9;
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.globalAlpha = 0.3; ctx.fillRect(-s, -s, s * 2, s * 2);
    ctx.restore();
  }
  // pickups
  for (const k of pickups) {
    const y = k.y + Math.sin(k.bob) * 4;
    ctx.font = '22px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(k.kind === 'heart' ? '❤️' : k.kind === 'bomb' ? '💣' : '🧲', k.x, y);
    if (k.life < 4) { ctx.globalAlpha = (Math.sin(k.life * 12) + 1) / 2; ctx.globalAlpha = 1; }
  }
  // power-ups (custom sprites + halo ring)
  for (const u of powerups) {
    const P = POWERUPS[u.kind], S = SPRITES[u.kind];
    const y = u.y + Math.sin(u.bob) * 5;
    const pulse = 1 + Math.sin(G.time * 5 + u.bob) * 0.08;
    const blink = u.life < 4 ? (Math.sin(u.life * 12) + 1) / 2 * 0.7 + 0.3 : 1;
    ctx.globalAlpha = blink * (0.45 + 0.3 * Math.sin(G.time * 5 + u.bob));
    ctx.strokeStyle = P.color; ctx.lineWidth = 2;
    const hr = 27 + Math.sin(G.time * 5 + u.bob) * 3;
    ctx.beginPath(); ctx.arc(u.x, y, hr, G.time * 1.5, G.time * 1.5 + TAU * 0.75); ctx.stroke();
    ctx.beginPath(); ctx.arc(u.x, y, hr, G.time * 1.5 + Math.PI, G.time * 1.5 + Math.PI + TAU * 0.75); ctx.stroke();
    ctx.globalAlpha = blink;
    const sz = 56 * pulse;
    if (S) ctx.drawImage(S.img, u.x - sz / 2, y - sz / 2, sz, sz);
    ctx.globalAlpha = 1;
  }
  // enemy bullets (under enemies)
  for (const b of eBullets) {
    ctx.fillStyle = b.color;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 3, 0, TAU); ctx.globalAlpha = 0.25; ctx.fill();
    ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.4, 0, TAU); ctx.fill();
  }
  // enemies
  for (const e of enemies) drawEnemy(e);
  // frost tint over frozen normals
  if (player && player.fx.frost > 0) {
    ctx.fillStyle = 'rgba(160,220,255,.28)';
    for (const e of enemies) {
      if (!e.dead && !e.boss) { ctx.beginPath(); ctx.arc(e.x, e.y, e.r + 3, 0, TAU); ctx.fill(); }
    }
  }
  // player bullets
  ctx.globalCompositeOperation = 'lighter';
  for (const b of pBullets) {
    ctx.fillStyle = b.color;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 2.5, 0, TAU); ctx.globalAlpha = 0.3; ctx.fill();
    ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.45, 0, TAU); ctx.fill();
  }
  // particles
  for (const q of parts) {
    ctx.globalAlpha = clamp(q.life / q.max, 0, 1);
    ctx.fillStyle = q.color;
    ctx.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size);
  }
  ctx.globalAlpha = 1;
  // tesla bolts
  ctx.strokeStyle = '#bff6ff'; ctx.lineWidth = 2.5;
  for (const b of bolts) {
    ctx.globalAlpha = clamp(b.life / b.max, 0, 1);
    ctx.beginPath();
    const mx = (b.x1 + b.x2) / 2 + rand(-14, 14), my = (b.y1 + b.y2) / 2 + rand(-14, 14);
    ctx.moveTo(b.x1, b.y1); ctx.lineTo(mx, my); ctx.lineTo(b.x2, b.y2); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  if (player && player.alive !== false) drawPlayer();

  // floaters (world space)
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const f of floaters) {
    ctx.globalAlpha = clamp(f.life / f.max + 0.3, 0, 1);
    ctx.font = f.big ? 'bold 19px Rajdhani,sans-serif' : '600 14px Rajdhani,sans-serif';
    ctx.strokeStyle = 'rgba(0,0,10,.8)'; ctx.lineWidth = 3;
    ctx.strokeText(f.txt, f.x, f.y);
    ctx.fillStyle = f.color; ctx.fillText(f.txt, f.x, f.y);
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // flash decay
  if (G.flashA > 0) { G.flashA = Math.max(0, G.flashA - 0.03); $('flash').style.opacity = G.flashA * 0.7; }
}

function drawBackground(cx, cy) {
  for (const s of stars) {
    let x = ((s.x * 2000 - cx * s.z) % (W + 40) + W + 40) % (W + 40) - 20;
    let y = ((s.y * 2000 - cy * s.z) % (H + 40) + H + 40) % (H + 40) - 20;
    const tw = 0.5 + 0.5 * Math.sin(G.time * 2 + s.tw);
    ctx.globalAlpha = 0.25 + s.z * 0.6 * tw;
    ctx.fillStyle = s.z > 0.7 ? '#bfe9ff' : '#5a6ea8';
    ctx.fillRect(x, y, s.s, s.s);
  }
  ctx.globalAlpha = 1;
}
function drawGrid(cx, cy) {
  const gap = 130;
  ctx.strokeStyle = 'rgba(53,224,255,.07)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = -((cx % gap) + gap) % gap; x < W; x += gap) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let y = -((cy % gap) + gap) % gap; y < H; y += gap) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();
}
function drawPlayer() {
  const p = player;
  const titanOn = p.fx.titan > 0;
  ctx.save(); ctx.translate(p.x, p.y);
  if (titanOn) ctx.scale(2.3, 2.3); // GIANT form
  // blink while invuln
  if (p.invuln > 0 && Math.floor(G.time * 20) % 2 === 0) ctx.globalAlpha = 0.45;
  const a = p.aim;
  // dash trail glow
  if (p.dashT > 0) {
    ctx.globalAlpha *= 0.9;
    ctx.fillStyle = 'rgba(53,224,255,.25)';
    ctx.beginPath(); ctx.arc(-p.dashDx * 26, -p.dashDy * 26, 22, 0, TAU); ctx.fill();
    ctx.globalAlpha = p.invuln > 0 && Math.floor(G.time * 20) % 2 === 0 ? 0.45 : 1;
  }
  // shield ring (aegis bubble takes over while active)
  if (p.fx.aegis > 0) {
    ctx.strokeStyle = 'rgba(77,166,255,.9)'; ctx.lineWidth = 3.5;
    ctx.beginPath(); ctx.arc(0, 0, 30 + Math.sin(G.time * 7) * 3, 0, TAU); ctx.stroke();
    ctx.strokeStyle = 'rgba(77,166,255,.3)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, 37 + Math.cos(G.time * 7) * 3, 0, TAU); ctx.stroke();
  } else if (p.shield > 0) {
    ctx.strokeStyle = 'rgba(53,224,255,.7)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, 24 + Math.sin(G.time * 5) * 2, 0, TAU); ctx.stroke();
  }
  // titan spike aura
  if (titanOn) {
    ctx.strokeStyle = 'rgba(124,255,107,.85)'; ctx.lineWidth = 3;
    ctx.save(); ctx.rotate(-G.time * 2);
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a0 = i * TAU / 10;
      ctx.moveTo(Math.cos(a0) * 26, Math.sin(a0) * 26);
      ctx.lineTo(Math.cos(a0 + TAU / 20) * 33, Math.sin(a0 + TAU / 20) * 33);
      ctx.lineTo(Math.cos(a0 + TAU / 10) * 26, Math.sin(a0 + TAU / 10) * 26);
    }
    ctx.stroke(); ctx.restore();
  }
  // engine flame
  const fl = 12 + Math.random() * 10 + Math.hypot(p.vx, p.vy) / 40;
  ctx.save(); ctx.rotate(a + Math.PI);
  const grd = ctx.createLinearGradient(14, 0, 14 + fl, 0);
  grd.addColorStop(0, 'rgba(53,224,255,.95)'); grd.addColorStop(1, 'rgba(53,224,255,0)');
  ctx.fillStyle = grd;
  ctx.beginPath(); ctx.moveTo(14, -6); ctx.lineTo(14 + fl, 0); ctx.lineTo(14, 6); ctx.closePath(); ctx.fill();
  ctx.restore();
  // hull
  ctx.rotate(a);
  ctx.fillStyle = '#0b1530';
  ctx.strokeStyle = '#35e0ff'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(18, 0); ctx.lineTo(-12, -12); ctx.lineTo(-6, 0); ctx.lineTo(-12, 12); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(4, 0, 3.4, 0, TAU); ctx.fill();
  ctx.restore();
  // orbitals
  const orbLv = p.weapons.orbitals || 0;
  if (orbLv > 0) {
    const n = orbLv >= 7 ? 5 : orbLv >= 4 ? 4 : 3;
    const R = 70 + orbLv * 6;
    for (let i = 0; i < n; i++) {
      const ang = G.time * (2.2 + orbLv * 0.12) + i * TAU / n;
      const bx = p.x + Math.cos(ang) * R, by = p.y + Math.sin(ang) * R;
      ctx.save(); ctx.translate(bx, by); ctx.rotate(ang * 3);
      ctx.fillStyle = 'rgba(124,255,107,.25)';
      ctx.beginPath(); ctx.arc(0, 0, 15, 0, TAU); ctx.fill();
      ctx.fillStyle = '#7cff6b';
      ctx.fillRect(-11, -2.5, 22, 5); ctx.fillRect(-2.5, -11, 5, 22);
      ctx.fillStyle = '#fff'; ctx.fillRect(-3, -3, 6, 6);
      ctx.restore();
    }
  }
}
function drawEnemy(e) {
  ctx.save(); ctx.translate(e.x, e.y);
  const flashW = e.hitT > 0;
  ctx.fillStyle = flashW ? '#ffffff' : e.color;
  ctx.strokeStyle = flashW ? '#ffffff' : e.color;
  ctx.lineWidth = 2;
  if (e.boss) {
    ctx.rotate(e.t * 0.6);
    const r = e.r;
    // outer spikes
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = i * TAU / 8;
      ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      ctx.lineTo(Math.cos(a + TAU / 16) * (r + 14), Math.sin(a + TAU / 16) * (r + 14));
      ctx.lineTo(Math.cos(a + TAU / 8) * r, Math.sin(a + TAU / 8) * r);
    }
    ctx.stroke();
    ctx.rotate(-e.t * 0.6);
    // core
    ctx.fillStyle = 'rgba(10,6,16,.9)';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.72, 0, TAU); ctx.fill();
    ctx.strokeStyle = e.color; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = flashW ? '#fff' : e.color;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.28 + Math.sin(e.t * 6) * 3, 0, TAU); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.12, 0, TAU); ctx.fill();
    // hp arc
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(0, 0, r + 18, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(e.hp / e.maxHp, 0, 1)); ctx.stroke();
  } else {
    const r = e.r;
    switch (e.type) {
      case 'chaser': // triangle
        ctx.rotate(Math.atan2(player.y - e.y, player.x - e.x));
        ctx.beginPath(); ctx.moveTo(r, 0); ctx.lineTo(-r * 0.8, -r * 0.8); ctx.lineTo(-r * 0.4, 0); ctx.lineTo(-r * 0.8, r * 0.8); ctx.closePath();
        ctx.globalAlpha = 0.9; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
        break;
      case 'weaver': // diamond
        ctx.rotate(e.t * 3);
        ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r * 0.8, 0); ctx.lineTo(0, r); ctx.lineTo(-r * 0.8, 0); ctx.closePath();
        ctx.globalAlpha = 0.9; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
        break;
      case 'dasher': { // arrow, stretches when dashing
        ctx.rotate(e.dashT > 0 ? Math.atan2(e.dy, e.dx) : Math.atan2(player.y - e.y, player.x - e.x));
        const s = e.dashT > 0 ? 1.5 : 1;
        ctx.scale(s, 1);
        ctx.beginPath(); ctx.moveTo(r, 0); ctx.lineTo(-r, -r * 0.7); ctx.lineTo(-r * 0.5, 0); ctx.lineTo(-r, r * 0.7); ctx.closePath();
        ctx.globalAlpha = 0.9; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
        if (e.dashCd < 0.4 && e.dashT <= 0) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 0, 3, 0, TAU); ctx.fill(); }
        break;
      }
      case 'splitter': // blob circle w/ nucleus
        ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU);
        ctx.globalAlpha = 0.85; ctx.fill(); ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(5,10,5,.85)';
        ctx.beginPath(); ctx.arc(0, 0, r * 0.55, 0, TAU); ctx.fill();
        ctx.fillStyle = flashW ? '#fff' : e.color;
        ctx.beginPath(); ctx.arc(Math.sin(e.t * 4) * 3, Math.cos(e.t * 4) * 3, r * 0.28, 0, TAU); ctx.fill();
        break;
      case 'mini':
        ctx.rotate(e.t * 5);
        ctx.fillRect(-r * 0.7, -r * 0.7, r * 1.4, r * 1.4);
        break;
      case 'stinger': { // pentagon gunner
        ctx.rotate(e.t * 1.2);
        ctx.beginPath();
        for (let i = 0; i < 5; i++) { const a = i * TAU / 5; const px = Math.cos(a) * r, py = Math.sin(a) * r; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
        ctx.closePath(); ctx.globalAlpha = 0.9; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
        ctx.rotate(-e.t * 1.2);
        ctx.fillStyle = '#0b0616'; ctx.beginPath(); ctx.arc(0, 0, r * 0.45, 0, TAU); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 0, 3, 0, TAU); ctx.fill();
        break;
      }
      case 'bulwark': { // hexagon tank
        ctx.rotate(e.t * 0.5);
        ctx.beginPath();
        for (let i = 0; i < 6; i++) { const a = i * TAU / 6; const px = Math.cos(a) * r, py = Math.sin(a) * r; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
        ctx.closePath(); ctx.lineWidth = 3.5; ctx.stroke();
        ctx.globalAlpha = 0.25; ctx.fill(); ctx.globalAlpha = 1;
        ctx.fillStyle = flashW ? '#fff' : e.color;
        ctx.beginPath(); ctx.arc(0, 0, 6, 0, TAU); ctx.fill();
        break;
      }
    }
    // hp pip for tough enemies
    if (e.maxHp > 60 && e.hp < e.maxHp) {
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(-20, -e.r - 12, 40, 4);
      ctx.fillStyle = '#ff5d7a'; ctx.fillRect(-20, -e.r - 12, 40 * clamp(e.hp / e.maxHp, 0, 1), 4);
    }
  }
  ctx.restore();
}

/* ---------------- main loop ---------------- */
let last = performance.now(), fpsAcc = 0, fpsN = 0, fpsT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.05) dt = 0.05;
  // fps
  fpsAcc += 1 / Math.max(dt, 1e-4); fpsN++; fpsT += dt;
  if (fpsT > 0.5) { /*$('fps').textContent = Math.round(fpsAcc / fpsN);*/ fpsAcc = 0; fpsN = 0; fpsT = 0; }

  if (G.state === 'playing') {
    if (G.hitstop > 0) { G.hitstop -= dt; }
    else update(dt);
  } else if (G.state === 'levelup' || G.state === 'paused' || G.state === 'over' || G.state === 'victory') {
    updateFx(dt); // let particles settle behind panels
    G.time += dt * 0.05;
  }
  if (G.state !== 'menu' || true) render();
}

/* ---------------- wiring ---------------- */
function toggleMute() {
  settings.mute = !settings.mute;
  $('set-mute').checked = settings.mute;
  saveSettings(); AudioSys.setVolumes();
}
function enterConfirm() {
  if (!$('menu').classList.contains('hidden')) startFromMenu(false, false);
  else if (!$('gameover').classList.contains('hidden')) { AudioSys.ui(); resetRun(G.endless, G.weeee); updateBombHUD(); }
  else if (!$('victory').classList.contains('hidden')) { AudioSys.ui(); G.endless = true; G.state = 'playing'; showScreen(null); $('hud').classList.remove('hidden'); AudioSys.startMusic(); }
}
function startFromMenu(endless, weeee) {
  AudioSys.ensure(); AudioSys.ui();
  G.diffM = DIFFS[settings.diff] || DIFFS[1];
  resetRun(endless, weeee);
  updateBombHUD();
}
function bindUI() {
  $('btn-start').onclick = () => startFromMenu(false, false);
  $('btn-endless').onclick = () => startFromMenu(true, false);
  $('btn-weeee').onclick = () => startFromMenu(false, true);
  $('btn-how').onclick = () => { AudioSys.ensure(); AudioSys.ui(); showScreen('howto'); };
  $('btn-how-back').onclick = () => { AudioSys.ui(); showScreen('menu'); };
  $('btn-settings').onclick = () => { AudioSys.ensure(); AudioSys.ui(); syncSettingsUI(); showScreen('settings'); };
  $('btn-settings-back').onclick = () => { AudioSys.ui(); readSettingsUI(); showScreen(G.state === 'playing' || G.state === 'paused' ? null : 'menu'); if (G.state === 'paused') showScreen('pause'); };
  $('btn-resume').onclick = resumeGame;
  $('btn-restart').onclick = () => { AudioSys.ui(); resetRun(G.endless, G.weeee); updateBombHUD(); };
  $('btn-quit').onclick = () => { AudioSys.ui(); AudioSys.stopMusic(); G.state = 'menu'; $('hud').classList.add('hidden'); showScreen('menu'); refreshMenuStats(); };
  $('btn-retry').onclick = () => { AudioSys.ui(); resetRun(G.endless, G.weeee); updateBombHUD(); };
  $('btn-go-menu').onclick = () => { AudioSys.ui(); G.state = 'menu'; showScreen('menu'); refreshMenuStats(); };
  $('btn-continue').onclick = () => { AudioSys.ui(); G.endless = true; G.state = 'playing'; showScreen(null); $('hud').classList.remove('hidden'); AudioSys.startMusic(); announce('ENDLESS MODE', '#ffcf4d'); };
  $('btn-vic-menu').onclick = () => { AudioSys.ui(); G.state = 'menu'; showScreen('menu'); refreshMenuStats(); };
  $('btn-reroll').onclick = () => {
    if (G.rerolls <= 0) return;
    G.rerolls--; AudioSys.ui(); buildCards();
  };
  document.querySelectorAll('.diff').forEach(b => {
    b.onclick = () => {
      settings.diff = +b.dataset.d; saveSettings(); AudioSys.ensure(); AudioSys.ui();
      document.querySelectorAll('.diff').forEach(x => x.classList.toggle('active', x === b));
    };
  });
  window.addEventListener('keydown', e => {
    if (G.state === 'levelup' && ['Digit1', 'Digit2', 'Digit3'].includes(e.code)) {
      pickUpgrade(+e.code.slice(-1) - 1);
    } else if (G.state === 'playing' && ['Digit1', 'Digit2', 'Digit3'].includes(e.code)) {
      activateItem(+e.code.slice(-1) - 1);
    }
  });
}
function syncSettingsUI() {
  $('set-vol').value = settings.vol; $('set-mus').value = settings.mus;
  $('set-shake').value = settings.shake; $('set-particles').value = String(settings.particles);
  $('set-autofire').checked = settings.autofire; $('set-dmg').checked = settings.dmg;
  $('set-mute').checked = settings.mute;
  document.querySelectorAll('.diff').forEach(x => x.classList.toggle('active', +x.dataset.d === settings.diff));
}
function readSettingsUI() {
  settings.vol = +$('set-vol').value; settings.mus = +$('set-mus').value;
  settings.shake = +$('set-shake').value; settings.particles = +$('set-particles').value;
  settings.autofire = $('set-autofire').checked; settings.dmg = $('set-dmg').checked;
  settings.mute = $('set-mute').checked;
  saveSettings(); AudioSys.setVolumes();
}
['set-vol', 'set-mus'].forEach(id => $(id).addEventListener('input', readSettingsUI));
['set-shake', 'set-particles', 'set-autofire', 'set-dmg', 'set-mute'].forEach(id => $(id).addEventListener('change', readSettingsUI));

/* ---------------- boot ---------------- */
syncSettingsUI(); refreshMenuStats(); bindUI();
buildPowerSprites(); buildPowerLegend();
player = newPlayer(); // for menu backdrop
// ambient menu drift: a few wanderers for vibe
for (let i = 0; i  < 12; i++) { const p = { x: rand(-600, 600), y: rand(-400, 400) }; }
showScreen('menu');
requestAnimationFrame(frame);
// idle menu background sim
setInterval(() => {
  if (G.state === 'menu' || G.state === 'howto' || G.state === 'settings') {
    cam.x += 0.4; cam.y += 0.15;
    G.time += 0.016;
    if (Math.random() < 0.3 && parts.length < 300) {
      parts.push({ x: cam.x + rand(-W / 2, W / 2), y: cam.y + rand(-H / 2, H / 2), vx: rand(-20, 20), vy: rand(-20, 20), life: rand(1, 2.5), max: 2.5, size: rand(1, 3), color: ['#35e0ff', '#ff2d78', '#b26bff'][randi(0, 2)], drag: 1 });
    }
    updateFx(0.016);
  }
}, 16);

})();
