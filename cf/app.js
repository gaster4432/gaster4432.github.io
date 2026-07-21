const WORKER_URL = 'https://lucky-band-5c81.archlinuxkid99.workers.dev';

let characters = {};
let currentChar = null;
let currentChatId = null;
let history = [];
let sending = false;
let msgCounter = 0;
let imageData = null;

const $ = id => document.getElementById(id);
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
const imageInput = $('imageInput');
const imageUploadBtn = $('imageUploadBtn');
const imagePreview = $('imagePreview');
const previewImg = $('previewImg');
const clearImageBtn = $('clearImageBtn');


function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function uid() { return 'm' + (++msgCounter) + '_' + Date.now(); }

function loadData() {
  const stored = localStorage.getItem('cf_chat_chats');
  return stored ? JSON.parse(stored) : [];
}

function saveData(chats) {
  localStorage.setItem('cf_chat_chats', JSON.stringify(chats));
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
  const stored = localStorage.getItem('cf_chat_custom_chars');
  const custom = stored ? JSON.parse(stored) : {};
  characters = { ...DEFAULT_CHARACTERS, ...custom };
}

function renderSidebar() {
  charSidebarList.innerHTML = '';
  for (const [k, v] of Object.entries(characters)) {
    const recent = getMostRecentChat(k);
    const item = document.createElement('div');
    item.className = 'sidebar-char' + (k === currentChar ? ' active' : '');
    const avatarSrc = v.avatar || '';
    item.innerHTML = `<div class="sidebar-char-avatar">${avatarSrc ? `<img src="${avatarSrc}">` : ''}</div>
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
    const hasAvatar = v.avatar && (v.avatar.startsWith('/') || v.avatar.startsWith('../'));
    c.innerHTML = `<div class="char-card-avatar">${hasAvatar ? `<img src="${v.avatar}" loading="lazy">` : ''}</div>
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
    chatCharAvatar.innerHTML = (char.avatar && (char.avatar.startsWith('/') || char.avatar.startsWith('../')))
      ? `<img src="${char.avatar}" alt="${escapeHtml(char.name)}">` : '';
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
    return `<pre><code${lang ? ' class="language-'+lang+'"' : ''}>${escapeHtml(code)}</code></pre>`;
  }).join('');
}

function addMessage(role, content, id, isGreeting) {
  id = id || uid();
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.dataset.msgId = id;
  const contentSpan = document.createElement('span');
  contentSpan.className = 'msg-text';
  contentSpan.innerHTML = renderMsgContent(content);
  div.appendChild(contentSpan);

  const actions = document.createElement('div');
  actions.className = 'msg-actions';

  if (role === 'user') {
    const editBtn = document.createElement('button');
    editBtn.className = 'msg-action-btn';
    editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    editBtn.title = 'Edit message';
    editBtn.onclick = () => editUserMessage(id);
    actions.appendChild(editBtn);
  } else if (role === 'assistant' && !isGreeting) {
    const regenBtn = document.createElement('button');
    regenBtn.className = 'msg-action-btn';
    regenBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
    regenBtn.title = 'Regenerate';
    regenBtn.onclick = () => regenerateResponse(id);
    actions.appendChild(regenBtn);

    const editBtn = document.createElement('button');
    editBtn.className = 'msg-action-btn';
    editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    editBtn.title = 'Edit response';
    editBtn.onclick = () => editAssistantMessage(id);
    actions.appendChild(editBtn);

    const msg = history.find(m => m._id === id);
    if (msg && msg._versions && msg._versions.length > 1) {
      const prevBtn = document.createElement('button');
      prevBtn.className = 'msg-action-btn';
      prevBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>';
      prevBtn.title = 'Previous version';
      prevBtn.onclick = () => cycleVersion(id, -1);
      actions.appendChild(prevBtn);

      const versionLabel = document.createElement('span');
      versionLabel.className = 'version-label';
      versionLabel.textContent = (msg._currentVersion + 1) + '/' + msg._versions.length;
      actions.appendChild(versionLabel);

      const nextBtn = document.createElement('button');
      nextBtn.className = 'msg-action-btn';
      nextBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>';
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
    const div = addMessage(m.role, m.content, m._id, m._greeting);
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
    await regenerateAfter(idx);
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
  const char = characters[currentChar];
  const result = [];
  for (let i = 0; i <= upToIdx; i++) {
    const m = history[i];
    if (char && m.role === 'assistant' && m.content === char.greeting) continue;
    result.push({ role: m.role, content: m.content });
  }
  return result;
}

function makeSendBody(msg, sendHistory, withImage) {
  const char = characters[currentChar];
  const body = {
    message: msg,
    character: { name: char.name, greeting: char.greeting || '', systemPrompt: char.systemPrompt || '' },
    history: sendHistory,
  };
  if (withImage && imageData) {
    body.image = imageData;
  }
  return body;
}

async function streamResponse(assistId, body) {
  let full = '';
  try {
    const res = await fetch(`${WORKER_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Request failed');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      const lines = text.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const chunk = JSON.parse(line.slice(6));
          if (chunk.content) {
            full += chunk.content;
            updateMsgText(assistId, full);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
        } catch {}
      }
    }
  } catch (e) {
    full = 'Error: ' + e.message;
  }
  return full;
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
  const sendHistory = buildSendHistory(userIdx);

  const el = messagesEl.querySelector(`[data-msg-id="${id}"]`);
  if (el) {
    el.querySelector('.msg-text').innerHTML = '';
    el.querySelector('.msg-text').classList.add('streaming');
  }

  sending = true;
  const body = makeSendBody(msg, sendHistory, false);
  const full = await streamResponse(id, body);
  sending = false;

  history[assistIdx].content = full || oldContent;
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
  const sendHistory = buildSendHistory(userIdx);

  const newId = uid();
  const streamDiv = addMessage('assistant', '', newId, false);
  const entry = { role: 'assistant', content: '', _id: newId, _versions: [], _currentVersion: 0, _streaming: true };
  history.splice(userIdx + 1, 0, entry);
  sending = true;
  const body = makeSendBody(msg, sendHistory, false);
  const full = await streamResponse(newId, body);
  sending = false;

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
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    btn.title = 'Edit';
    btn.onclick = () => editUserMessage(id);
    div.appendChild(btn);
  } else if (!msg._greeting) {
    const regen = document.createElement('button');
    regen.className = 'msg-action-btn';
    regen.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
    regen.title = 'Regenerate';
    regen.onclick = () => regenerateResponse(id);
    div.appendChild(regen);

    const edit = document.createElement('button');
    edit.className = 'msg-action-btn';
    edit.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    edit.title = 'Edit';
    edit.onclick = () => editAssistantMessage(id);
    div.appendChild(edit);

    if (msg._versions && msg._versions.length > 1) {
      const prev = document.createElement('button');
      prev.className = 'msg-action-btn';
      prev.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>';
      prev.title = 'Previous';
      prev.onclick = () => cycleVersion(id, -1);
      div.appendChild(prev);

      const lbl = document.createElement('span');
      lbl.className = 'version-label';
      lbl.textContent = (msg._currentVersion + 1) + '/' + msg._versions.length;
      div.appendChild(lbl);

      const next = document.createElement('button');
      next.className = 'msg-action-btn';
      next.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>';
      next.title = 'Next';
      next.onclick = () => cycleVersion(id, 1);
      div.appendChild(next);
    }
  }
  return div;
}

// ─── Image Upload ───
imageUploadBtn.onclick = () => imageInput.click();
imageInput.onchange = () => {
  const file = imageInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    imageData = e.target.result;
    previewImg.src = imageData;
    imagePreview.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
};
clearImageBtn.onclick = () => {
  imageData = null;
  imageInput.value = '';
  imagePreview.classList.add('hidden');
  previewImg.src = '';
};

// ─── Send ───
sendBtn.onclick = sendMessage;
chatInput.onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
};

async function sendMessage() {
  const msg = chatInput.value.trim();
  if (!msg || sending || !currentChar) return;
  chatInput.value = '';
  sending = true;
  sendBtn.disabled = true;

  const hasImage = !!imageData;
  if (hasImage) {
    imageData = null;
    imageInput.value = '';
    imagePreview.classList.add('hidden');
    previewImg.src = '';
  }

  const userMsg = { role: 'user', content: msg, _id: uid() };
  history.push(userMsg);
  addMessage('user', msg, userMsg._id, false);

  const sendHistory = buildSendHistory(history.length - 1);
  const assistId = uid();
  addMessage('assistant', '', assistId, false);
  const assistEntry = { role: 'assistant', content: '', _id: assistId, _versions: [], _currentVersion: 0 };
  history.push(assistEntry);

  const body = makeSendBody(msg, sendHistory, hasImage);
  const full = await streamResponse(assistId, body);

  sending = false;
  sendBtn.disabled = false;
  assistEntry.content = full;
  assistEntry._versions = [full];
  assistEntry._currentVersion = 0;
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
  upsertChat({
    id: currentChatId,
    character: currentChar,
    title: firstUser ? firstUser.content.slice(0, 60) : 'Chat',
    messages: history,
    updated_at: new Date().toISOString(),
  });
}

resetBtn.onclick = () => {
  if (currentChatId) deleteChat(currentChatId);
  if (currentChar) selectCharacter(currentChar);
};

$('newChatBtn').onclick = () => {
  currentChatId = null;
  history = [];
  messagesEl.innerHTML = '';
  emptyState.classList.add('hidden');
  inputArea.classList.remove('hidden');
  if (currentChar) selectCharacter(currentChar);
};

$('historyBtn').onclick = () => $('historyArea').classList.remove('hidden');
$('closeHistoryBtn').onclick = () => $('historyArea').classList.add('hidden');

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
  history = (chat.messages || []).map(m => ({
    ...m,
    _versions: m._versions || [m.content],
    _currentVersion: m._currentVersion || 0,
    _id: m._id || uid(),
    _greeting: m._greeting || false,
  }));
  messagesEl.innerHTML = '';
  emptyState.classList.add('hidden');
  inputArea.classList.remove('hidden');
  charPicker.classList.add('hidden');

  const char = characters[chat.character];
  if (char) {
    charName.textContent = char.name;
    charGreeting.textContent = char.greeting || '';
    chatCharAvatar.innerHTML = (char.avatar && (char.avatar.startsWith('/') || char.avatar.startsWith('../')))
      ? `<img src="${char.avatar}" alt="${escapeHtml(char.name)}">` : '';
  }
  renderMessages();
  renderSidebar();
  renderCharGrid();
  renderHistoryPanel();
}

initCharacters();
renderSidebar();
renderCharGrid();
