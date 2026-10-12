/* ============================================================
   memory.js —— 会话记忆（localStorage）
   支持多会话切换、清空、导出。
   ============================================================ */

const K_SESSIONS = 'psychics.sessions.v1';
const K_CURRENT = 'psychics.current_session.v1';

export function listSessions() {
  try {
    const raw = localStorage.getItem(K_SESSIONS);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function currentSessionId() {
  return localStorage.getItem(K_CURRENT) || '';
}

export function ensureSession() {
  let id = currentSessionId();
  const sessions = listSessions();
  if (id && sessions.find(s => s.id === id)) return id;

  id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const session = {
    id,
    title: '新对话',
    createdAt: new Date().toISOString(),
    messages: [],
  };
  sessions.unshift(session);
  localStorage.setItem(K_SESSIONS, JSON.stringify(sessions));
  localStorage.setItem(K_CURRENT, id);
  return id;
}

export function getSession(id) {
  const sessions = listSessions();
  return sessions.find(s => s.id === (id || currentSessionId()));
}

export function setCurrentSession(id) {
  localStorage.setItem(K_CURRENT, id);
}

export function appendMessage(msg) {
  const sid = ensureSession();
  const sessions = listSessions();
  const s = sessions.find(x => x.id === sid);
  if (!s) return;
  s.messages.push({ role: msg.role, content: msg.content, at: new Date().toISOString() });
  // 自动更新标题
  if (s.messages.length <= 2 && s.messages[0].role === 'user') {
    s.title = (s.messages[0].content || '').slice(0, 30) || s.title;
  }
  localStorage.setItem(K_SESSIONS, JSON.stringify(sessions));
}

export function loadHistory() {
  const s = getSession();
  return s ? s.messages.map(m => ({ role: m.role, content: m.content })) : [];
}

export function clearCurrent() {
  localStorage.removeItem(K_CURRENT);
  localStorage.setItem(K_SESSIONS, '[]');
}

export function deleteSession(id) {
  const sessions = listSessions().filter(s => s.id !== id);
  localStorage.setItem(K_SESSIONS, JSON.stringify(sessions));
  if (currentSessionId() === id) localStorage.removeItem(K_CURRENT);
}

export function renameSession(id, title) {
  const sessions = listSessions();
  const s = sessions.find(x => x.id === id);
  if (s) { s.title = title; localStorage.setItem(K_SESSIONS, JSON.stringify(sessions)); }
}

export function exportAll() {
  return {
    exportedAt: new Date().toISOString(),
    sessions: listSessions(),
  };
}
