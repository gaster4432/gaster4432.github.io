// ═══════════════════════════════════════════
//  SET YOUR WORKER URL HERE
// ═══════════════════════════════════════════
const WORKER_URL = 'https://lucky-band-5c81.archlinuxkid99.workers.dev';

// ─── State ───
let characters = {};
let currentChar = null;
let currentChatId = null;
let history = [];
let sending = false;

// ─── DOM ───
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

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Storage ───
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

// ─── Characters ───
function initCharacters() {
  const stored = localStorage.getItem('cf_chat_custom_chars');
  const custom = stored ? JSON.parse(stored) : {};
  characters = { ...DEFAULT_CHARACTERS, ...custom };
}

function saveCustomCharacters() {
  const defaults = Object.keys(DEFAULT_CHARACTERS);
  const custom = {};
  for (const [k, v] of Object.entries(characters)) {
    if (!defaults.includes(k)) custom[k] = v;
  }
  localStorage.setItem('cf_chat_custom_chars', JSON.stringify(custom));
}

// ─── UI: Sidebar ───
function renderSidebar() {
  charSidebarList.innerHTML = '';
  for (const [k, v] of Object.entries(characters)) {
    const recent = getMostRecentChat(k);
    const item = document.createElement('div');
    item.className = 'sidebar-char' + (k === currentChar ? ' active' : '');
    const hasAvatar = v.avatar && v.avatar.startsWith('/');
    const lastMsg = recent ? recent.title || 'Chat' : '';
    item.innerHTML = `<div class="sidebar-char-avatar">${hasAvatar ? `<img src="${v.avatar}">` : ''}</div>
      <div class="sidebar-char-text">
        <span class="sidebar-char-name">${escapeHtml(v.name)}</span>
        ${lastMsg ? `<span class="sidebar-char-last">${escapeHtml(lastMsg.slice(0, 30))}</span>` : ''}
      </div>`;
    item.onclick = () => selectCharacter(k);
    charSidebarList.appendChild(item);
  }
}

// ─── UI: Character Grid ───
function renderCharGrid() {
  characterGrid.innerHTML = '';
  const q = (characterSearch?.value || '').toLowerCase();
  for (const [k, v] of Object.entries(characters)) {
    if (q && !v.name.toLowerCase().includes(q)) continue;
    const c = document.createElement('div');
    c.className = 'char-card' + (k === currentChar ? ' active' : '');
    const hasAvatar = v.avatar && v.avatar.startsWith('/');
    c.innerHTML = `<div class="char-card-avatar">${hasAvatar ? `<img src="${v.avatar}" loading="lazy">` : ''}</div>
      <div class="char-card-name">${escapeHtml(v.name)}</div>`;
    c.onclick = () => selectCharacter(k);
    characterGrid.appendChild(c);
  }
}

characterSearch.addEventListener('input', renderCharGrid);

// ─── Select Character ───
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
    const hasAvatar = char.avatar && char.avatar.startsWith('/');
    chatCharAvatar.innerHTML = hasAvatar ? `<img src="${char.avatar}" alt="${escapeHtml(char.name)}">` : '';
    if (char.greeting) {
      addMsg('assistant', char.greeting);
      history.push({ role: 'assistant', content: char.greeting });
    }
  }
  renderSidebar();
  renderCharGrid();
  renderHistoryPanel();
}

// ─── Messages ───
function addMsg(role, content, extraClass = '') {
  const div = document.createElement('div');
  div.className = `msg ${role}${extraClass ? ' ' + extraClass : ''}`;
  div.textContent = content;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

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

  addMsg('user', msg);
  history.push({ role: 'user', content: msg });

  const char = characters[currentChar];
  const streamDiv = addMsg('assistant', '', 'streaming');

  const sendHistory = history.filter(m => {
    if (char && m.role === 'assistant' && m.content === char.greeting) return false;
    return true;
  });

  try {
    const res = await fetch(`${WORKER_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: msg,
        character: {
          name: char.name,
          greeting: char.greeting || '',
          systemPrompt: char.systemPrompt || '',
        },
        history: sendHistory,
      }),
    });

    if (!res.ok) {
      streamDiv.remove();
      addMsg('system', 'Request failed');
      sending = false;
      sendBtn.disabled = false;
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      const lines = text.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        try {
          const chunk = JSON.parse(payload);
          if (chunk.content) {
            full += chunk.content;
            streamDiv.textContent = full;
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
          if (chunk.error) {
            streamDiv.remove();
            addMsg('system', 'Error: ' + chunk.error);
          }
        } catch {}
      }
    }

    streamDiv.classList.remove('streaming');
    if (full) {
      streamDiv.className = 'msg assistant';
      history.push({ role: 'assistant', content: full });

      if (!currentChatId) currentChatId = crypto.randomUUID();
      upsertChat({
        id: currentChatId,
        character: currentChar,
        title: msg.slice(0, 60),
        messages: history,
        updated_at: new Date().toISOString(),
      });
      renderSidebar();
      renderHistoryPanel();
    } else {
      streamDiv.remove();
    }
  } catch (e) {
    streamDiv.remove();
    addMsg('system', 'Error: ' + e.message);
  }

  sending = false;
  sendBtn.disabled = false;
}

// ─── Reset ───
resetBtn.onclick = () => {
  if (currentChatId) deleteChat(currentChatId);
  if (currentChar) selectCharacter(currentChar);
};

$('newChatBtn').onclick = () => {
  if (currentChar) selectCharacter(currentChar);
};

// ─── History ───
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
  history = chat.messages || [];
  messagesEl.innerHTML = '';
  emptyState.classList.add('hidden');
  inputArea.classList.remove('hidden');
  charPicker.classList.add('hidden');

  const char = characters[chat.character];
  if (char) {
    charName.textContent = char.name;
    charGreeting.textContent = char.greeting || '';
    const hasAvatar = char.avatar && char.avatar.startsWith('/');
    chatCharAvatar.innerHTML = hasAvatar ? `<img src="${char.avatar}" alt="${escapeHtml(char.name)}">` : '';
  }
  for (const m of history) {
    addMsg(m.role, m.content);
  }
  renderSidebar();
  renderCharGrid();
  renderHistoryPanel();
}

// ─── Init ───
initCharacters();
renderSidebar();
renderCharGrid();
