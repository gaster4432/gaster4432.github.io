const WORKER_URL = 'https://cf-chat.archlinuxkid99.workers.dev';

/* ─── Context budget ───
 * Mirrors the worker so we never ship a payload that cannot possibly fit.
 * The worker is authoritative: /api/models returns these numbers and
 * fetchBudget() overwrites the fallback below. Until that lands we use the
 * same values, so a send on a cold cache is still correctly bounded.
 */
const BUDGET_FALLBACK = {
  contextWindow: 131072,
  maxOutputTokens: 8192,
  templateOverhead: 1024,
  systemReserve: 8192,
  perMessageOverhead: 4,
  charsPerToken: 3.5,
  cjkTokensPerChar: 2,
  maxSystemChars: 16000,
  maxMessageChars: 32000,
};
let budget = { ...BUDGET_FALLBACK };

// Declared here (not with the account block below) because
// historyBudgetFor reads it and must never hit the temporal dead zone.
let personaReserveTokens = 0;

// Ranges where one character can cost ~1-2 tokens. The astral branch needs
// the /u flag and matches a full codepoint while String.length counts it as
// 2 units, which inflates the remainder — the safe direction.
const DENSE_RE =
  /[\u1100-\u11FF\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{20000}-\u{3FFFF}]/gu;

function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const dense = text.match(DENSE_RE);
  const d = dense ? dense.length : 0;
  return Math.ceil((text.length - d) / budget.charsPerToken) + d * budget.cjkTokensPerChar;
}

function messageTokens(content) {
  return estimateTokens(content) + budget.perMessageOverhead;
}

/**
 * Tokens left for history AND the incoming message, once system prompt,
 * persona and output reserve are paid for. The message must be budgeted
 * alongside history — reserving only for history lets a max-length message
 * push the request over the model's window.
 */
function conversationRoomFor(systemPrompt, greeting) {
  let used = messageTokens(systemPrompt) + personaReserveTokens;
  if (greeting) used += messageTokens(greeting);
  return Math.max(0, budget.contextWindow - budget.maxOutputTokens - budget.templateOverhead
    - Math.min(budget.systemReserve, used));
}

async function fetchBudget() {
  try {
    const res = await fetch(`${WORKER_URL}/api/models`);
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.budget && typeof data.budget === 'object') {
      budget = { ...BUDGET_FALLBACK, ...data.budget };
    }
  } catch (e) {}
}

/* ─── Accounts & profile ─── */

/* The session id is 64 raw hex characters, not JSON. It used to be written
 * as a bare string but read back through loadJSON(), which JSON.parse()s
 * whatever it finds — that always threw, so every session was silently
 * discarded on reload and the app always came back signed out. Read and
 * write it as the plain string it actually is.
 */
const SESSION_ID_RE = /^[0-9a-f]{64}$/;

function readSessionId() {
  try {
    const raw = localStorage.getItem('pkax_session');
    const v = typeof raw === 'string' ? raw.trim() : '';
    return SESSION_ID_RE.test(v) ? v : '';
  } catch {
    return '';
  }
}

function writeSessionId(id) {
  try {
    if (id) localStorage.setItem('pkax_session', id);
    else localStorage.removeItem('pkax_session');
  } catch (e) {
    console.error('[pkax] could not store the session id:', e);
  }
}

let sessionId = readSessionId();
let me = null;

// Opt-in "Remember me": the saved session normally keeps you signed in via
// sliding refresh, so this is only used as a fallback when a session has
// lapsed or been superseded. Opt-in because it stores the real password.
const REMEMBER_KEY = 'pkax_remember';
function savedCredentials() {
  try {
    const raw = localStorage.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && typeof v.username === 'string' && typeof v.password === 'string'
      ? v : null;
  } catch {
    return null;
  }
}
function saveCredentials(username, password) {
  try { localStorage.setItem(REMEMBER_KEY, JSON.stringify({ username, password })); } catch {}
}
function clearCredentials() {
  try { localStorage.removeItem(REMEMBER_KEY); } catch {}
}

// Staged avatar while the guest form is open, before any account exists.
let pendingAvatar = '';

/** How long a plain API call may take before the UI gives up on it. */
const API_TIMEOUT_MS = 30000;

/**
 * Reject if a promise takes too long.
 *
 * Uses Promise.race rather than AbortController, which some of the older
 * browsers this runs on do not have. The request itself is not cancelled,
 * but the UI stops waiting on it.
 */
function withTimeout(promise, ms) {
  var timer = setTimeout(function () {}, 0);
  var timeout = new Promise(function (_, reject) {
    timer = setTimeout(function () {
      reject(new Error('Request timed out'));
    }, ms);
  });
  return Promise.race([promise, timeout]).then(
    function (v) { clearTimeout(timer); return v; },
    function (e) { clearTimeout(timer); throw e; }
  );
}

/** Single fetch wrapper so the session header is never forgotten. */
async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (sessionId) headers.Authorization = 'Bearer ' + sessionId;
  let res;
  try {
    res = await withTimeout(
      fetch(WORKER_URL + path, Object.assign({}, opts, { headers })),
      API_TIMEOUT_MS
    );
  } catch (e) {
    return {
      ok: false,
      status: 0,
      data: { error: e && e.message === 'Request timed out' ? 'timeout' : 'network' },
    };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

const AUTH_ERRORS = {
  network: 'Could not reach the server.',
  timeout: 'The server took too long to answer.',
  credentials_required: 'Enter a username and password.',
  bad_password: 'That password does not match.',
  username_taken: 'That username is already taken.',
  sec_expired: 'The 60 second window expired — try again.',
  sec_mismatch: 'That registration did not match.',
  invalid_username: 'Usernames are 3–32 characters: letters, numbers, - or _.',
  invalid_verifier: 'That password could not be read.',
  invalid_avatar: 'That image could not be used. Try a URL or a PNG/JPEG under a couple of hundred KB.',
  rate_limited: 'Too many attempts — wait a moment.',
  auth_required: 'You need to sign in first.',
  'Database migration pending': 'The worker needs a database migration first.',
};

function authMessage(data, fallback) {
  const key = data && data.error;
  if (key && AUTH_ERRORS[key]) return AUTH_ERRORS[key];
  return fallback || (key || 'Something went wrong.');
}

/* --- avatar helpers --- */

// Only schemes that are safe in an <img src>. Mirrors sanitizeAvatar()
// on the worker so the UI can reject bad input before a round trip.
function isUsableAvatar(value) {
  const raw = String(value || '').trim();
  if (!raw) return true;
  if (/^https?:\/\//i.test(raw)) return true;
  return /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(raw) && raw.length <= 200000;
}

/**
 * Deterministic gradient + initial, used when no picture is set. Keeps the
 * profile row looking intentional instead of showing a broken image.
 */
function generatedAvatar(name) {
  const label = String(name || 'Guest').trim();
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  // Kept inside a blue band so a generated avatar never clashes with the
  // theme. Different names still land on different blues.
  const hue = 205 + (h % 36);
  const initial = label.charAt(0).toUpperCase() || 'G';
  const safeInitial = /[A-Z0-9]/.test(initial) ? initial : 'G';
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    `<stop offset="0" stop-color="hsl(${hue} 62% 52%)"/>` +
    `<stop offset="1" stop-color="hsl(${(hue + 18) % 360} 58% 40%)"/>` +
    '</linearGradient></defs>' +
    '<rect width="64" height="64" fill="url(#g)"/>' +
    `<text x="32" y="43" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" ` +
    `font-size="30" font-weight="700" fill="rgba(255,255,255,.94)" text-anchor="middle">${safeInitial}</text>` +
    '</svg>';
  return 'data:image/svg+xml;base64,' + btoa(svg);
}

function avatarFor(name, avatar) {
  // Guard against null/undefined: String(null) is "null", which would
  // otherwise end up as a literal url("null") request.
  const usable = avatar && isUsableAvatar(avatar) ? String(avatar).trim() : '';
  return usable || generatedAvatar(name || 'Guest');
}

function paintAvatar(el, name, avatar) {
  if (!el) return;
  el.style.backgroundImage = `url("${avatarFor(name, avatar)}")`;
  el.style.backgroundColor = '#232838';
}

/**
 * Shrink an uploaded image to a square thumbnail in the browser so the
 * stored data URI stays small. Rejects anything that is not a decodable image.
 */
function fileToAvatar(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('No file'));
    if (!/^image\/(png|jpeg|jpg|webp|gif)$/i.test(file.type)) {
      return reject(new Error('That file type is not supported.'));
    }
    if (file.size > 8 * 1024 * 1024) {
      return reject(new Error('Image is larger than 8 MB.'));
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not a readable image.'));
      img.onload = () => {
        const SIZE = 256;
        const canvas = document.createElement('canvas');
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext('2d');

        // Centre-crop to a square before scaling so faces are not squashed.
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);

        let out;
        try {
          out = canvas.toDataURL('image/webp', 0.85);
        } catch (e) {
          out = canvas.toDataURL('image/jpeg', 0.85);
        }
        // Fall back to JPEG if webp encoded larger than the cap.
        if (out.length > 200000) out = canvas.toDataURL('image/jpeg', 0.7);
        resolve(out);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* --- overlays --- */

function openOverlay(id) {
  const el = $(id);
  if (el) el.classList.remove('hidden');
}

function closeOverlay(id) {
  const el = $(id);
  if (el) el.classList.add('hidden');
}

function closeAllOverlays() {
  ['authModal', 'personaModal', 'charModal'].forEach(closeOverlay);
}

/* --- profile card --- */

function renderAuth() {
  const name = me ? me.username : 'Guest';
  $('profileName').textContent = name;

  paintAvatar($('profileAvatar'), name, me ? me.avatar : '');

  if (me) {
    const bits = [];
    if (personaReserveTokens > 0) bits.push('persona set');
    bits.push('personas & characters');
    $('profileSub').textContent = bits.join(' · ');
    $('profileCard').setAttribute('aria-label', `Signed in as ${me.username}`);
  } else {
    $('profileSub').textContent = 'Sign in to sync';
    $('profileCard').setAttribute('aria-label', 'Guest — sign in');
  }
}

function setAuthStatus(text) {
  const el = $('authStatus');
  if (el) el.textContent = text || '';
}

function setProfileStatus(text) {
  const el = $('profileStatus');
  if (el) el.textContent = text || '';
}

/* --- session lifecycle --- */

function adoptSession(d) {
  sessionId = d.sessionId;
  me = { id: d.userId, username: d.username, avatar: d.avatar || '' };
  writeSessionId(sessionId);
  closeOverlay('authModal');
  renderAuth();
}

async function signOut() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) {}
  sessionId = '';
  me = null;
  personaReserveTokens = 0;
  writeSessionId('');
  clearCredentials();
  closeOverlay('authModal');
  renderAuth();
}

/**
 * Extend the server-side session while it is still valid. Keeps the same
 * session id, so other open tabs keep working.
 */
async function refreshSession() {
  if (!sessionId || !me) return false;
  const r = await api('/api/auth/refresh', { method: 'POST' });
  return !!r.ok;
}

/**
 * Called on boot. Order of preference:
 *   1. an existing session id that the worker still accepts (the normal case)
 *   2. if that is gone and the user opted into "Remember me", sign in again
 *      with the stored password and adopt the fresh session id.
 */
async function restoreSession() {
  if (sessionId) {
    const r = await api('/api/auth/session');
    if (r.ok && r.data.authenticated) {
      me = { id: r.data.userId, username: r.data.username, avatar: r.data.avatar || '' };
      personaReserveTokens = Math.ceil((r.data.personaChars || 0) / budget.charsPerToken);
      renderAuth();
      refreshSession();
      return;
    }
    // The worker no longer accepts this id (expired, superseded or revoked).
    sessionId = '';
    writeSessionId('');
  }

  // No usable session — fall back to the stored password if the user opted in.
  const creds = savedCredentials();
  if (creds && creds.password) {
    const verifier = await Passwords.derive(creds.username, creds.password);
    const r = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: creds.username, verifier }),
    });
    if (r.ok && r.data.sessionId) {
      sessionId = r.data.sessionId;
      me = { id: r.data.userId, username: r.data.username, avatar: r.data.avatar || '' };
      writeSessionId(sessionId);
      // The login response does not carry the persona length, and the client
      // budget needs it to reserve room for the persona. Ask for the session
      // so the reserve is right on this load too.
      const s = await api('/api/auth/session');
      if (s.ok && s.data.authenticated) {
        personaReserveTokens = Math.ceil((s.data.personaChars || 0) / budget.charsPerToken);
      }
      renderAuth();
      return;
    }
    // Stored password no longer works — stop retrying on every page load.
    clearCredentials();
  }

  renderAuth();
}

/* --- guest view --- */

function openAccountModal() {
  setAuthStatus('');
  setProfileStatus('');

  const guest = !me;
  $('authGuestView').classList.toggle('hidden', !guest);
  $('authMeView').classList.toggle('hidden', guest);

  if (guest) {
    // An uploaded image lands in pendingAvatar and clears the URL box, so
    // only overwrite it when the URL box actually has something in it —
    // otherwise reopening the modal threw the upload away.
    const typedUrl = $('avatarUrl').value.trim();
    if (typedUrl) pendingAvatar = typedUrl;
    paintAvatar($('avatarPreview'), $('authUsername').value.trim() || 'Guest', pendingAvatar);
    // Default to remembering only if credentials are already stored, so the
    // box never silently starts collecting a new password.
    $('authRemember').checked = !!savedCredentials();
    syncRememberWarning();
    $('authUsername').focus();
  } else {
    $('meName').textContent = me.username;
    paintAvatar($('meAvatar'), me.username, me.avatar);
    paintAvatar($('meAvatarPreview'), me.username, me.avatar);
    $('avatarUrlEdit').value = me.avatar && /^https?:/i.test(me.avatar) ? me.avatar : '';
    $('profileUsername').value = me.username;
    $('personaSummary').textContent = personaReserveTokens > 0
      ? `Set (${Math.round(personaReserveTokens * budget.charsPerToken)} characters of context)`
      : 'Not set — characters get no extra context';
  }

  openOverlay('authModal');
}

function resetAuthConfirm() {
  $('authConfirm').classList.add('hidden');
  $('authSubmit').classList.remove('hidden');
  $('authPassword').value = '';
  setAuthStatus('');
}

function syncRememberWarning() {
  const warn = $('authRememberWarn');
  const box = $('authRemember');
  if (warn && box) warn.hidden = !box.checked;
}

async function doSignIn() {
  const username = $('authUsername').value.trim();
  const password = $('authPassword').value;
  if (!username || !password) return setAuthStatus('Enter a username and password.');

  setAuthStatus('Checking…');
  const verifier = await Passwords.derive(username, password);
  const r = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, verifier }),
  });

  // The worker says there is no such user — offer to create the account.
  if (r.data && r.data.error === 'no_such_user') {
    $('authMissingName').textContent = username;
    $('authConfirm').classList.remove('hidden');
    $('authSubmit').classList.add('hidden');
    return setAuthStatus('No account with that username.');
  }
  if (!r.ok) return setAuthStatus(authMessage(r.data, 'Sign in failed.'));

  if ($('authRemember').checked) saveCredentials(username, password);
  else clearCredentials();

  adoptSession(r.data);
  await restoreSession();
}

async function doRegister() {
  const username = $('authUsername').value.trim();
  const password = $('authPassword').value;
  if (!username) return setAuthStatus('Pick a username first.');
  if (password.length < 8) return setAuthStatus('Use at least 8 characters.');

  const avatar = $('avatarUrl').value.trim() || pendingAvatar;
  setAuthStatus('Creating account…');
  const verifier = await Passwords.derive(username, password);

  // Step 1 — the worker answers "OK, give me a SEC" with a 64-char token
  // that is only valid for 60 seconds.
  const intent = await api('/api/auth/register-intent', {
    method: 'POST',
    body: JSON.stringify({ username }),
  });
  if (!intent.ok) return setAuthStatus(authMessage(intent.data, 'Could not start registration.'));

  // Step 2 — hand that token straight back with the credentials.
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, verifier, sec: intent.data.sec, avatar }),
  });
  if (!r.ok) return setAuthStatus(authMessage(r.data, 'Registration failed.'));

  if ($('authRemember').checked) saveCredentials(username, password);

  adoptSession(r.data);
  await restoreSession();
}

/* --- profile editing --- */

async function saveProfile() {
  const username = $('profileUsername').value.trim();
  const url = $('avatarUrlEdit').value.trim();
  const source = url || $('meAvatarPreview').dataset.uploaded || me.avatar || '';

  if (!isUsableAvatar(source)) return setProfileStatus('That image could not be used.');

  setProfileStatus('Saving…');
  const r = await api('/api/auth/profile', {
    // POST, not PUT: the worker's CORS preflight only allows
    // "GET, POST, OPTIONS", so a cross-origin PUT never leaves the browser.
    method: 'POST',
    body: JSON.stringify({ username, avatar: source }),
  });
  if (!r.ok) return setProfileStatus(authMessage(r.data, 'Could not save.'));

  me = { id: me.id, username: r.data.username, avatar: r.data.avatar || '' };
  paintAvatar($('meAvatar'), me.username, me.avatar);
  paintAvatar($('meAvatarPreview'), me.username, me.avatar);
  renderAuth();
  setProfileStatus('Saved.');
  await restoreSession();
}

async function handleAvatarFile(inputId, previewId, urlId, target) {
  const input = $(inputId);
  if (!input || !input.files || !input.files[0]) return;

  const statusId = target === 'profile' ? 'profileStatus' : 'authStatus';
  const status = $(statusId);
  if (status) status.textContent = 'Preparing image…';

  try {
    const dataUrl = await fileToAvatar(input.files[0]);
    if (target === 'profile') {
      const preview = $(previewId);
      if (preview) preview.dataset.uploaded = dataUrl;
      if ($(urlId)) $(urlId).value = '';
      paintAvatar($(previewId), me.username, dataUrl);
    } else {
      pendingAvatar = dataUrl;
      if ($(urlId)) $(urlId).value = '';
      paintAvatar($(previewId), $('authUsername').value.trim() || 'Guest', dataUrl);
    }
    if (status) status.textContent = '';
  } catch (e) {
    if (status) status.textContent = e.message || 'Could not use that image.';
  } finally {
    input.value = '';
  }
}

/* --- persona --- */

async function openPersona() {
  if (!me) return;
  $('personaStatus').textContent = '';
  openOverlay('personaModal');

  const r = await api('/api/persona');
  $('personaText').value = r.ok ? r.data.persona || '' : '';
  updatePersonaCount();
  $('personaText').focus();
}

function updatePersonaCount() {
  const el = $('personaCount');
  if (el) el.textContent = String($('personaText').value.length);
}

async function savePersona(clear) {
  const value = clear ? '' : $('personaText').value;
  const status = $('personaStatus');
  status.textContent = 'Saving…';

  const r = await api('/api/persona', {
    // POST, not PUT: see saveProfile() — PUT is not in the worker's CORS
    // Allow-Methods list, so the browser would block the preflight.
    method: 'POST',
    body: JSON.stringify({ persona: value }),
  });
  if (!r.ok) {
    status.textContent = authMessage(r.data, 'Could not save.');
    return;
  }

  personaReserveTokens = Math.ceil((r.data.persona || '').length / budget.charsPerToken);
  $('personaSummary').textContent = personaReserveTokens > 0
    ? `Set (${r.data.persona.length} characters of context)`
    : 'Not set — characters get no extra context';
  renderAuth();
  closeOverlay('personaModal');
}

/* --- character creation --- */

function updateCharPromptCount() {
  const el = $('charPromptCount');
  if (el) el.textContent = String($('charPrompt').value.length);
}

async function submitCharacter() {
  const status = $('charStatus');
  status.textContent = 'Creating…';

  try {
    const r = await api('/api/characters', {
      method: 'POST',
      body: JSON.stringify({
        name: $('charNameInput').value.trim(),
        greeting: $('charGreetingInput').value.trim(),
        systemPrompt: $('charPrompt').value.trim(),
        avatar: $('charAvatar').value.trim(),
      }),
    });

    if (!r.ok) {
      status.textContent = authMessage(r.data, 'Could not create the character.');
      return;
    }

    const c = r.data.character;
    characters[c.id] = {
      name: c.name,
      greeting: c.greeting || '',
      systemPrompt: c.systemPrompt || '',
      avatar: c.avatar || '',
      remote: true,
    };
    renderCharGrid();
    renderSidebar();

    closeOverlay('charModal');
    ['charNameInput', 'charGreetingInput', 'charPrompt', 'charAvatar'].forEach((id) => { $(id).value = ''; });
    updateCharPromptCount();

    // Drop the visitor straight into the character they just made.
    selectCharacter(c.id);
  } catch (e) {
    // Never leave the button stuck on "Creating…" — say what went wrong.
    console.error('Create character failed:', e);
    status.textContent = 'Could not create the character.';
  }
}

function bindAuthUI() {
  $('profileCard').onclick = openAccountModal;
  $('closeAuthBtn').onclick = () => closeOverlay('authModal');

  $('authSubmit').onclick = doSignIn;
  $('authYes').onclick = doRegister;
  $('authNo').onclick = resetAuthConfirm;
  if ($('authRemember')) $('authRemember').onchange = syncRememberWarning;
  // Native form submit covers Enter in either field, and gives password
  // managers a real form to attach to.
  $('authForm').addEventListener('submit', (e) => {
    e.preventDefault();
    $('authConfirm').classList.contains('hidden') ? doSignIn() : doRegister();
  });
  $('authUsername').addEventListener('input', () => {
    // Preview the generated avatar live while typing a new username.
    if (!$('avatarUrl').value.trim() && !pendingAvatar) {
      paintAvatar($('avatarPreview'), $('authUsername').value.trim() || 'Guest', '');
    }
  });
  $('avatarUrl').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    if (v && !isUsableAvatar(v)) return setAuthStatus('That image URL could not be used.');
    pendingAvatar = v;
    paintAvatar($('avatarPreview'), $('authUsername').value.trim() || 'Guest', v);
  });
  $('avatarFile').onchange = () => handleAvatarFile('avatarFile', 'avatarPreview', 'avatarUrl', 'guest');
  $('avatarReset').onclick = () => {
    pendingAvatar = '';
    $('avatarUrl').value = '';
    paintAvatar($('avatarPreview'), $('authUsername').value.trim() || 'Guest', '');
  };

  $('logoutBtn').onclick = signOut;
  $('profileSaveBtn').onclick = saveProfile;
  $('profileUsername').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveProfile(); });
  $('avatarUrlEdit').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    const preview = $('meAvatarPreview');
    if (v && !isUsableAvatar(v)) return setProfileStatus('That image URL could not be used.');
    if (preview) {
      preview.dataset.uploaded = '';
      paintAvatar(preview, me.username, v);
    }
    paintAvatar($('meAvatar'), me.username, v);
  });
  $('avatarFileEdit').onchange = () => handleAvatarFile('avatarFileEdit', 'meAvatarPreview', 'avatarUrlEdit', 'profile');
  $('avatarResetEdit').onclick = () => {
    const preview = $('meAvatarPreview');
    $('avatarUrlEdit').value = '';
    if (preview) {
      preview.dataset.uploaded = '';
      paintAvatar(preview, me.username, '');
    }
    paintAvatar($('meAvatar'), me.username, '');
  };

  $('openPersonaBtn').onclick = () => { closeOverlay('authModal'); openPersona(); };
  $('openCharBtn').onclick = () => { closeOverlay('authModal'); openCharModal(); };
  $('closePersonaBtn').onclick = () => closeOverlay('personaModal');
  $('personaSave').onclick = () => savePersona(false);
  $('personaClear').onclick = () => savePersona(true);
  $('personaText').addEventListener('input', updatePersonaCount);

  $('closeCharBtn').onclick = () => closeOverlay('charModal');
  $('charSubmit').onclick = submitCharacter;
  $('charPrompt').addEventListener('input', updateCharPromptCount);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllOverlays();
  });
}

function openCharModal() {
  if (!me) return openAccountModal();
  $('charStatus').textContent = '';
  updateCharPromptCount();
  openOverlay('charModal');
  $('charNameInput').focus();
}
let characters = {};
let currentChar = null;
let currentChatId = null;
let history = [];
let sending = false;
let msgCounter = 0;

const $ = id => document.getElementById(id);

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Avatars can come from user-created remote characters — only allow safe
// schemes, and always HTML-escape before injecting into an attribute.
function safeAvatar(src) {
  if (typeof src !== 'string') return '';
  const s = src.trim();
  if (!s) return '';
  if (/^data:image\//i.test(s)) return s.length <= 2000000 ? s : '';
  if (/^https?:\/\//i.test(s)) return s.slice(0, 2000);
  if (s.startsWith('../') || s.startsWith('/')) return s;
  return '';
}

function avatarImgHtml(src, alt, extraAttrs) {
  const safe = safeAvatar(src);
  if (!safe) return '';
  return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(alt || '')}"${extraAttrs ? ' ' + extraAttrs : ''}>`;
}

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const val = JSON.parse(raw);
    return val ?? fallback;
  } catch {
    return fallback;
  }
}

const ICON_EDIT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const ICON_REGEN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
const ICON_PREV = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>';
const ICON_NEXT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>';
const ICON_DELETE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

const messagesEl = $('messages');
const chatInput = $('chatInput');
const sendBtn = $('sendBtn');
const resetBtn = $('resetBtn');
const charName = $('charName');
const charGreeting = $('charGreeting');
const chatCharAvatar = $('chatCharAvatar');
const inputArea = $('inputArea');
const charPicker = $('charPicker');
const charSidebarList = $('charSidebarList');
const characterGrid = $('characterGrid');
const characterSearch = $('characterSearch');


function setChatAvatar(char) {
  if (!char) { chatCharAvatar.innerHTML = ''; return; }
  chatCharAvatar.innerHTML = avatarImgHtml(char.avatar, char.name);
}

function uid() { return 'm' + (++msgCounter) + '_' + Date.now(); }

/* ─── Toast ─── */

let toastHost = null;

function toast(message, ms = 4500) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.id = 'toastHost';
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

/* ─── Chat store ─── */

// Every chat lives in localStorage. The worker keeps no copy, so this is
// the only place a conversation survives a reload.

function loadData() {
  let stored = loadJSON('pkax_chats', null);
  if (stored === null) stored = loadJSON('cf_chat_chats', []);
  return Array.isArray(stored) ? stored : [];
}

function saveData(chats) {
  // Storage may be full. The conversation itself matters far more than the
  // archive of old regenerations, so shed the oldest versions and try
  // again rather than losing the whole chat.
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      localStorage.setItem('pkax_chats', JSON.stringify(chats));
      return true;
    } catch (e) {
      if (!shedVersions(chats)) {
        console.error('[pkax] could not save chats:', e);
        toast('Could not save this chat — browser storage is full or blocked.');
        return false;
      }
    }
  }
  console.error('[pkax] could not save chats: storage is full');
  toast('Could not save this chat — browser storage is full.');
  return false;
}

/**
 * Drop the oldest regeneration versions from every message, halving each
 * list. Only ever touches the copy being written — the live conversation
 * keeps every version it has, so nothing disappears from the screen.
 *
 * Returns true if anything was dropped.
 */
function shedVersions(chats) {
  let dropped = 0;
  for (const chat of chats) {
    for (const m of chat.messages || []) {
      if (!Array.isArray(m._versions) || m._versions.length < 2) continue;
      const cut = Math.floor((m._versions.length - 1) / 2);
      if (cut > 0) {
        m._versions.splice(0, cut);
        m._currentVersion = Math.max(0, Math.min(m._currentVersion, m._versions.length - 1));
        dropped += cut;
      }
    }
  }
  return dropped > 0;
}

// Which character and chat were open. Without this the chats were still on
// disk but the app always came back to an empty panel, which looked exactly
// like nothing had been saved.
const ACTIVE_KEY = 'pkax_active';

function loadActive() {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function saveActive() {
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({
      c: currentChar || '',
      i: currentChatId || '',
    }));
  } catch (e) {
    console.error('[pkax] could not record the open chat:', e);
  }
}

/** Reopen whatever was on screen before the reload. */
function restoreActiveChat() {
  const active = loadActive();

  if (active) {
    // The exact chat that was open.
    if (active.i) {
      const chat = loadChat(active.i);
      if (chat && characters[chat.character]) {
        loadChatById(chat.id);
        return;
      }
    }
    // Otherwise the character on its own, which reopens its newest chat.
    if (active.c && characters[active.c]) {
      selectCharacter(active.c);
      return;
    }
  }

  // Nothing recorded — fall back to the newest chat on this device.
  const chats = loadData()
    .slice()
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  if (chats.length && characters[chats[0].character]) {
    selectCharacter(chats[0].character);
  }
}

function loadChat(chatId) {
  const chats = loadData();
  return chats.find(c => c.id === chatId) || null;
}

function upsertChat(chat) {
  const chats = loadData();
  const idx = chats.findIndex(c => c.id === chat.id);
  if (idx >= 0) chats[idx] = chat;
  else chats.unshift(chat);
  saveData(chats);
}

function deleteChat(chatId) {
  const chats = loadData().filter(c => c.id !== chatId);
  saveData(chats);
}

function getChatsForChar(charKey) {
  const chats = loadData().filter(c => c.character === charKey);
  chats.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  return chats;
}

function getMostRecentChat(charKey) {
  const chats = getChatsForChar(charKey);
  return chats.length > 0 ? chats[0] : null;
}

function initCharacters() {
  let custom = loadJSON('pkax_custom_chars', null);
  if (custom === null) custom = loadJSON('cf_chat_custom_chars', {});
  characters = { ...DEFAULT_CHARACTERS, ...(custom && typeof custom === 'object' ? custom : {}) };
}

async function fetchRemoteCharacters() {
  try {
    const res = await fetch(`${WORKER_URL}/api/characters`);
    if (!res.ok) return;
    const data = await res.json();
    const list = (data && data.characters) || [];
    for (const c of list) {
      if (c && c.id) characters[c.id] = {
        name: c.name || 'Unknown',
        greeting: c.greeting || '',
        systemPrompt: c.systemPrompt || '',
        avatar: c.avatar || '',
        remote: true,
      };
    }
    renderSidebar();
    renderCharGrid();
  } catch (e) {}
}

function renderSidebar() {
  charSidebarList.innerHTML = '';
  let shown = 0;
  for (const [k, v] of Object.entries(characters)) {
    const recent = getMostRecentChat(k);
    if (!recent) continue; // sidebar only shows characters you have chatted with
    shown++;
    const item = document.createElement('div');
    item.className = 'sidebar-char' + (k === currentChar ? ' active' : '');
    item.innerHTML = `<div class="sidebar-char-avatar">${avatarImgHtml(v.avatar, v.name)}</div>
      <div class="sidebar-char-text">
        <span class="sidebar-char-name">${escapeHtml(v.name)}</span>
        <span class="sidebar-char-last">${escapeHtml((recent.title || 'Chat').slice(0, 30))}</span>
      </div>`;
    item.onclick = () => selectCharacter(k);
    charSidebarList.appendChild(item);
  }
  if (!shown) {
    charSidebarList.innerHTML = '<p class="empty-hint">No chats yet — hit Discover to pick a character</p>';
  }
}

function renderCharGrid() {
  characterGrid.innerHTML = '';
  const q = (characterSearch?.value || '').toLowerCase();
  for (const [k, v] of Object.entries(characters)) {
    if (q && !v.name.toLowerCase().includes(q)) continue;
    const c = document.createElement('div');
    c.className = 'char-card' + (k === currentChar ? ' active' : '');
    c.innerHTML = `<div class="char-card-avatar">${avatarImgHtml(v.avatar, v.name, 'loading="lazy"')}</div>
      <div class="char-card-name">${escapeHtml(v.name)}</div>`;
    c.onclick = () => selectCharacter(k);
    characterGrid.appendChild(c);
  }
}

characterSearch.addEventListener('input', renderCharGrid);

function selectCharacter(key) {
  currentChar = key;
  const recent = getMostRecentChat(key);
  if (recent) {
    loadChatById(recent.id);
    saveActive();
    return;
  }
  showFreshChat();
  saveActive();
  renderSidebar();
  renderCharGrid();
  renderHistoryPanel();
}

/**
 * Show the character with an empty conversation — just the greeting, no
 * saved chat behind it. Used by New Chat, by Clear, and when the last
 * message of a chat is deleted.
 */
function showFreshChat() {
  currentChatId = null;
  history = [];
  messagesEl.innerHTML = '';
  inputArea.classList.remove('hidden');
  charPicker.classList.add('hidden');
  const char = characters[currentChar];
  if (char) {
    charName.textContent = char.name;
    charGreeting.textContent = char.greeting || '';
    setChatAvatar(char);
    if (char.greeting) addMessage('assistant', char.greeting, null, true);
  }
}

function showDiscover() {
  currentChar = null;
  currentChatId = null;
  history = [];
  charName.textContent = 'Discover';
  charGreeting.textContent = 'Pick a character to start chatting';
  setChatAvatar(null);
  charPicker.classList.remove('hidden');
  inputArea.classList.add('hidden');
  messagesEl.innerHTML = '<div class="empty-state"><p>Choose a character above to start a new chat</p></div>';
  if (characterSearch) characterSearch.value = '';
  renderSidebar();
  renderCharGrid();
  renderHistoryPanel();
}

function renderMsgContent(text) {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map(p => {
    if (!p.startsWith('```')) return escapeHtml(p).replace(/\n/g, '<br>');
    const inner = p.slice(3, -3);
    const nl = inner.indexOf('\n');
    let lang = '', code = inner;
    if (nl > -1) { lang = escapeHtml(inner.slice(0, nl).trim()); code = inner.slice(nl + 1); }
    const id = 'cb_' + (++msgCounter);
    return `<div class="code-wrap"><button class="copy-btn" onclick="copyCode('${id}')">Copy</button><pre><code${lang ? ' class="language-'+lang+'"' : ''} id="${id}">${escapeHtml(code)}</code></pre></div>`;
  }).join('');
}

window.copyCode = function(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const text = el.textContent;
  navigator.clipboard.writeText(text).then(() => {
    const wrap = el.closest('.code-wrap');
    const btn = wrap && wrap.querySelector('.copy-btn');
    if (btn) { const orig = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = orig, 1500); }
  }).catch(() => {});
};

function extractThinkingBlocks(text) {
  const re = /<thinking>([\s\S]*?)<\/thinking>/gi;
  let thinking = '';
  let m;
  while ((m = re.exec(text)) !== null) thinking += (thinking ? '\n\n' : '') + m[1].trim();
  const cleaned = text.replace(re, '').replace(/<thinking>[\s\S]*$/i, '').trim();
  return { thinking, cleaned };
}

function addMessage(role, content, id, isGreeting) {
  id = id || uid();
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.dataset.msgId = id;

  const { cleaned } = extractThinkingBlocks(content);

  const contentSpan = document.createElement('span');
  contentSpan.className = 'msg-text';
  contentSpan.innerHTML = renderMsgContent(cleaned);
  div.appendChild(contentSpan);

  // buildActions is the single source of truth for these buttons — the
  // streaming/regenerate paths call it too, so they stay in sync.
  if (!(role === 'assistant' && isGreeting)) {
    div.appendChild(buildActions(id));
  }

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function renderMessages() {
  messagesEl.innerHTML = '';
  for (const m of history) {
    const div = addMessage(m.role, m.content, m._id, m._greeting);
    if (m.role === 'assistant' && m._streaming) {
      div.querySelector('.msg-text').classList.add('streaming');
    }
  }
}

function updateMsgText(id, content) {
  const el = messagesEl.querySelector(`[data-msg-id="${id}"]`);
  if (!el) return;
  const { cleaned } = extractThinkingBlocks(content);
  const textSpan = el.querySelector('.msg-text');
  if (textSpan) textSpan.innerHTML = renderMsgContent(cleaned);
}

function updateVersionLabel(id) {
  const el = messagesEl.querySelector(`[data-msg-id="${id}"]`);
  if (!el) return;
  const msg = history.find(m => m._id === id);
  if (!msg || !msg._versions) return;
  const labels = el.querySelectorAll('.version-label');
  if (labels.length > 0) {
    labels[0].textContent = (msg._currentVersion + 1) + '/' + msg._versions.length;
  }
}

function editUserMessage(id) {
  if (sending) return;
  const idx = history.findIndex(m => m._id === id);
  if (idx === -1) return;
  const msgDiv = messagesEl.querySelector(`[data-msg-id="${id}"]`);
  if (!msgDiv) return;
  const textEl = msgDiv.querySelector('.msg-text');
  if (!textEl) return;

  const current = history[idx].content;
  const container = document.createElement('div');
  container.className = 'msg-edit-container';

  const input = document.createElement('textarea');
  input.className = 'msg-edit-input';
  input.value = current;
  input.style.minHeight = '40px';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'msg-edit-save-btn';
  saveBtn.textContent = 'Save & Regenerate';

  container.appendChild(input);
  container.appendChild(saveBtn);
  textEl.replaceWith(container);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  const actionsEl = msgDiv && msgDiv.querySelector('.msg-actions');
  if (actionsEl) actionsEl.style.display = 'none';

  function exitEdit(newContent) {
    const span = document.createElement('span');
    span.className = 'msg-text';
    span.innerHTML = renderMsgContent(newContent);
    container.replaceWith(span);
    if (actionsEl) actionsEl.style.display = '';
  }

  saveBtn.onclick = async () => {
    if (sending) return;
    const newText = input.value.trim();
    if (!newText || newText === current) { exitEdit(current); return; }
    history[idx].content = newText;
    exitEdit(newText);

    const assistIdx = findNextAssistant(idx);
    if (assistIdx !== -1) {
      const oldId = history[assistIdx]._id;
      const oldEl = messagesEl.querySelector(`[data-msg-id="${oldId}"]`);
      if (oldEl) oldEl.remove();
      history.splice(assistIdx, 1);
    }
    try {
      await regenerateAfter(idx);
    } catch (e) {
      console.error('Regenerate after edit failed:', e);
      sending = false;
    }
  };

  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveBtn.click(); }
    if (e.key === 'Escape') { exitEdit(current); }
  });
}

function editAssistantMessage(id) {
  if (sending) return;
  const idx = history.findIndex(m => m._id === id);
  if (idx === -1) return;
  const msgDiv = messagesEl.querySelector(`[data-msg-id="${id}"]`);
  if (!msgDiv) return;
  const textEl = msgDiv.querySelector('.msg-text');
  if (!textEl) return;

  const current = history[idx].content;
  const container = document.createElement('div');
  container.className = 'msg-edit-container';

  const input = document.createElement('textarea');
  input.className = 'msg-edit-input';
  input.value = current;
  input.style.minHeight = '40px';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'msg-edit-save-btn';
  saveBtn.textContent = 'Save';

  container.appendChild(input);
  container.appendChild(saveBtn);
  textEl.replaceWith(container);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  const actionsEl = msgDiv && msgDiv.querySelector('.msg-actions');
  if (actionsEl) actionsEl.style.display = 'none';

  function exitEdit(newContent) {
    const span = document.createElement('span');
    span.className = 'msg-text';
    span.innerHTML = renderMsgContent(newContent);
    container.replaceWith(span);
    if (actionsEl) actionsEl.style.display = '';
  }

  saveBtn.onclick = () => {
    const newText = input.value.trim();
    if (!newText) { exitEdit(current); return; }
    history[idx].content = newText;
    pushVersion(history[idx], newText);
    exitEdit(newText);
    updateVersionLabel(id);
    saveCurrentChat();
  };

  input.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { exitEdit(current); }
  });
}

function findPrevUser(idx) {
  for (let i = idx - 1; i >= 0; i--) {
    if (history[i].role === 'user') return i;
  }
  return -1;
}

function findNextAssistant(idx) {
  for (let i = idx + 1; i < history.length; i++) {
    if (history[i].role === 'assistant') return i;
  }
  return -1;
}

/** The raw user/assistant turns up to and including upToIdx, cleaned. */
function collectHistory(upToIdx) {
  const char = characters[currentChar] || {};
  const result = [];
  for (let i = 0; i <= upToIdx; i++) {
    const m = history[i];
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (m.role === 'assistant' && char.greeting && m.content === char.greeting) continue;
    const cleaned = extractThinkingBlocks(m.content).cleaned;
    if (!cleaned) continue;
    result.push({ role: m.role, content: String(cleaned).slice(0, budget.maxMessageChars) });
  }
  return result;
}

/**
 * Keep the newest contiguous run of turns that still fits alongside the
 * tokens already reserved for the incoming turn. Walking backwards keeps
 * the conversation coherent; dropping an arbitrary turn would leave an
 * orphaned reply with no question attached.
 */
function keepWithinBudget(result, room, reservedTokens) {
  const kept = [];
  let used = reservedTokens;

  for (let i = result.length - 1; i >= 0; i--) {
    const cost = messageTokens(result[i].content);
    if (used + cost > room) break;
    kept.unshift(result[i]);
    used += cost;
  }

  // A single message can exceed the whole budget. Slice it rather than
  // dropping the turn and losing the question entirely.
  if (kept.length === 0 && result.length > 0) {
    const last = result[result.length - 1];
    const spare = Math.max(0, room - used - budget.perMessageOverhead);
    const maxChars = Math.floor(spare / budget.charsPerToken);
    const clipped = last.content.slice(0, maxChars);
    kept.push({
      role: last.role,
      content: clipped.length < last.content.length ? `${clipped}\n…[truncated]` : clipped,
    });
  }

  return kept;
}

function buildSendHistory(upToIdx, rawMsg) {
  const char = characters[currentChar] || {};
  const result = collectHistory(upToIdx);

  // Budget the incoming message together with history — reserving only for
  // history lets a max-length message push the request over the window.
  const room = conversationRoomFor(char.systemPrompt || '', char.greeting || '');
  const msgChars = Math.min(
    budget.maxMessageChars,
    Math.floor(Math.max(0, room - budget.perMessageOverhead) / budget.charsPerToken)
  );
  const msg = String(rawMsg || '').trim().slice(0, msgChars);

  return {
    history: keepWithinBudget(result, room, messageTokens(msg)),
    message: msg,
  };
}

/**
 * The request for a continuation.
 *
 * The whole context — every turn up to and including the model's last reply
 * — is sent again with no new user message, and the model writes the next
 * assistant turn. Nothing new is asked, so it simply keeps going. This is
 * how "carry on" works.
 */
function makeContinueBody(continueIdx) {
  const char = characters[currentChar] || {};
  const room = conversationRoomFor(char.systemPrompt || '', char.greeting || '');

  // Everything up to and including the turn being carried on from.
  const result = collectHistory(continueIdx);

  return {
    message: '',
    continue: true,
    character: {
      name: char.name || 'Assistant',
      greeting: char.greeting || '',
      systemPrompt: String(char.systemPrompt || '').slice(0, budget.maxSystemChars),
    },
    // No incoming turn, so the history may use the whole room.
    history: keepWithinBudget(result, room, 0),
  };
}

function makeSendBody(msg, sendHistory) {
  const char = characters[currentChar] || {};
  return {
    message: String(msg || '').trim().slice(0, budget.maxMessageChars),
    character: {
      name: char.name || 'Assistant',
      greeting: char.greeting || '',
      systemPrompt: String(char.systemPrompt || '').slice(0, budget.maxSystemChars),
    },
    history: sendHistory,
  };
}

/* Retries live here in the browser; the worker has no retry logic of its own.
 * Returns a typed result so callers never have to sniff the text for a
 * success sentinel.
 */
async function streamResponse(assistId, body) {
  const MAX_RETRIES = 5;
  const RETRY_STATUS = ['429', '500', '502', '503'];

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let full = '';
    let streamError = null;
    let sawDone = false;

    /* Re-rendering the whole reply for every chunk is O(n) a time, which
     * becomes O(n^2) over a message. On a slow device the main thread
     * stalls for long enough that the connection gets dropped part way
     * through — which is what made replies look like they were being cut
     * off. Paint at most once every 32ms instead of once per chunk.
     */
    let renderTimer = null;
    const paint = (text) => {
      if (renderTimer) return;
      renderTimer = setTimeout(() => {
        renderTimer = null;
        updateMsgText(assistId, text);
      }, 32);
    };
    const paintNow = (text) => {
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      updateMsgText(assistId, text);
    };

    try {
      if (attempt > 0) {
        paintNow(`*Retrying (${attempt + 1}/${MAX_RETRIES}) — backing off…*`);
      }

      const res = await fetch(`${WORKER_URL}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Present only when signed in; the worker exempts these callers
          // from the anonymous chat rate limit.
          ...(sessionId ? { Authorization: 'Bearer ' + sessionId } : {}),
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`Worker ${res.status}: ${t.slice(0, 500)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data: ')) continue;
          let chunk;
          try {
            chunk = JSON.parse(t.slice(6));
          } catch (e) {
            console.error('Stream parse error:', e);
            continue;
          }
          if (chunk.content) {
            full += chunk.content;
            paint(full);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
          if (chunk.error) {
            streamError = chunk.error;
            break;
          }
          if (chunk.done) { sawDone = true; break; }
        }
        // Only an error frame ends the stream early. Normal completion is
        // signalled by reader.read() returning done, so we must keep
        // looping while content is still arriving.
        if (streamError) break;
      }

      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }

      // The worker sends {done:true} when it has finished the reply. If
      // that never arrives the answer is a fragment — the connection went
      // away part way through. Try again rather than showing half an
      // answer as though it were the whole thing.
      if (!streamError && !sawDone) {
        streamError = 'The reply was cut off before it finished.';
      }

      if (streamError) {
        const retryable =
          !sawDone ||
          RETRY_STATUS.some((s) => String(streamError).includes(s));

        if (attempt < MAX_RETRIES - 1 && retryable) {
          await backoff(attempt);
          continue;
        }

        // Nothing left to try. Show what did arrive instead of throwing
        // the text away.
        if (full) {
          const { cleaned } = extractThinkingBlocks(full);
          updateMsgText(assistId, cleaned + '\n\n*' + String(streamError) + '*');
          return { ok: true, text: cleaned, attempts: attempt + 1, truncated: true };
        }
        return { ok: false, text: String(streamError), attempts: attempt + 1 };
      }

      const { cleaned } = extractThinkingBlocks(full);
      updateMsgText(assistId, cleaned);
      return { ok: true, text: cleaned, attempts: attempt + 1 };
    } catch (e) {
      console.error(`Stream attempt ${attempt + 1}/${MAX_RETRIES} failed:`, e);
      const msg = e?.message || String(e);
      const retryable =
        RETRY_STATUS.some((s) => msg.includes(`Worker ${s}`)) ||
        msg.includes('Failed to fetch') ||
        msg.includes('NetworkError') ||
        msg.includes('Failed');

      if (attempt < MAX_RETRIES - 1 && retryable) {
        await backoff(attempt);
        continue;
      }

      // Keep whatever arrived — a half reply is better than nothing.
      if (full) {
        const { cleaned } = extractThinkingBlocks(full);
        updateMsgText(assistId, cleaned + '\n\n*' + msg + '*');
        return { ok: true, text: cleaned, attempts: attempt + 1, truncated: true };
      }
      return { ok: false, text: `Error: ${msg} (after ${attempt + 1} tries)`, attempts: attempt + 1 };
    }
  }

  return { ok: false, text: 'Error: request failed', attempts: MAX_RETRIES };
}

function backoff(attempt) {
  const delay = Math.min(7000, 600 * Math.pow(1.7, attempt) + Math.random() * 400);
  return new Promise((r) => setTimeout(r, delay));
}

// Regenerations and edits are kept so the user can flip between them.
// There is no limit — every version is saved. If storage ever fills up,
// saveData() sheds the oldest ones rather than losing the chat.
function pushVersion(msg, text) {
  if (!Array.isArray(msg._versions)) msg._versions = [];
  const existing = msg._versions.indexOf(text);
  if (existing !== -1) {
    msg._currentVersion = existing;
  } else {
    msg._versions.push(text);
    msg._currentVersion = msg._versions.length - 1;
  }
  return msg._currentVersion;
}

async function regenerateResponse(id) {
  if (sending) return;
  const assistIdx = history.findIndex(m => m._id === id);
  if (assistIdx === -1) return;
  const userIdx = findPrevUser(assistIdx);
  if (userIdx === -1) return;

  const oldContent = history[assistIdx].content;
  pushVersion(history[assistIdx], oldContent);

  const msg = history[userIdx].content;
  const { history: sendHistory, message: budgetedMsg } = buildSendHistory(userIdx - 1, msg);

  const el = messagesEl.querySelector(`[data-msg-id="${id}"]`);
  if (el) {
    el.querySelector('.msg-text').innerHTML = '';
    el.querySelector('.msg-text').classList.add('streaming');
  }

  sending = true;
  const body = makeSendBody(budgetedMsg, sendHistory);
  const { ok, text } = await streamResponse(id, body);
  sending = false;

  const full = ok ? text : '';

  history[assistIdx].content = full || oldContent;
  pushVersion(history[assistIdx], full || oldContent);

  const el2 = messagesEl.querySelector(`[data-msg-id="${id}"]`);
  if (el2) {
    el2.querySelector('.msg-text').classList.remove('streaming');
    updateMsgText(id, ok ? full : text);
    const oldActions = el2.querySelector('.msg-actions');
    if (oldActions) {
      const newActions = buildActions(id);
      oldActions.replaceWith(newActions);
    }
  }
  updateVersionLabel(id);
  saveCurrentChat();
}

function cycleVersion(id, dir) {
  const idx = history.findIndex(m => m._id === id);
  if (idx === -1) return;
  const msg = history[idx];
  if (!msg._versions || msg._versions.length < 2) return;

  msg._currentVersion = (msg._currentVersion + dir + msg._versions.length) % msg._versions.length;
  msg.content = msg._versions[msg._currentVersion];
  updateMsgText(id, msg.content);
  updateVersionLabel(id);
  saveCurrentChat();
}

async function regenerateAfter(userIdx) {
  const msg = history[userIdx].content;
  const { history: sendHistory, message: budgetedMsg } = buildSendHistory(userIdx - 1, msg);

  const newId = uid();
  const streamDiv = addMessage('assistant', '', newId, false);
  streamDiv.querySelector('.msg-text').classList.add('streaming');
  const entry = { role: 'assistant', content: '', _id: newId, _versions: [], _currentVersion: 0, _streaming: true };
  history.splice(userIdx + 1, 0, entry);
  sending = true;
  const body = makeSendBody(budgetedMsg, sendHistory);
  const { ok, text } = await streamResponse(newId, body);
  sending = false;

  const full = ok ? text : `Error: ${text}`;
  entry.content = full;
  entry._versions = [full];
  entry._currentVersion = 0;
  delete entry._streaming;
  const el = messagesEl.querySelector(`[data-msg-id="${newId}"]`);
  if (el) {
    el.querySelector('.msg-text').classList.remove('streaming');
    updateMsgText(newId, full);
    const oldActions = el.querySelector('.msg-actions');
    if (oldActions) {
      const newActions = buildActions(newId);
      oldActions.replaceWith(newActions);
    }
  }
  saveCurrentChat();
}

function buildActions(id) {
  const div = document.createElement('div');
  div.className = 'msg-actions';
  const msg = history.find(m => m._id === id);
  if (!msg) return div;

  if (msg.role === 'user') {
    const btn = document.createElement('button');
    btn.className = 'msg-action-btn';
    btn.innerHTML = ICON_EDIT;
    btn.title = 'Edit';
    btn.onclick = () => editUserMessage(id);
    div.appendChild(btn);
  } else if (!msg._greeting) {
    const regen = document.createElement('button');
    regen.className = 'msg-action-btn';
    regen.innerHTML = ICON_REGEN;
    regen.title = 'Regenerate';
    regen.onclick = () => regenerateResponse(id);
    div.appendChild(regen);

    const edit = document.createElement('button');
    edit.className = 'msg-action-btn';
    edit.innerHTML = ICON_EDIT;
    edit.title = 'Edit';
    edit.onclick = () => editAssistantMessage(id);
    div.appendChild(edit);

    if (msg._versions && msg._versions.length > 1) {
      const prev = document.createElement('button');
      prev.className = 'msg-action-btn';
      prev.innerHTML = ICON_PREV;
      prev.title = 'Previous';
      prev.onclick = () => cycleVersion(id, -1);
      div.appendChild(prev);

      const lbl = document.createElement('span');
      lbl.className = 'version-label';
      lbl.textContent = (msg._currentVersion + 1) + '/' + msg._versions.length;
      div.appendChild(lbl);

      const next = document.createElement('button');
      next.className = 'msg-action-btn';
      next.innerHTML = ICON_NEXT;
      next.title = 'Next';
      next.onclick = () => cycleVersion(id, 1);
      div.appendChild(next);
    }
  }

  // The trash sits at the end of the bar, apart from the other actions.
  if (!msg._greeting) {
    const del = document.createElement('button');
    del.className = 'msg-action-btn msg-action-danger';
    del.innerHTML = ICON_DELETE;
    del.title = 'Delete';
    del.setAttribute('aria-label', 'Delete message');
    del.onclick = () => deleteMessage(id);
    div.appendChild(del);
  }

  return div;
}

/**
 * Delete a message.
 *
 * It is dropped from the history that gets sent to the model, so it is
 * sniped from the context as well as from the screen.
 */
function deleteMessage(id) {
  if (sending) return;

  const idx = history.findIndex(m => m._id === id);
  if (idx === -1) return;

  const msg = history[idx];
  const raw = String(msg.content || '');
  const preview = raw.replace(/\s+/g, ' ').slice(0, 40);
  const what = msg.role === 'user' ? 'your message' : 'the reply';
  if (!confirm(
    `Delete ${what}?\n\n"${preview}${raw.length > 40 ? '…' : ''}"\n\nThis cannot be undone.`
  )) return;

  history.splice(idx, 1);

  const el = messagesEl.querySelector(`[data-msg-id="${id}"]`);
  if (el) el.remove();

  // A chat with nothing left in it is not a chat.
  if (history.length === 0) {
    if (currentChatId) deleteChat(currentChatId);
    showFreshChat();
  } else {
    saveCurrentChat();
  }

  saveActive();
  renderSidebar();
  renderCharGrid();
  renderHistoryPanel();
}

// ─── Send ───
sendBtn.onclick = sendMessage;
chatInput.onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
};

/**
 * Carry on from the model's last reply.
 *
 * The whole context is sent again with no new user message and the model
 * writes the next assistant turn, so nothing extra is asked and the reply
 * simply keeps going. Sending an empty message is what triggers this.
 */
async function continueLastResponse() {
  // The model's last reply is the turn that gets carried on from.
  let continueIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant') { continueIdx = i; break; }
  }

  if (continueIdx === -1) {
    toast('Nothing to continue yet — send a message first.');
    return;
  }

  // A reply that failed is not something to carry on from.
  if (String(history[continueIdx].content || '').startsWith('Error:')) {
    toast('That reply failed — regenerate it first.');
    return;
  }

  // Clear any stray whitespace so the box is ready for the next message.
  chatInput.value = '';

  sending = true;
  sendBtn.disabled = true;

  const assistId = uid();
  addMessage('assistant', '', assistId, false);
  const assistEntry = {
    role: 'assistant', content: '', _id: assistId,
    _versions: [], _currentVersion: 0, _streaming: true,
  };
  history.push(assistEntry);
  const placeholder = messagesEl.querySelector(`[data-msg-id="${assistId}"] .msg-text`);
  if (placeholder) placeholder.classList.add('streaming');

  const body = makeContinueBody(continueIdx);
  const { ok, text } = await streamResponse(assistId, body);

  sending = false;
  sendBtn.disabled = false;

  const full = ok ? text : `Error: ${text}`;
  assistEntry.content = full;
  assistEntry._versions = [full];
  assistEntry._currentVersion = 0;
  delete assistEntry._streaming;
  updateMsgText(assistId, full);

  const el = messagesEl.querySelector(`[data-msg-id="${assistId}"]`);
  if (el) {
    const textEl = el.querySelector('.msg-text');
    if (textEl) textEl.classList.remove('streaming');
    const oldActions = el.querySelector('.msg-actions');
    if (oldActions) oldActions.replaceWith(buildActions(assistId));
  }

  if (!currentChatId) currentChatId = uid();
  saveCurrentChat();
  renderSidebar();
  renderHistoryPanel();
}

async function sendMessage() {
  const msg = chatInput.value.trim();
  if (sending || !currentChar || !characters[currentChar]) return;
  // An empty message is not a prompt. It asks the model to carry on from
  // where its last reply stopped.
  if (!msg) return continueLastResponse();
  chatInput.value = '';
  sending = true;
  sendBtn.disabled = true;

  const userMsg = { role: 'user', content: msg, _id: uid() };

  // Built BEFORE pushing userMsg/assistEntry: buildSendHistory(upToIdx)
  // includes index upToIdx, and the worker appends `message` itself. Slicing
  // at history.length - 2 after the push would resend the user's own prompt
  // as both history and message.
  const { history: sendHistory, message: budgetedMsg } = buildSendHistory(history.length - 1, msg);

  history.push(userMsg);
  addMessage('user', msg, userMsg._id, false);

  const assistId = uid();
  addMessage('assistant', '', assistId, false);
  const assistEntry = { role: 'assistant', content: '', _id: assistId, _versions: [], _currentVersion: 0, _streaming: true };
  history.push(assistEntry);
  const placeholder = messagesEl.querySelector(`[data-msg-id="${assistId}"] .msg-text`);
  if (placeholder) placeholder.classList.add('streaming');

  const body = makeSendBody(budgetedMsg, sendHistory);
  const { ok, text } = await streamResponse(assistId, body);

  sending = false;
  sendBtn.disabled = false;
  const full = ok ? text : `Error: ${text}`;
  assistEntry.content = full;
  assistEntry._versions = [full];
  assistEntry._currentVersion = 0;
  delete assistEntry._streaming;
  updateMsgText(assistId, full);

  const el = messagesEl.querySelector(`[data-msg-id="${assistId}"]`);
  if (el) {
    el.querySelector('.msg-text').classList.remove('streaming');
    const oldActions = el.querySelector('.msg-actions');
    if (oldActions) {
      const newActions = buildActions(assistId);
      oldActions.replaceWith(newActions);
    }
  }

  if (!currentChatId) currentChatId = uid();
  saveCurrentChat();
  renderSidebar();
  renderHistoryPanel();
}

function saveCurrentChat() {
  if (!currentChatId || !currentChar) return;
  const firstUser = history.find(m => m.role === 'user');
  const messages = history.map(m => {
    const { _streaming, ...rest } = m;
    // Copy the version list. The saved copy is the one that gets trimmed
    // if storage fills up, and the live conversation must keep every
    // version it has.
    if (Array.isArray(rest._versions)) rest._versions = rest._versions.slice();
    return rest;
  });
  upsertChat({
    id: currentChatId,
    character: currentChar,
    title: firstUser ? firstUser.content.slice(0, 60) : 'Chat',
    messages,
    updated_at: new Date().toISOString(),
  });
  saveActive();
}

resetBtn.onclick = () => {
  if (!currentChar) return;
  if (currentChatId && !confirm('Clear this chat? This cannot be undone.')) return;
  const clearedChar = currentChar;
  if (currentChatId) deleteChat(currentChatId);
  // If that was the last chat with this character, drop them from the
  // sidebar and return to Discover
  if (getChatsForChar(clearedChar).length === 0) {
    showDiscover();
    return;
  }
  // Start a truly fresh chat — don't auto-load the next recent chat
  showFreshChat();
  saveActive();
  renderSidebar();
  renderCharGrid();
  renderHistoryPanel();
};

$('newChatBtn').onclick = () => {
  if (!currentChar || !characters[currentChar]) return;
  showFreshChat();
  saveActive();
  renderSidebar();
  renderCharGrid();
  renderHistoryPanel();
};

$('historyBtn').onclick = () => { renderHistoryPanel(); $('historyArea').classList.remove('hidden'); };
$('closeHistoryBtn').onclick = () => $('historyArea').classList.add('hidden');

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('historyArea').classList.contains('hidden')) $('historyArea').classList.add('hidden');
});

function renderHistoryPanel() {
  const list = $('historyList');
  list.innerHTML = '';
  if (!currentChar) { list.innerHTML = '<p class="empty-hint">Select a character first</p>'; return; }
  const chats = getChatsForChar(currentChar);
  if (chats.length === 0) { list.innerHTML = '<p class="empty-hint">No chats yet</p>'; return; }
  for (const chat of chats) {
    const item = document.createElement('div');
    item.className = 'history-item' + (chat.id === currentChatId ? ' active' : '');
    const date = chat.updated_at ? new Date(chat.updated_at).toLocaleDateString() : '';
    item.innerHTML = `<div class="history-item-title">${escapeHtml(chat.title || 'Untitled')}</div>
      <div class="history-item-meta">${(chat.messages || []).length} msgs · ${date}</div>`;
    item.onclick = () => {
      loadChatById(chat.id);
      $('historyArea').classList.add('hidden');
    };
    list.appendChild(item);
  }
}

function loadChatById(chatId) {
  const chat = loadChat(chatId);
  if (!chat) return;
  currentChatId = chat.id;
  currentChar = chat.character;
  history = (chat.messages || []).map(m => {
    const { _streaming, ...rest } = m;
    return {
      ...rest,
      _versions: m._versions || [m.content],
      _currentVersion: m._currentVersion || 0,
      _id: m._id || uid(),
      _greeting: m._greeting || false,
    };
  });
  messagesEl.innerHTML = '';
  inputArea.classList.remove('hidden');
  charPicker.classList.add('hidden');

  const char = characters[chat.character];
  if (char) {
    charName.textContent = char.name;
    charGreeting.textContent = char.greeting || '';
    setChatAvatar(char);
  }
  renderMessages();
  renderSidebar();
  renderCharGrid();
  renderHistoryPanel();
}

(async function boot() {
  try {
    initCharacters();
    renderSidebar();
    renderCharGrid();
    bindAuthUI();

    // The worker's budget constants and the remote character list both have
    // to be in place before the session and the open chat are restored, so
    // they are awaited rather than fired off and forgotten.
    await fetchBudget();
    await Promise.all([
      fetchRemoteCharacters().catch(() => {}),
      restoreSession().catch(() => {}),
    ]);

    // Reopen the chat that was on screen before the reload.
    restoreActiveChat();
  } catch (e) {
    console.error('[pkax] boot failed:', e);
  }
})();

// Top nav: Chats opens history, Discover returns to the all-characters grid
if ($('spNavChats')) $('spNavChats').onclick = () => { renderHistoryPanel(); $('historyArea').classList.remove('hidden'); };
if ($('spNavDiscover')) $('spNavDiscover').onclick = () => showDiscover();
