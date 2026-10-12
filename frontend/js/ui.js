/* ============================================================
   ui.js —— 对话界面渲染
   ============================================================ */

const messagesEl = () => document.getElementById('messages');
const routeBadgeEl = () => document.getElementById('route-badge');
const inputEl = () => document.getElementById('input');
const sendBtnEl = () => document.getElementById('btn-send');
const micBtnEl = () => document.getElementById('btn-mic');
const chkTtsEl = () => document.getElementById('chk-tts');
const statusChipEl = () => document.getElementById('llm-status');
const dlgEl = () => document.getElementById('dlg-settings');
const settingsBtnEl = () => document.getElementById('btn-settings');

export function renderUser(text) {
  const el = messagesEl();
  const m = document.createElement('div');
  m.className = 'msg user';
  m.innerHTML = `
    <div class="body">
      <div class="bubble"></div>
      <div class="meta">${now()}</div>
    </div>
    <div class="avatar">U</div>
  `;
  m.querySelector('.bubble').textContent = text;
  el.appendChild(m);
  scrollBottom();
  return m;
}

/** 创建 agent 消息气泡（先创建空 bubble，后续通过 append 填充） */
export function renderAgentShell({ agentName = 'Psychics', role = 'agent' }) {
  const el = messagesEl();
  const m = document.createElement('div');
  m.className = 'msg';
  m.innerHTML = `
    <div class="avatar">${initialOf(agentName)}</div>
    <div class="body">
      <div class="bubble"></div>
      <div class="meta">${agentName} · ${now()}</div>
      <div class="actions"></div>
    </div>
  `;
  el.appendChild(m);
  scrollBottom();
  return {
    bubble: m.querySelector('.bubble'),
    meta: m.querySelector('.meta'),
    actions: m.querySelector('.actions'),
    node: m,
  };
}

export function appendToBubble(shell, text) {
  shell.bubble.textContent += text;
  scrollBottom();
}

export function finalizeBubble(shell, meta) {
  if (meta?.routedTo) {
    shell.meta.textContent += ` · routed → ${meta.routedTo}`;
  }
}

/** 为每条 agent 消息加"朗读"按钮 */
export function addSpeakButton(shell, text) {
  const btn = document.createElement('button');
  btn.className = 'btn-small';
  btn.textContent = '🔊 朗读';
  btn.onclick = () => onSpeakClick(btn, text);
  shell.actions.appendChild(btn);
}

export function addRegenerateButton(shell, getText) {
  const btn = document.createElement('button');
  btn.className = 'btn-small';
  btn.textContent = '↻ 重问';
  btn.onclick = () => {
    const t = typeof getText === 'function' ? getText() : getText;
    if (t) sendMessage(t);
  };
  shell.actions.appendChild(btn);
}

export function showRouteBadge(decision) {
  const el = routeBadgeEl();
  if (!decision) { el.classList.add('hidden'); return; }
  const parts = [];
  if (decision.intent) parts.push(`intent=${decision.intent}`);
  if (decision.school_ids?.length) parts.push(`school=${decision.school_ids.join(',')}`);
  if (decision.psychologist_ids?.length) parts.push(`psy=${decision.psychologist_ids.join(',')}`);
  if (decision.reason) parts.push(`— ${decision.reason}`);
  el.textContent = '路由：' + parts.join(' · ');
  el.classList.remove('hidden');
}

export function hideRouteBadge() { routeBadgeEl().classList.add('hidden'); }

export function setStatus(text, ok = false) {
  const el = statusChipEl();
  el.textContent = text;
  el.className = 'status-chip' + (ok ? ' ok' : '');
}

export function setSending(disabled) {
  // 豆包式交互：输入框和麦克风永远可用，只有发送按钮根据 busy 切换形态
  sendBtnEl().disabled = disabled;
  toggleStopMode(disabled);
}

/** 切换发送按钮的形态（发送 ⇄ 停止） */
export function setStopMode(on) {
  toggleStopMode(!!on);
}

function toggleStopMode(on) {
  const btn = sendBtnEl();
  const iconSend = document.getElementById('icon-send');
  const iconStop = document.getElementById('icon-stop');
  if (on) {
    btn.classList.add('is-stop');
    btn.classList.remove('primary');
    btn.title = '停止生成';
    iconSend?.setAttribute('hidden', '');
    iconStop?.removeAttribute('hidden');
  } else {
    btn.classList.remove('is-stop');
    btn.classList.add('primary');
    btn.title = '发送';
    iconSend?.removeAttribute('hidden');
    iconStop?.setAttribute('hidden', '');
  }
}

/** 显示/隐藏队列指示器 */
export function showQueue(n) {
  const el = document.getElementById('queue-chip');
  if (!el) return;
  if (n <= 0) { el.classList.add('hidden'); return; }
  el.textContent = `⚡ 队列 ${n} 条`;
  el.classList.remove('hidden');
}

/** 追加"⏹ 已停止"标签到 bubble（放在 bubble 之后、actions 之前） */
export function markStopped(shell) {
  const tag = document.createElement('div');
  tag.className = 'stop-marker';
  tag.textContent = '⏹ 已停止';
  const body = shell.node.querySelector('.body');
  if (!body) return;
  const actions = body.querySelector('.actions');
  if (actions) body.insertBefore(tag, actions);
  else body.appendChild(tag);
  scrollBottom();
}

export function toggleTts(enabled) { chkTtsEl().checked = enabled; }
export function isTtsOn() { return chkTtsEl().checked; }

/* ------------------------------------------------------------ */

function now() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function initialOf(name) {
  const s = String(name || '?').trim();
  return (s[0] || '?').toUpperCase();
}

function scrollBottom() {
  const el = messagesEl();
  el.scrollTop = el.scrollHeight;
}

let _speakHandler = null;
export function setSpeakHandler(fn) { _speakHandler = fn; }

async function onSpeakClick(btn, text) {
  if (!_speakHandler) return;
  if (btn.dataset.playing === '1') {
    await _speakHandler({ stop: true });
    btn.dataset.playing = '0';
    btn.textContent = '🔊 朗读';
    return;
  }
  btn.dataset.playing = '1';
  btn.textContent = '⏹ 停止';
  await _speakHandler({ text });
}
