/* ============================================================
   hlt.js —— Human-in-the-Loop 交接协议
   ------------------------------------------------------------
   当某个专家 agent 判定"问题不在我的擅长领域"时：
   1. agent 会在回复末尾追加机器可读标记（见 HLT_PROMPT_TAIL）
   2. main.js 检测到标记后调用 renderHandoffCard() 弹出候选卡
   3. 用户同意 → 前端调度 lockToAgent + 自动重发原问题
      用户拒绝 → 卡片折叠为"知道了"，当前 agent 继续服务

   HLT marker 格式（agent 需自行输出，独占一行）：
     HANDOFF: PSY007
     HANDOFF: PSY007,PSY008
     HANDOFF: SCH03
     HANDOFF: PSY007 | PSY008   (两种分隔都可)

   设计取舍：
   - 不引入额外 LLM 调用，避免延迟
   - Marker 由 agent 显式输出，前端确定性解析
   - 用户是最终决策者，agent 无权直接切换
   ============================================================ */

import { psychologistById, schoolById } from './ontology.js';

/* ------------------------------------------------------------ */
/* Prompt 尾注：注入到 agent 的 systemPrompt 末尾 */
/* ------------------------------------------------------------ */
export const HLT_PROMPT_TAIL = `

【HLT 交接协议 —— 严格遵守】
若用户的提问**明显超出**你的专业领域（例如精神分析师被问 CBT 实操），你须遵循：
1) 用 1-3 句温和说明"这不是我最擅长的方向"；
2) 推荐 1-3 位更合适的心理学家或学派，用中文名/学派名直接点出；
3) 用自然语言询问用户："如果你愿意，可以请 TA 来回应；也可以继续由我陪你聊。"
4) 在整段回复的**最末尾**独占一行输出机器可读标记（UI 会自动剥离，用户看不到）：
   HANDOFF: PSY007
   或 HANDOFF: PSY007,PSY008
   或 HANDOFF: SCH03

补充规则：
- HANDOFF 行**必须**是最后一行，前面保留一个空行；
- 编号必须来自下方"知识快照"中真实存在的 PSY/SCH 条目，禁止编造；
- 若问题只是稍远但仍在你能力内，不要触发 HLT，正常作答即可；
- 危机干预（自伤/自杀/急性情绪）**不要**走 HLT，先做安全提示与热线建议。
`;

/* ------------------------------------------------------------ */
/* Marker 解析与剥离 */
/* ------------------------------------------------------------ */

const HANDOFF_RE = /\n\s*HANDOFF\s*:\s*([^\n\r]+)/i;

/**
 * 从 agent 回复中检测并剥离 HLT 标记。
 * @param {string} text agent 完整回复
 * @returns {{display:string, ids:string[]|null}}
 */
export function detectAndStrip(text) {
  const s = String(text ?? '');
  const m = s.match(HANDOFF_RE);
  if (!m) return { display: s, ids: null };
  const ids = parseIds(m[1]);
  const display = s.slice(0, m.index).replace(/\s+$/, '');
  return { display, ids: ids.length ? ids : null };
}

/** 从字符串中提取所有 PSY/SCH 编号 */
export function parseIds(str) {
  return String(str ?? '')
    .split(/[\s,，、|;；/]+/)
    .map(x => x.trim().toUpperCase())
    .filter(x => /^PSY\d+$/.test(x) || /^SCH\d+$/.test(x));
}

/* ------------------------------------------------------------ */
/* 候选对象构造 */
/* ------------------------------------------------------------ */

/**
 * 把编号列表转成卡片需要的候选对象数组
 * @param {string[]} ids PSY/SCH 编号
 * @param {object|null} selfAgent 当前说话 agent（用于去重）
 */
export function buildCandidates(ids, selfAgent) {
  const map = new Map();
  for (const id of ids || []) {
    if (!id) continue;
    const kind = id.startsWith('PSY') ? 'psych' : 'school';
    const agentId = `${kind}.${id}`;
    // 排除自己
    if (selfAgent?.id === agentId) continue;
    if (map.has(id)) continue;
    const c = toCandidate(id, kind);
    if (c) map.set(id, c);
  }
  const list = [...map.values()];
  list.sort((a, b) => (a.kind === b.kind ? 0 : (a.kind === 'psych' ? -1 : 1)));
  return list.slice(0, 3);
}

function toCandidate(id, kind) {
  const row = kind === 'psych' ? psychologistById(id) : schoolById(id);
  if (!row) return null;
  const name = row.name_zh || row.name_en || row.title_zh || row.title_en || id;
  const nameEn = row.name_en || row.title_en || '';
  const bio = (row.bio_zh || row.summary_zh || '').slice(0, 60);
  const schoolName = kind === 'psych'
    ? (row.affiliation || '').match(/SCH\d+/g)?.map(sid => {
        const s = schoolById(sid);
        return s ? (s.name_zh || s.name_en || sid) : sid;
      }).join(' · ') || ''
    : (row.aliases || '').slice(0, 40);
  return {
    id,
    kind,
    agentId: `${kind}.${id}`,
    name,
    nameEn,
    bio,
    schoolName,
  };
}

/* ------------------------------------------------------------ */
/* UI：渲染交接卡 */
/* ------------------------------------------------------------ */

/**
 * 在对话流里渲染 HLT 交接卡。
 * @param {object} opts
 * @param {string} opts.currentAgentName  当前 agent 的显示名
 * @param {string[]} opts.ids              agent 声明的候选编号
 * @param {function} opts.onSwitchTo       (agentId) => void
 * @param {function} opts.onDismiss        () => void
 * @returns {{node:HTMLElement, card:HTMLElement}}
 */
export function renderHandoffCard({ currentAgentName, ids, onSwitchTo, onDismiss }) {
  const cands = buildCandidates(ids, null);
  const parent = document.querySelector('#messages');
  if (!parent) return { node: null, card: null };

  const m = document.createElement('div');
  m.className = 'msg msg-handoff';

  const avatar = document.createElement('div');
  avatar.className = 'avatar avatar-handoff';
  avatar.textContent = '🤝';

  const bc = document.createElement('div');
  bc.className = 'body';

  const wrap = document.createElement('div');
  wrap.className = 'bubble bubble-handoff';

  const body = document.createElement('div');
  body.className = 'handoff-card';

  const head = document.createElement('div');
  head.className = 'hl-head';
  head.innerHTML =
    '<span class="hl-head-title">🔀 交接询问 · Human-in-the-Loop</span>' +
    '<span class="hl-head-sub">由你决定</span>';
  body.appendChild(head);

  const prompt = document.createElement('div');
  prompt.className = 'hl-prompt';
  const candSummary = cands.length
    ? `我识别到 <b>${cands.length}</b> 位更合适的候选，你可以直接切换：`
    : '我暂时没识别到明确的候选，你可以换个问法，或让 TA 继续尝试。';
  prompt.innerHTML =
    `<div class="hl-prompt-line">` +
      `<span class="hl-quote-mark">"</span>` +
      `<span>${escapeXml(currentAgentName || '当前专家')}</span>` +
      `<span>说这不是 TA 的专长——</span>` +
    `</div>` +
    `<div class="hl-prompt-line hl-prompt-line-2">${candSummary}</div>`;
  body.appendChild(prompt);

  const list = document.createElement('div');
  list.className = 'hl-cands';
  if (cands.length) {
    cands.forEach((c) => {
      const el = document.createElement('div');
      el.className = 'hl-cand';
      const initial = (c.name[0] || '?').toUpperCase();
      const tag = c.kind === 'psych' ? '人物' : '学派';
      el.innerHTML =
        `<div class="hl-cand-avatar">${escapeXml(initial)}</div>` +
        `<div class="hl-cand-main">` +
          `<div class="hl-cand-name">${escapeXml(c.name)}` +
            `${c.nameEn ? ` <span class="hl-cand-en">${escapeXml(c.nameEn)}</span>` : ''}` +
          `</div>` +
          `<div class="hl-cand-sub">${escapeXml(c.schoolName || c.bio || c.id)}</div>` +
        `</div>` +
        `<span class="hl-cand-tag">${tag}</span>`;
      el.onclick = () => {
        if (el.dataset.done) return;
        el.dataset.done = '1';
        el.classList.add('picked');
        onSwitchTo?.(c.agentId);
      };
      list.appendChild(el);
    });
  } else {
    list.innerHTML = '<div class="hl-empty">暂无自动推荐的候选人。</div>';
  }
  body.appendChild(list);

  const actions = document.createElement('div');
  actions.className = 'hl-actions';
  const btnSwitch = document.createElement('button');
  btnSwitch.className = 'btn-small hl-btn hl-btn-primary';
  btnSwitch.textContent = '🎯 切换到首推并追问';
  btnSwitch.title = '切换到首位推荐并自动重发原问题';
  btnSwitch.onclick = () => {
    if (cands.length) onSwitchTo?.(cands[0].agentId);
  };
  const btnKeep = document.createElement('button');
  btnKeep.className = 'btn-small hl-btn hl-btn-ghost';
  btnKeep.textContent = '🙏 我自己来';
  btnKeep.title = '关闭提示，由当前 agent 继续';
  btnKeep.onclick = () => {
    onDismiss?.();
    card.classList.add('dismissed');
  };
  actions.appendChild(btnSwitch);
  actions.appendChild(btnKeep);
  body.appendChild(actions);

  wrap.appendChild(body);
  const meta = document.createElement('div');
  meta.className = 'meta';
  const ts = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  meta.textContent = `知微 · 交接建议 · ${ts}`;
  bc.appendChild(wrap);
  bc.appendChild(meta);

  m.appendChild(avatar);
  m.appendChild(bc);
  parent.appendChild(m);
  parent.scrollTop = parent.scrollHeight;

  return { node: m, card: body };
}

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
