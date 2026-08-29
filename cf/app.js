const WORKER_URL = 'https://cf-chat.archlinuxkid99.workers.dev';

let characters = {};
let currentChar = null;
let currentChatId = null;
let history = [];
let sending = false;
let msgCounter = 0;
let currentEditCharKey = null;

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

const messagesEl = $('messages');
const chatInput = $('chatInput');
const sendBtn = $('sendBtn');
const resetBtn = $('resetBtn');
const charName = $('charName');
const charGreeting = $('charGreeting');
const chatCharAvatar = $('chatCharAvatar');
const emptyState = $('emptyState');
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

function loadData() {
  let stored = loadJSON('pkax_chats', null);
  if (stored === null) stored = loadJSON('cf_chat_chats', []);
  return Array.isArray(stored) ? stored : [];
}

function saveData(chats) {
  localStorage.setItem('pkax_chats', JSON.stringify(chats));
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
  for (const [k, v] of Object.entries(characters)) {
    const recent = getMostRecentChat(k);
    const item = document.createElement('div');
    item.className = 'sidebar-char' + (k === currentChar ? ' active' : '');
    item.innerHTML = `<div class="sidebar-char-avatar">${avatarImgHtml(v.avatar, v.name)}</div>
      <div class="sidebar-char-text">
        <span class="sidebar-char-name">${escapeHtml(v.name)}</span>
        ${recent ? `<span class="sidebar-char-last">${escapeHtml((recent.title || 'Chat').slice(0, 30))}</span>` : ''}
      </div>`;
    item.onclick = () => selectCharacter(k);
    charSidebarList.appendChild(item);
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
    if (v.remote) {
      const editBtn = document.createElement('button');
      editBtn.className = 'msg-action-btn char-edit-btn';
      editBtn.title = 'Edit character';
      editBtn.innerHTML = ICON_EDIT;
      editBtn.onclick = (e) => { e.stopPropagation(); openCharModal(k); };
      c.appendChild(editBtn);
    }
    characterGrid.appendChild(c);
  }
}

characterSearch.addEventListener('input', renderCharGrid);

function selectCharacter(key) {
  currentChar = key;
  const recent = getMostRecentChat(key);
  if (recent) {
    loadChatById(recent.id);
    return;
  }
  currentChatId = null;
  history = [];
  messagesEl.innerHTML = '';
  emptyState.classList.add('hidden');
  inputArea.classList.remove('hidden');
  charPicker.classList.add('hidden');
  const char = characters[key];
  if (char) {
    charName.textContent = char.name;
    charGreeting.textContent = char.greeting || '';
    setChatAvatar(char);
    if (char.greeting) {
      addMessage('assistant', char.greeting, null, true);
    }
  }
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

function addMessage(role, content, id, isGreeting, reasoning) {
  id = id || uid();
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.dataset.msgId = id;

  const reasoningSection = document.createElement('div');
  reasoningSection.className = 'reasoning-section';
  if (!reasoning || !reasoning.trim()) {
    reasoningSection.classList.add('hidden');
  }
  reasoningSection.innerHTML = `
    <div class="reasoning-toggle">💭 Reasoning</div>
    <div class="reasoning-content">${reasoning && reasoning.trim() ? escapeHtml(reasoning).replace(/\n/g, '<br>') : ''}</div>
  `;
  div.appendChild(reasoningSection);

  const contentSpan = document.createElement('span');
  contentSpan.className = 'msg-text';
  contentSpan.innerHTML = renderMsgContent(content);
  div.appendChild(contentSpan);

  const actions = document.createElement('div');
  actions.className = 'msg-actions';

  reasoningSection.querySelector('.reasoning-toggle').onclick = () => {
    reasoningSection.classList.toggle('expanded');
  };

  if (role === 'user') {
    const editBtn = document.createElement('button');
    editBtn.className = 'msg-action-btn';
    editBtn.innerHTML = ICON_EDIT;
    editBtn.title = 'Edit message';
    editBtn.onclick = () => editUserMessage(id);
    actions.appendChild(editBtn);
  } else if (role === 'assistant' && !isGreeting) {
    const regenBtn = document.createElement('button');
    regenBtn.className = 'msg-action-btn';
    regenBtn.innerHTML = ICON_REGEN;
    regenBtn.title = 'Regenerate';
    regenBtn.onclick = () => regenerateResponse(id);
    actions.appendChild(regenBtn);

    const editBtn = document.createElement('button');
    editBtn.className = 'msg-action-btn';
    editBtn.innerHTML = ICON_EDIT;
    editBtn.title = 'Edit response';
    editBtn.onclick = () => editAssistantMessage(id);
    actions.appendChild(editBtn);

    const msg = history.find(m => m._id === id);
    if (msg && msg._versions && msg._versions.length > 1) {
      const prevBtn = document.createElement('button');
      prevBtn.className = 'msg-action-btn';
      prevBtn.innerHTML = ICON_PREV;
      prevBtn.title = 'Previous version';
      prevBtn.onclick = () => cycleVersion(id, -1);
      actions.appendChild(prevBtn);

      const versionLabel = document.createElement('span');
      versionLabel.className = 'version-label';
      versionLabel.textContent = (msg._currentVersion + 1) + '/' + msg._versions.length;
      actions.appendChild(versionLabel);

      const nextBtn = document.createElement('button');
      nextBtn.className = 'msg-action-btn';
      nextBtn.innerHTML = ICON_NEXT;
      nextBtn.title = 'Next version';
      nextBtn.onclick = () => cycleVersion(id, 1);
      actions.appendChild(nextBtn);
    }
  }

  div.appendChild(actions);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function renderMessages() {
  messagesEl.innerHTML = '';
  for (const m of history) {
    const div = addMessage(m.role, m.content, m._id, m._greeting, m._reasoning);
    if (m.role === 'assistant' && m._streaming) {
      div.querySelector('.msg-text').classList.add('streaming');
    }
  }
}

function updateMsgText(id, content) {
  const el = messagesEl.querySelector(`[data-msg-id="${id}"]`);
  if (el) {
    const textSpan = el.querySelector('.msg-text');
    if (textSpan) textSpan.innerHTML = renderMsgContent(content);
  }
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
    if (!history[idx]._versions) history[idx]._versions = [];
    if (!history[idx]._versions.includes(newText)) history[idx]._versions.push(newText);
    history[idx]._currentVersion = history[idx]._versions.length - 1;
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

function buildSendHistory(upToIdx) {
  const char = characters[currentChar] || {};
  const result = [];
  for (let i = 0; i <= upToIdx; i++) {
    const m = history[i];
    if (m.role === 'assistant' && char.greeting && m.content === char.greeting) continue;
    result.push({ role: m.role, content: m.content });
  }
  return result;
}

function makeSendBody(msg, sendHistory) {
  const char = characters[currentChar] || {};
  return {
    message: msg,
    character: { name: char.name || 'Assistant', greeting: char.greeting || '', systemPrompt: char.systemPrompt || '' },
    history: sendHistory,
  };
}

async function streamResponse(assistId, body) {
  let full = '';
  let reasoningText = '';
  let reasoningEl = null;
  let reasoningContentEl = null;

  try {
    const res = await fetch(`${WORKER_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Request failed');
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
        try {
          const chunk = JSON.parse(t.slice(6));

          if (chunk.reasoning) {
            reasoningText += chunk.reasoning;
            if (!reasoningEl) {
              const msgEl = messagesEl.querySelector(`[data-msg-id="${assistId}"]`);
              if (msgEl) {
                const existingReasoning = msgEl.querySelector('.reasoning-section');
                if (existingReasoning) existingReasoning.remove();
                const contentSpan = msgEl.querySelector('.msg-text');
                reasoningEl = document.createElement('div');
                reasoningEl.className = 'reasoning-section';
                reasoningEl.innerHTML = `<span class="reasoning-toggle">💭 Reasoning</span><div class="reasoning-content hidden"></div>`;
                const toggle = reasoningEl.querySelector('.reasoning-toggle');
                const rc = reasoningEl.querySelector('.reasoning-content');
                toggle.addEventListener('click', () => {
                  rc.classList.toggle('hidden');
                  toggle.classList.toggle('collapsed');
                });
                if (contentSpan) {
                  msgEl.insertBefore(reasoningEl, contentSpan);
                } else {
                  msgEl.appendChild(reasoningEl);
                }
                reasoningContentEl = rc;
              }
            }
            if (reasoningContentEl) {
              reasoningContentEl.innerHTML = escapeHtml(reasoningText).replace(/\n/g, '<br>');
              messagesEl.scrollTop = messagesEl.scrollHeight;
            }
          }

          if (chunk.content) {
            full += chunk.content;
            updateMsgText(assistId, full);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }

          if (chunk.done) {
            break;
          }

          if (chunk.error) {
            full = chunk.error;
            updateMsgText(assistId, full);
            break;
          }
        } catch (e) {
          console.error('Stream parse error:', e);
        }
      }
    }
  } catch (e) {
    console.error('Stream request failed:', e);
    full = full || 'Error: ' + e.message;
  }
  return { full, reasoning: reasoningText };
}

async function regenerateResponse(id) {
  if (sending) return;
  const assistIdx = history.findIndex(m => m._id === id);
  if (assistIdx === -1) return;
  const userIdx = findPrevUser(assistIdx);
  if (userIdx === -1) return;

  const oldContent = history[assistIdx].content;
  if (!history[assistIdx]._versions) history[assistIdx]._versions = [oldContent];
  else if (!history[assistIdx]._versions.includes(oldContent)) history[assistIdx]._versions.push(oldContent);
  history[assistIdx]._currentVersion = history[assistIdx]._versions.length;

  const msg = history[userIdx].content;
  const sendHistory = buildSendHistory(userIdx - 1);

  const el = messagesEl.querySelector(`[data-msg-id="${id}"]`);
  if (el) {
    el.querySelector('.msg-text').innerHTML = '';
    el.querySelector('.msg-text').classList.add('streaming');
  }

  sending = true;
  const body = makeSendBody(msg, sendHistory);
  const { full, reasoning } = await streamResponse(id, body);
  sending = false;

  history[assistIdx].content = full || oldContent;
  history[assistIdx]._reasoning = reasoning || '';
  history[assistIdx]._versions.push(full || oldContent);
  history[assistIdx]._currentVersion = history[assistIdx]._versions.length - 1;

  const el2 = messagesEl.querySelector(`[data-msg-id="${id}"]`);
  if (el2) {
    el2.querySelector('.msg-text').classList.remove('streaming');
    if (full) updateMsgText(id, full);
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
  const sendHistory = buildSendHistory(userIdx - 1);

  const newId = uid();
  const streamDiv = addMessage('assistant', '', newId, false);
  streamDiv.querySelector('.msg-text').classList.add('streaming');
  const entry = { role: 'assistant', content: '', _id: newId, _versions: [], _currentVersion: 0, _streaming: true };
  history.splice(userIdx + 1, 0, entry);
  sending = true;
  const body = makeSendBody(msg, sendHistory);
  const { full, reasoning } = await streamResponse(newId, body);
  sending = false;

  entry.content = full;
  entry._reasoning = reasoning || '';
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
  return div;
}

// ─── Image helper (avatar only) ───
const MAX_IMAGE_DIM = 1024;

function compressImageFile(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = (e) => {
      const raw = e.target.result;
      const img = new Image();
      img.onerror = () => resolve(raw);
      img.onload = () => {
        try {
          const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(img.width, img.height));
          if (scale >= 1 && raw.length < 400000) { resolve(raw); return; }
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          const cctx = canvas.getContext('2d');
          cctx.fillStyle = '#0a0a0b';
          cctx.fillRect(0, 0, canvas.width, canvas.height);
          cctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        } catch (err) {
          resolve(raw);
        }
      };
      img.src = raw;
    };
    reader.readAsDataURL(file);
  });
}

// ─── Send ───
sendBtn.onclick = sendMessage;
chatInput.onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
};

async function sendMessage() {
  const msg = chatInput.value.trim();
  if (!msg || sending || !currentChar || !characters[currentChar]) return;
  chatInput.value = '';
  sending = true;
  sendBtn.disabled = true;

  const userMsg = { role: 'user', content: msg, _id: uid() };
  history.push(userMsg);
  addMessage('user', msg, userMsg._id, false);

  const sendHistory = buildSendHistory(history.length - 2);
  const assistId = uid();
  addMessage('assistant', '', assistId, false);
  const assistEntry = { role: 'assistant', content: '', _id: assistId, _versions: [], _currentVersion: 0, _streaming: true };
  history.push(assistEntry);
  const placeholder = messagesEl.querySelector(`[data-msg-id="${assistId}"] .msg-text`);
  if (placeholder) placeholder.classList.add('streaming');

  const body = makeSendBody(msg, sendHistory);
  const { full, reasoning } = await streamResponse(assistId, body);

  sending = false;
  sendBtn.disabled = false;
  assistEntry.content = full;
  assistEntry._reasoning = reasoning || '';
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
    return rest;
  });
  upsertChat({
    id: currentChatId,
    character: currentChar,
    title: firstUser ? firstUser.content.slice(0, 60) : 'Chat',
    messages,
    updated_at: new Date().toISOString(),
  });
}

resetBtn.onclick = () => {
  if (!currentChar) return;
  if (currentChatId && !confirm('Clear this chat? This cannot be undone.')) return;
  if (currentChatId) deleteChat(currentChatId);
  // Start a truly fresh chat — don't auto-load the next recent chat
  currentChatId = null;
  history = [];
  messagesEl.innerHTML = '';
  emptyState.classList.add('hidden');
  inputArea.classList.remove('hidden');
  charPicker.classList.add('hidden');
  const char = characters[currentChar];
  if (char) {
    charName.textContent = char.name;
    charGreeting.textContent = char.greeting || '';
    setChatAvatar(char);
    if (char.greeting) addMessage('assistant', char.greeting, null, true);
  }
  renderSidebar();
  renderCharGrid();
  renderHistoryPanel();
};

$('newChatBtn').onclick = () => {
  if (!currentChar || !characters[currentChar]) return;
  currentChatId = null;
  history = [];
  messagesEl.innerHTML = '';
  emptyState.classList.add('hidden');
  inputArea.classList.remove('hidden');
  charPicker.classList.add('hidden');
  const char = characters[currentChar];
  if (char) {
    charName.textContent = char.name;
    charGreeting.textContent = char.greeting || '';
    setChatAvatar(char);
    if (char.greeting) addMessage('assistant', char.greeting, null, true);
  }
  renderSidebar();
  renderCharGrid();
  renderHistoryPanel();
};

$('historyBtn').onclick = () => { renderHistoryPanel(); $('historyArea').classList.remove('hidden'); };
$('closeHistoryBtn').onclick = () => $('historyArea').classList.add('hidden');

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('charModal').classList.contains('hidden')) { closeCharModal(); return; }
  if (!$('historyArea').classList.contains('hidden')) $('historyArea').classList.add('hidden');
});

$('charModal').addEventListener('mousedown', (e) => {
  if (e.target === $('charModal')) closeCharModal();
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
  emptyState.classList.add('hidden');
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

initCharacters();
renderSidebar();
renderCharGrid();
fetchRemoteCharacters();

// ─── Character Creation / Editing ───
let cmNameEl, cmGreetingEl, cmPromptEl, cmAvatarPreview, cmAvatarInput, cmAvatarBtn, cmAvatarClear;
let newCharAvatar = null;

function charModalInit() {
  cmNameEl = $('cmName');
  cmGreetingEl = $('cmGreeting');
  cmPromptEl = $('cmPrompt');
  cmAvatarPreview = $('cmAvatarPreview');
  cmAvatarInput = $('cmAvatarInput');
  cmAvatarBtn = $('cmAvatarBtn');
  cmAvatarClear = $('cmAvatarClear');

  $('newCharBtn').onclick = () => openCharModal();
  $('closeCharModalBtn').onclick = closeCharModal;
  $('cmDeleteBtn').onclick = deleteCharacter;
  $('cmSaveBtn').onclick = saveCharacter;
  cmAvatarBtn.onclick = () => cmAvatarInput.click();
  cmAvatarInput.onchange = async () => {
    const file = cmAvatarInput.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      alert('Please choose an image file');
      cmAvatarInput.value = '';
      return;
    }
    const dataUrl = await compressImageFile(file);
    if (!dataUrl) {
      alert('Could not read that image');
      cmAvatarInput.value = '';
      return;
    }
    newCharAvatar = dataUrl;
    updateAvatarPreview();
    cmAvatarInput.value = '';
  };
  cmAvatarClear.onclick = () => {
    newCharAvatar = null;
    cmAvatarInput.value = '';
    updateAvatarPreview();
  };
}

function openCharModal(editingKey) {
  currentEditCharKey = editingKey || null;
  newCharAvatar = null;
  cmAvatarInput.value = '';
  const char = editingKey ? characters[editingKey] : null;
  cmNameEl.value = char ? char.name : '';
  cmGreetingEl.value = char ? (char.greeting || '') : '';
  cmPromptEl.value = char ? (char.systemPrompt || '') : '';
  $('charModalTitle').textContent = char ? 'Edit Character' : 'New Character';
  $('cmSaveBtn').textContent = char ? 'Save' : 'Create';
  $('cmDeleteBtn').classList.toggle('hidden', !char);
  if (char && char.avatar) newCharAvatar = safeAvatar(char.avatar) || null;
  updateAvatarPreview();
  $('charModal').classList.remove('hidden');
  cmNameEl.focus();
}

function updateAvatarPreview() {
  const safe = safeAvatar(newCharAvatar || '');
  if (safe) {
    newCharAvatar = safe;
    cmAvatarPreview.style.backgroundImage = `url("${safe.replace(/"/g, '%22')}")`;
    cmAvatarPreview.classList.remove('empty');
  } else {
    cmAvatarPreview.style.backgroundImage = '';
    cmAvatarPreview.classList.add('empty');
  }
}

function closeCharModal() {
  $('charModal').classList.add('hidden');
  currentEditCharKey = null;
  newCharAvatar = null;
}

async function saveCharacter() {
  const name = cmNameEl.value.trim();
  if (!name) { cmNameEl.focus(); return; }
  const payload = {
    name,
    greeting: cmGreetingEl.value,
    systemPrompt: cmPromptEl.value,
    avatar: newCharAvatar || '',
  };
  try {
    let char;
    if (currentEditCharKey) {
      const res = await fetch(`${WORKER_URL}/api/characters/${encodeURIComponent(currentEditCharKey)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'save failed');
      char = data.character;
      characters[currentEditCharKey] = {
        name: char.name, greeting: char.greeting || '', systemPrompt: char.systemPrompt || '', avatar: char.avatar || '', remote: true,
      };
      if (currentChar === currentEditCharKey) {
        charName.textContent = characters[currentEditCharKey].name;
        charGreeting.textContent = characters[currentEditCharKey].greeting || '';
      }
    } else {
      const res = await fetch(`${WORKER_URL}/api/characters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'create failed');
      char = data.character;
      characters[char.id] = {
        name: char.name, greeting: char.greeting || '', systemPrompt: char.systemPrompt || '', avatar: char.avatar || '', remote: true,
      };
    }
    closeCharModal();
    renderSidebar();
    renderCharGrid();
    selectCharacter(char.id);
  } catch (e) {
    alert('Could not save character: ' + e.message);
  }
}

async function deleteCharacter() {
  if (!currentEditCharKey) return;
  if (!confirm('Delete this character permanently?')) return;
  try {
    const res = await fetch(`${WORKER_URL}/api/characters/${encodeURIComponent(currentEditCharKey)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'delete failed');
    }
    delete characters[currentEditCharKey];
    saveData(loadData().filter(c => c.character !== currentEditCharKey));
    if (currentChar === currentEditCharKey) {
      currentChar = null;
      currentChatId = null;
      history = [];
      messagesEl.innerHTML = '';
      emptyState.classList.remove('hidden');
      inputArea.classList.add('hidden');
      charName.textContent = 'Select a Character';
      charGreeting.textContent = '';
      setChatAvatar(null);
    }
    closeCharModal();
    renderSidebar();
    renderCharGrid();
    renderHistoryPanel();
  } catch (e) {
    alert('Could not delete character: ' + e.message);
  }
}

window.clearAllData = function() {
  localStorage.clear();
  sessionStorage.clear();
  currentChatId = null;
  currentChar = null;
  history = [];
  messagesEl.innerHTML = '';
  emptyState.classList.remove('hidden');
  inputArea.classList.add('hidden');
  charName.textContent = 'Select a Character';
  charGreeting.textContent = '';
  setChatAvatar(null);
  renderSidebar();
  renderCharGrid();
  renderHistoryPanel();
  console.log('All local data cleared. Reload the page to reset completely.');
};

charModalInit();
