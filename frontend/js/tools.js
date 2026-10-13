/* ============================================================
   tools.js —— 咨询场景工具：多专家会诊 / CBT 工作表 / 心理测评
   入口：.cq-item[data-mode=...] 按钮触发，走 dialog 弹窗
   ============================================================ */

import { chat } from './llm.js';
import { isLlmConfigured } from './config.js';
import { listPsychologists, psychologistById, getCrisisHelplines } from './ontology.js';

/* ============================================================
   通用：dialog 弹窗工具
   ============================================================ */
function openDialog(id) {
  const dlg = document.getElementById(id);
  if (!dlg) { console.warn('[tools] dialog not found:', id); return null; }
  dlg.setAttribute('open', '');
  return dlg;
}
function closeDialog(id) {
  const dlg = document.getElementById(id);
  if (!dlg) return;
  dlg.removeAttribute('open');
  dlg.close?.();
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function renderMdLite(text) {
  // 极简单行 markdown：换行 + **加粗** + `code`
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

/* ============================================================
   1. 多专家会诊（Panel Consult）
   ============================================================ */

const CONSULT_MAX = 4;
const CONSULT_MIN = 2;

export async function openPanelConsult() {
  if (!isLlmConfigured(cfgHolder().cfg)) {
    alert('请先在右上角"设置"里配置 LLM。');
    return;
  }
  const dlg = openDialog('dlg-panel-consult');
  if (!dlg) return;

  // 渲染候选专家列表：默认随机 8 个心理学家
  const psychs = listPsychologists();
  // 优先按出生年份倒序打乱，让每次不同
  const shuffled = [...psychs].sort(() => Math.random() - 0.5).slice(0, 10);
  const listEl = document.getElementById('pc-list');
  if (listEl) {
    listEl.innerHTML = shuffled.map(p => `
      <label class="pc-opt" data-id="${p.id}">
        <input type="checkbox" value="${escapeHtml(p.id)}">
        <div class="pc-opt-body">
          <div class="pc-opt-name">${escapeHtml(p.name_zh || p.name_en || p.id)}</div>
          <div class="pc-opt-sub">${p.birth_year || ''}${p.death_year ? '–' + p.death_year : ''}${p.affiliation ? ' · ' + escapeHtml(p.affiliation) : ''}</div>
        </div>
      </label>
    `).join('');
    bindPcListChange();
  }

  // 问题输入
  const inputEl = document.getElementById('pc-question');
  if (inputEl) inputEl.value = '';
  document.getElementById('pc-count').textContent = `${CONSULT_MIN}-${CONSULT_MAX} 位专家`;
}

/** pc-list 每次渲染后绑定 checkbox 变化，同步 pc-count */
function bindPcListChange() {
  const list = document.getElementById('pc-list');
  if (!list || list.dataset._bound) return;
  list.dataset._bound = '1';
  list.addEventListener('change', () => {
    const n = list.querySelectorAll('input:checked').length;
    const el = document.getElementById('pc-count');
    if (!el) return;
    el.textContent = `${n}/${CONSULT_MAX} 位专家`;
    el.classList.toggle('warn', n > CONSULT_MAX || (n > 0 && n < CONSULT_MIN));
    el.classList.toggle('ok', n >= CONSULT_MIN && n <= CONSULT_MAX);
  });
}

async function runPanelConsult() {
  const q = document.getElementById('pc-question')?.value?.trim();
  if (!q) { alert('请描述你希望专家们讨论的问题'); return; }

  const checked = document.querySelectorAll('.pc-opt input:checked');
  const ids = Array.from(checked).map(c => c.value);
  if (ids.length < CONSULT_MIN) { alert(`至少选择 ${CONSULT_MIN} 位专家`); return; }
  if (ids.length > CONSULT_MAX) { alert(`最多选择 ${CONSULT_MAX} 位专家`); return; }

  const statusEl = document.getElementById('pc-status');
  statusEl.style.display = 'flex';
  document.getElementById('pc-run-btn').disabled = true;

  const experts = ids.map(id => psychologistById(id)).filter(Boolean);

  let ctx;
  try {
    ctx = await openPanelResults(q, experts);
  } catch (err) {
    appendStatusText(`打开结果面板失败：${err.message}`);
    document.getElementById('pc-run-btn').disabled = false;
    return;
  }
  const { cfg, signal, appendText, appendRound, appendReflexion, finalize, setStatus } = ctx;

  try {
    // === Round 1：并行开题 ===
    setStatus('① 开题中——每位专家独立作答…');
    const results1 = await runRound1(q, experts, { cfg, signal, appendText });

    // === Round 2：顺序交锋（每位专家逐位回应前一位的具体论点）===
    setStatus('② 交锋中——每位专家须正面回应前一位的论点…');
    await runRound2(q, experts, results1, { cfg, signal, appendRound });

    // === Round 3：独立反思（先出，让主持人看到批评）===
    setStatus('③ 反思中——独立第三方审视辩论过程…');
    const reflText = await runReflexion(q, experts, results1, { cfg, signal });
    appendReflexion(reflText);

    // === 综合点评（输入 = 开题 + 交锋 + 反思）===
    setStatus('④ 综合中——主持人汇总各方观点…');
    await finalize(results1, { reflexion: reflText });
  } catch (err) {
    if (err?.name === 'AbortError') return;
    appendStatusText(`会诊出错：${err.message}`);
  } finally {
    document.getElementById('pc-run-btn').disabled = false;
  }
}

function appendStatusText(msg) {
  const el = document.getElementById('pc-status');
  if (el) el.textContent = msg;
}

/** 通用：一次 chat 调用，失败返回 null */
async function callLLM({ cfg, messages, temperature, maxTokens, signal }) {
  try {
    const r = await chat({ cfg, messages, temperature, maxTokens: maxTokens || 1500, signal });
    return r?.content || '';
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    return null;
  }
}

/* -------- Round 1：并行开题 -------- */
async function runRound1(q, experts, { cfg, signal, appendText }) {
  const tasks = experts.map(async (expert, idx) => {
    const t0 = performance.now();
    const content = await callLLM({
      cfg,
      messages: buildOpenPrompt(expert, q),
      temperature: 0.7,
      maxTokens: 1500,
      signal,
    });
    return {
      idx, expert,
      content: content || '',
      ok: content != null,
      err: content == null ? 'LLM 调用失败' : '',
      ms: performance.now() - t0,
      round: 1,
    };
  });
  const results = await Promise.all(tasks);
  // 按专家索引顺序渲染，保证阅读顺序 = 后续交锋的引用顺序
  results.sort((a, b) => a.idx - b.idx).forEach(r => appendText(r));
  return results;
}

/* -------- Round 2：顺序交锋 -------- */
async function runRound2(q, experts, prevResults, { cfg, signal, appendRound }) {
  // 前一位专家的完整发言（供本轮引用）
  const prevSpokes = prevResults
    .map(r => ({ name: r.expert.name_zh || r.expert.name_en, text: r.content }))
    .filter(s => s.text);

  for (let i = 1; i < experts.length; i++) {
    const prev = prevSpokes[i - 1];
    if (!prev) continue;
    const t0 = performance.now();
    const content = await callLLM({
      cfg,
      messages: buildRebuttalPrompt(experts[i], q, prev),
      temperature: 0.7,
      maxTokens: 1200,
      signal,
    });
    appendRound({
      idx: i, expert: experts[i],
      content: content || '',
      ok: content != null,
      err: content == null ? 'LLM 调用失败' : '',
      ms: performance.now() - t0,
      round: 2,
      quoteFrom: prev.name,
    });
  }
}

/* -------- Round 3：独立反思 -------- */
async function runReflexion(q, experts, round1Results, { cfg, signal }) {
  const transcript = round1Results.map(r => {
    const n = r.expert.name_zh || r.expert.name_en;
    return `【${n}】\n${r.content}`;
  }).join('\n\n---\n\n');
  const names = experts.map(e => e.name_zh || e.name_en).join('、');

  const system = `你是一位**独立方法学批评者**，身份不属于本场任何专家，也没有学派归属。
你不是任何一位参与者的代言人，也不是他们的盟友。

【你的任务】
对下面这场辩论做一次**结构化反思**（不是评价谁对谁错，而是揭示思维盲区）：

1. **证据缺口**：哪些论断没有引用可验证的研究/临床数据/文献？
2. **隐含假设**：每位专家在哪些点上是"默认成立"但需要辩护的？
3. **立场漂移**：有没有专家在辩论中悄悄偏离了自己学派的经典立场？
4. **视角遗漏**：面对此议题，还应有哪个学派/视角介入但缺席了？
5. **可执行建议**：给出 1-2 条对下一步行动有帮助的具体建议。

【约束】
- 保持中立、可反驳、可复现，不用"作为AI"这类元话术
- 每条批评都指名道姓（"X 在 Y 点上…"），不做泛泛而谈
- 400-700 字，直接给结论
- 不代替专家下最终结论`;

  const user = `议题：${q}

与会专家：${names}

完整辩论记录：
${transcript}`;

  return await callLLM({
    cfg,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.4,
    maxTokens: 1500,
    signal,
  }) || '';
}

/* -------- Prompt 构造 -------- */
function expertBioBlock(expert) {
  const range = expert.range || expert.affiliation || '';
  const bio = expert.bio_zh || expert.bio || '';
  const theories = (expert.theories || []).slice(0, 5).join('、');
  const works = (expert.works || []).slice(0, 3).join('、');
  return `【你的身份档案】
- 出生：${expert.birth_year || '—'} ${expert.death_year ? '· 逝世：' + expert.death_year : ''}
- 学派归属：${range}
- 主要理论：${theories || '（参考本体记录）'}
- 代表作：${works || '（参考本体记录）'}
${bio ? '- 生平摘要：' + bio.slice(0, 400) : ''}`;
}

function buildOpenPrompt(expert, question) {
  const name = expert.name_zh || expert.name_en;
  const system = `你是心理学者 ${name}，正在参与一场**多专家会诊**的第一轮开题。
你的立场必须严格代表${name}本人的理论视角与临床传统。

${expertBioBlock(expert)}

【本轮任务】
从你的学派视角独立作答，不参考其他专家（此刻你看不到其他人的观点）。给出：
- 你对议题的**核心诊断/假设**
- 支撑这一判断的**至少 1 条可引用的理论或研究线索**（可写理论名，不要编造具体年份/编号）
- 一条**建议的介入方向**

【格式约束】
- 250-400 字，直接以"${name}"的口吻作答，第一人称"我"
- 结尾给一个具体可执行的建议或反问
- 遇到超出你学派的问题，坦率承认并指出该找哪个流派的学者
- 不做医学诊断；不做跨学派综合（那是主持人做的事）
- 绝不输出"作为AI"或"作为${name}"这类元话术——你**就是** ${name}。`;

  const user = `会诊议题：${question}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function buildRebuttalPrompt(expert, question, prevSpoke) {
  const name = expert.name_zh || expert.name_en;
  const system = `你是心理学者 ${name}，正在参与**多专家会诊**的第二轮交锋。
你必须严格代表${name}本人的理论视角与临床传统。

${expertBioBlock(expert)}

【本轮任务】
上一位发言者是 **${prevSpoke.name}**。你必须做三件事：
1. **点名引用** TA 发言中的**至少一句具体观点**（用引号引用原话）
2. 从你的学派立场**正面回应**这句观点——可以补充、可以质疑、也可以指出其盲区
3. **补上一条新的论据**（不能与你的开题重复）

【约束】
- 300-500 字，第一人称"我"
- 严禁"综合双方""作为AI"等中性话术——你是持一方立场参与辩论
- 保持专业、不做人身攻击；不越权诊断
- 如果 ${prevSpoke.name} 的观点在方法学/证据层面站得住，请坦率承认，并把你方的补充说清楚`;

  const user = `议题：${question}

上一位（${prevSpoke.name}）的完整发言：
"""
${prevSpoke.text}
"""

请以 ${name} 的身份，正面回应 TA 的其中一句观点，并补上你方的新论据。`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** 打开结果区并返回流式回调 */
function openPanelResults(question, experts) {
  const dlg = document.getElementById('dlg-panel-consult');
  const resultsEl = document.getElementById('pc-results');
  const summaryEl = document.getElementById('pc-summary');
  const statusEl = document.getElementById('pc-status');
  const runBtn = document.getElementById('pc-run-btn');

  resultsEl.innerHTML = '';
  summaryEl.style.display = 'none';
  summaryEl.innerHTML = '';
  runBtn.style.display = 'none';

  // 顶部说明条
  const banner = document.createElement('div');
  banner.className = 'pc-round-banner';
  banner.innerHTML = '🧠 三回合流程：<b>开题 → 交锋 → 反思</b>，最后由主持人综合点评';
  resultsEl.appendChild(banner);

  const round2Holder = document.createElement('div');
  round2Holder.className = 'pc-round-holder';
  round2Holder.style.display = 'none';
  resultsEl.appendChild(round2Holder);

  const reflexionHolder = document.createElement('div');
  reflexionHolder.className = 'pc-round-holder';
  reflexionHolder.style.display = 'none';
  resultsEl.appendChild(reflexionHolder);

  // Round 1 卡片：每位专家一张
  const cards = experts.map(e => {
    const name = e.name_zh || e.name_en;
    const div = document.createElement('div');
    div.className = 'pc-result';
    div.dataset.id = e.id;
    div.innerHTML = `
      <div class="pc-result-head">
        <div class="pc-result-avatar">${escapeHtml((name[0] || '?').toUpperCase())}</div>
        <div class="pc-result-info">
          <div class="pc-result-name">${escapeHtml(name)}</div>
          <div class="pc-result-sub">${escapeHtml(e.affiliation || e.range || '')}</div>
        </div>
        <div class="pc-round-badge">开题</div>
        <div class="pc-result-status">思考中…</div>
      </div>
      <div class="pc-result-body">加载中…</div>
    `;
    resultsEl.appendChild(div);
    return div;
  });

  return {
    cfg: cfgHolder().cfg,
    signal: new AbortController().signal,
    setStatus: (msg) => { if (statusEl) { statusEl.textContent = msg; statusEl.style.display = 'flex'; } },

    appendText: (r) => {
      const card = cards[r.idx];
      if (!card) return;
      const body = card.querySelector('.pc-result-body');
      const status = card.querySelector('.pc-result-status');
      if (r.ok) {
        body.innerHTML = renderMdLite(r.content);
        status.textContent = `${(r.ms || 0).toFixed(0)}ms`;
        status.className = 'pc-result-status ok';
        card.classList.add('done');
      } else {
        body.innerHTML = `<span style="color:#b91c1c">⚠ 生成失败：${escapeHtml(r.err || '')}</span>`;
        status.textContent = '失败';
        status.className = 'pc-result-status err';
      }
    },

    appendRound: (r) => {
      if (!round2Holder) return;
      round2Holder.style.display = '';
      // 回合分组标题（只加一次）
      let label = round2Holder.querySelector('.pc-round-label');
      if (!label) {
        label = document.createElement('div');
        label.className = 'pc-round-label';
        label.innerHTML = '⚔️ <b>第二回合 · 交锋</b>（顺序发言，须正面回应前一位）';
        round2Holder.appendChild(label);
      }
      const name = r.expert.name_zh || r.expert.name_en;
      const div = document.createElement('div');
      div.className = 'pc-result pc-result-r2';
      div.dataset.idx = r.idx;
      div.innerHTML = `
        <div class="pc-result-head">
          <div class="pc-result-avatar">${escapeHtml((name[0] || '?').toUpperCase())}</div>
          <div class="pc-result-info">
            <div class="pc-result-name">${escapeHtml(name)}</div>
            <div class="pc-result-sub">${r.quoteFrom ? `回应 <b>${escapeHtml(r.quoteFrom)}</b>` : (r.expert.affiliation || '')}</div>
          </div>
          <div class="pc-round-badge r2">交锋</div>
          <div class="pc-result-status">思考中…</div>
        </div>
        <div class="pc-result-body">加载中…</div>
      `;
      round2Holder.appendChild(div);

      const body = div.querySelector('.pc-result-body');
      const status = div.querySelector('.pc-result-status');
      if (r.ok) {
        body.innerHTML = renderMdLite(r.content);
        status.textContent = `${(r.ms || 0).toFixed(0)}ms`;
        status.className = 'pc-result-status ok';
        div.classList.add('done');
      } else {
        body.innerHTML = `<span style="color:#b91c1c">⚠ 生成失败：${escapeHtml(r.err || '')}</span>`;
        status.textContent = '失败';
        status.className = 'pc-result-status err';
      }
    },

    appendReflexion: (text) => {
      if (!reflexionHolder) return;
      reflexionHolder.style.display = '';
      const div = document.createElement('div');
      div.className = 'pc-result pc-result-reflex';
      div.innerHTML = `
        <div class="pc-result-head">
          <div class="pc-result-avatar pc-avatar-reflex">✦</div>
          <div class="pc-result-info">
            <div class="pc-result-name">独立方法学批评者</div>
            <div class="pc-result-sub">不属本场任何专家 · 不代替结论</div>
          </div>
          <div class="pc-round-badge r3">反思</div>
        </div>
        <div class="pc-result-body">${text ? renderMdLite(text) : '<span style="color:#b91c1c">⚠ 反思生成失败</span>'}</div>
      `;
      reflexionHolder.appendChild(div);
    },

    finalize: async (results, opts) => {
      const okResults = results.filter(r => r.ok && r.content);
      if (okResults.length === 0) {
        summaryEl.style.display = 'block';
        summaryEl.innerHTML = '<p>⚠ 全部专家生成失败，请检查 LLM 配置或网络。</p>';
        runBtn.style.display = '';
        statusEl.style.display = 'none';
        return;
      }

      try {
        const expertText = okResults.map(r => {
          const n = r.expert.name_zh || r.expert.name_en;
          return `【${n} · 开题】\n${r.content}`;
        }).join('\n\n---\n\n');
        const refl = opts?.reflexion ? `\n\n【独立反思者】\n${opts.reflexion}` : '';

        const r = await chat({
          cfg: cfgHolder().cfg,
          messages: [
            { role: 'system', content: `你是心理会诊主持人，身份中立，不代表任何专家。

请基于**开题、交锋、独立反思**三部分材料，输出结构化综合点评：

1. **共识点**：各位专家都认同（或反思者未提出异议）的核心判断
2. **真正的分歧**：指名道姓，谁主张 A、谁主张 B，分歧所在的方法学/证据层面是什么
3. **反思者的关键提示**：把反思者指出的证据缺口/隐含假设原样带进来（不要软化）
4. **建议下一步**：1-2 条具体可执行的行动，标注来自哪位专家/反思者的哪条观点
5. **不确定性**：这场辩论没能回答清楚的问题

【约束】
- 保持中立、清晰、避免诊断式语气
- 每条结论后面用括注标注来源（例：（来自 ${okResults[0]?.expert?.name_zh || '专家A'}，或反思者指出…）
- 不输出"作为AI"或"作为主持人"这类元话术
- 回复 400-700 字` },
            { role: 'user', content: `议题：${question}\n\n=== 开题 ===\n${expertText}${refl}` },
          ],
          temperature: 0.5,
          maxTokens: 2000,
        });
        summaryEl.style.display = 'block';
        summaryEl.innerHTML = `<div class="pc-summary-title">🎯 主持人综合点评</div><div>${renderMdLite(r.content || '')}</div>`;
      } catch (err) {
        summaryEl.style.display = 'block';
        summaryEl.innerHTML = `<div class="pc-summary-title">🎯 主持人综合点评</div><p>⚠ 综合点评生成失败：${escapeHtml(err.message || '')}</p>`;
      }
      runBtn.style.display = '';
      statusEl.style.display = 'none';
    },
  };
}

/* ============================================================
   2. CBT 工作表（ABCDE）
   ============================================================ */

const ABCDE_FIELDS = [
  { id: 'A', label: '事件',   icon: '📍', hint: '发生了什么具体的事？请描述事实，不要评价。' },
  { id: 'B', label: '想法',   icon: '🧠', hint: '那一刻你脑子里冒出来的想法是什么？（自动思维）' },
  { id: 'C', label: '后果',   icon: '💥', hint: '情绪几分（0-10）？身体反应？做了什么行为？' },
  { id: 'D', label: '辩驳',   icon: '🔍', hint: '这个想法有什么证据？有什么反例？换个角度看呢？' },
  { id: 'E', label: '新效果', icon: '✨', hint: '换成辩驳后的想法，你的情绪和行为会有什么不同？' },
];

const DISTORTIONS = [
  { id: 'all_or_nothing',   label: '全或无',   desc: '事情非黑即白，没有中间地带' },
  { id: 'overgeneralize',   label: '过度概括', desc: '一件事不好 → 所有事都不好' },
  { id: 'mental_filter',    label: '心理过滤', desc: '只看到坏的，忽略好的' },
  { id: 'disqualify_good',  label: '否定积极', desc: '好事都归因于运气或巧合' },
  { id: 'jump_conclusions', label: '妄下结论', desc: '没有证据就得出糟糕结论' },
  { id: 'magnify',          label: '放大缩小', desc: '把小的放很大，把好的缩很小' },
  { id: 'emotional_reason', label: '情绪推断', desc: '我感觉糟糕 → 事情一定糟糕' },
  { id: 'shoulds',          label: '应该化',   desc: '应该/必须，不允许自己和别人犯错' },
  { id: 'labeling',         label: '贴标签',   desc: '用"我就是失败者"这类词概括自己' },
  { id: 'personalization',  label: '个人化',   desc: '别人的问题都是自己造成的' },
];

const K_CBT_SESSION = 'psychics.cbt.current.v1';

export async function openCbtWorksheet() {
  const dlg = openDialog('dlg-cbt');
  if (!dlg) return;

  // 恢复上次未完成的草稿
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(K_CBT_SESSION) || 'null'); } catch { draft = null; }

  const qEl = document.getElementById('cbt-question');
  if (qEl) qEl.value = '';
  document.getElementById('cbt-progress')?.classList.add('hidden');
  document.getElementById('cbt-steps')?.classList.add('hidden');
  document.getElementById('cbt-result')?.classList.add('hidden');
  document.getElementById('cbt-run-btn').style.display = '';

  // 无草稿 → 直接进 A 步
  // 有草稿 → 也先展示问题输入（草稿在提交后自动加载）
  if (draft) {
    document.getElementById('cbt-draft-hint')?.removeAttribute('hidden');
    document.getElementById('cbt-draft-hint').textContent = `检测到上次未完成草稿（${draft.updatedAt ? new Date(draft.updatedAt).toLocaleString('zh-CN') : ''}）。可以点"继续填写"接着填。`;
    document.getElementById('cbt-continue-btn')?.removeAttribute('hidden');
    document.getElementById('cbt-continue-btn').dataset.draft = JSON.stringify(draft);
  } else {
    document.getElementById('cbt-draft-hint')?.setAttribute('hidden', '');
    document.getElementById('cbt-continue-btn')?.setAttribute('hidden', '');
  }
}

async function startCbt() {
  if (!isLlmConfigured(cfgHolder().cfg)) {
    alert('请先在右上角"设置"里配置 LLM。');
    return;
  }
  const q = document.getElementById('cbt-question').value.trim();
  if (!q) { alert('请先描述一次让你情绪波动的事件'); return; }

  const dlg = document.getElementById('dlg-cbt');
  document.getElementById('cbt-question').parentElement.style.display = 'none';
  document.getElementById('cbt-run-btn').style.display = 'none';
  document.getElementById('cbt-draft-hint')?.setAttribute('hidden', '');
  document.getElementById('cbt-continue-btn')?.setAttribute('hidden', '');

  const progressEl = document.getElementById('cbt-progress');
  const stepsEl = document.getElementById('cbt-steps');
  progressEl.classList.remove('hidden');
  stepsEl.classList.remove('hidden');

  progressEl.innerHTML = ABCDE_FIELDS.map(f => `
    <div class="cbt-pip" data-id="${f.id}"><span>${f.id}</span></div>
  `).join('');

  const state = { answers: {}, q };
  localStorage.setItem(K_CBT_SESSION, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }));

  for (let i = 0; i < ABCDE_FIELDS.length; i++) {
    await showCbtStep(i, state, q);
    if (!state._done) return; // 用户点取消/退出
  }

  // 全部填完，出结果
  showCbtResult(state, q);
}

async function showCbtStep(idx, state, q) {
  const f = ABCDE_FIELDS[idx];
  const stepsEl = document.getElementById('cbt-steps');
  const progressEl = document.getElementById('cbt-progress');

  // 更新进度
  progressEl.querySelectorAll('.cbt-pip').forEach((pip, i) => {
    pip.classList.toggle('active', i === idx);
    pip.classList.toggle('done', i < idx);
  });

  const prevAnswers = Object.entries(state.answers)
    .filter(([k]) => ABCDE_FIELDS.find(ff => ff.id === k))
    .map(([k, v]) => `【${k} · ${ABCDE_FIELDS.find(ff => ff.id === k).label}】${v}`).join('\n');

  stepsEl.innerHTML = `
    <div class="cbt-step-head">
      <div class="cbt-step-title">${f.icon} ${f.id}. ${f.label}</div>
      <div class="cbt-step-hint">${f.hint}</div>
    </div>
    <div class="cbt-step-context">
      <div class="cbt-ctx-label">原始事件</div>
      <div class="cbt-ctx-text">${escapeHtml(q)}</div>
    </div>
    ${prevAnswers ? `<div class="cbt-step-context"><div class="cbt-ctx-label">你前面填的</div><div class="cbt-ctx-text">${escapeHtml(prevAnswers)}</div></div>` : ''}
    <div class="cbt-step-body" id="cbt-ai-hint" style="display:none"></div>
    <textarea id="cbt-answer" rows="4" placeholder="写下你的答案…（AI 会给引导，但不会替你填）"></textarea>
    <div class="cbt-step-actions">
      <button id="cbt-ai-btn" class="btn-icon" title="让 AI 给我一句引导提示">💡 AI 提示</button>
      <span style="flex:1"></span>
      <button id="cbt-prev-btn" class="btn-ghost" ${idx === 0 ? 'disabled' : ''}>上一步</button>
      <button id="cbt-next-btn" class="btn-primary">${idx === ABCDE_FIELDS.length - 1 ? '完成' : '下一步'}</button>
    </div>
  `;

  return new Promise((resolve) => {
    const input = document.getElementById('cbt-answer');
    input.value = state.answers[f.id] || '';
    input.focus();

    document.getElementById('cbt-ai-btn').onclick = async () => {
      const btn = document.getElementById('cbt-ai-btn');
      btn.disabled = true;
      btn.textContent = '思考中…';
      try {
        const r = await chat({
          cfg: cfgHolder().cfg,
          messages: [
            { role: 'system', content: `你是 CBT 咨询师。用户在做 ${f.id}（${f.label}）步骤。
事件：${q}
${prevAnswers ? '已知：\n' + prevAnswers : ''}
请给一句 **不超过 60 字** 的引导提示，帮用户想清楚这一步填什么。**不要替用户填答案**，只给提示性问题或思路。直接输出提示文本。` },
          ],
          temperature: 0.6,
          maxTokens: 200,
        });
        const el = document.getElementById('cbt-ai-hint');
        el.style.display = '';
        el.innerHTML = `<div class="cbt-ai-hint-label">💡 引导提示</div><div>${renderMdLite(r.content || '')}</div>`;
      } catch (err) {
        alert('AI 提示失败：' + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = '💡 AI 提示';
      }
    };

    document.getElementById('cbt-prev-btn').onclick = () => {
      if (idx > 0) {
        state.answers[f.id] = input.value.trim();
        localStorage.setItem(K_CBT_SESSION, JSON.stringify({ ...state, q, updatedAt: new Date().toISOString() }));
        stepsEl.innerHTML = '';
        showCbtStep(idx - 1, state, q).then(resolve);
      }
    };

    document.getElementById('cbt-next-btn').onclick = async () => {
      const val = input.value.trim();
      if (!val) { input.focus(); return; }
      state.answers[f.id] = val;
      localStorage.setItem(K_CBT_SESSION, JSON.stringify({ ...state, q, updatedAt: new Date().toISOString() }));

      if (idx === ABCDE_FIELDS.length - 1) {
        state._done = true;
        stepsEl.innerHTML = '<div class="cbt-final">正在生成分析…</div>';
        resolve();
      } else {
        stepsEl.innerHTML = '';
        showCbtStep(idx + 1, state, q).then(resolve);
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        document.getElementById('cbt-next-btn').click();
      }
    });
  });
}

async function showCbtResult(state, q) {
  const stepsEl = document.getElementById('cbt-steps');
  const resultEl = document.getElementById('cbt-result');
  const progressEl = document.getElementById('cbt-progress');
  progressEl.querySelectorAll('.cbt-pip').forEach(p => p.classList.add('done'));

  const answersText = ABCDE_FIELDS.map(f => `【${f.id} ${f.label}】${state.answers[f.id] || '(空)'}`).join('\n');

  stepsEl.innerHTML = '<div class="cbt-final">🧠 正在识别认知扭曲、生成总结…</div>';

  try {
    const r = await chat({
      cfg: cfgHolder().cfg,
      messages: [
        { role: 'system', content: `你是 CBT 治疗师。请分析用户填写的 ABCDE 工作表。

【10 种常见认知扭曲】
${DISTORTIONS.map(d => `- ${d.id}（${d.label}）：${d.desc}`).join('\n')}

请输出严格的 JSON（无其他内容）：
{
  "distortions": [{"id":"...", "label":"...", "evidence":"在 B 中对应的话..."}],
  "insight": "一段 200-350 字的心理学洞察，指出核心扭曲模式 + 建议的重构方向",
  "next_steps": ["下周可尝试的 1 个练习", "另一个可选练习"]
}

规则：
- distortions 数组 1-3 项，只挑最明显的
- insight 用第一人称第二人称对话感，不要说教
- next_steps 具体可执行，不超过 20 字/条
- 严格 JSON，不要 markdown 代码块` },
        { role: 'user', content: `原始事件：${q}\n\nABCDE 工作表：\n${answersText}` },
      ],
      temperature: 0.4,
      maxTokens: 1200,
    });

    // 解析 JSON
    const txt = (r.content || '').trim();
    const jsonStr = txt.match(/```json?\s*([\s\S]*?)```/)?.[1] || txt.match(/\{[\s\S]*\}/)?.[0] || txt;
    let parsed;
    try { parsed = JSON.parse(jsonStr); } catch { parsed = { distortions: [], insight: txt, next_steps: [] }; }

    const distHtml = (parsed.distortions || []).map(d => `
      <div class="cbt-distortion">
        <span class="cbt-distortion-label">${escapeHtml(d.label || d.id || '')}</span>
        <span class="cbt-distortion-evidence">${escapeHtml(d.evidence || '')}</span>
      </div>
    `).join('') || '<p>未识别到明显认知扭曲</p>';

    resultEl.classList.remove('hidden');
    resultEl.innerHTML = `
      <div class="cbt-section-title">🏷 识别到的认知扭曲</div>
      <div class="cbt-distortion-list">${distHtml}</div>
      <div class="cbt-section-title">💡 洞察</div>
      <div class="cbt-insight">${renderMdLite(parsed.insight || '')}</div>
      ${(parsed.next_steps || []).length ? `
        <div class="cbt-section-title">🎯 下周练习</div>
        <ul class="cbt-steps">${parsed.next_steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
      ` : ''}
      <div class="cbt-result-actions">
        <button id="cbt-download" class="btn-primary">💾 导出为 Markdown</button>
        <button id="cbt-new" class="btn-ghost">✕ 关闭</button>
      </div>
    `;

    // 存到 case 里
    try {
      const caseId = localStorage.getItem('psychics.current_case.v1');
      if (caseId) {
        const cases = JSON.parse(localStorage.getItem('psychics.cases.v1') || '[]');
        const c = cases.find(x => x.id === caseId);
        if (c) {
          c.cbtSheets = c.cbtSheets || [];
          c.cbtSheets.push({
            id: `cbt_${Date.now().toString(36)}`,
            createdAt: new Date().toISOString(),
            q, state: { answers: state.answers },
            analysis: parsed,
          });
          localStorage.setItem('psychics.cases.v1', JSON.stringify(cases));
        }
      }
    } catch { /* ignore */ }

    localStorage.removeItem(K_CBT_SESSION);

    document.getElementById('cbt-download').onclick = () => {
      const md = generateCbtMarkdown(q, state, parsed);
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `CBT工作表_${new Date().toISOString().slice(0, 10)}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
    document.getElementById('cbt-new').onclick = () => closeDialog('dlg-cbt');
  } catch (err) {
    stepsEl.innerHTML = `<div class="cbt-final">⚠ 生成失败：${escapeHtml(err.message || '')}</div>
      <button id="cbt-retry" class="btn-primary">重试</button>`;
    document.getElementById('cbt-retry').onclick = () => showCbtResult(state, q);
  }
}

function generateCbtMarkdown(q, state, analysis) {
  const lines = [
    '# CBT 工作表 · ABCDE 记录',
    '',
    `**日期**：${new Date().toLocaleString('zh-CN')}`,
    '',
    '## 原始事件（A）',
    '',
    q,
    '',
    '## 想法（B）',
    '',
    state.answers.B || '',
    '',
    '## 后果（C）',
    '',
    state.answers.C || '',
    '',
    '## 辩驳（D）',
    '',
    state.answers.D || '',
    '',
    '## 新效果（E）',
    '',
    state.answers.E || '',
    '',
    '---',
    '',
    '## 🏷 识别到的认知扭曲',
    '',
    ...(analysis.distortions || []).map(d => `- **${d.label || d.id}**：${d.evidence || ''}`).join('\n') || '未识别',
    '',
    '## 💡 洞察',
    '',
    analysis.insight || '',
    '',
  ];
  if ((analysis.next_steps || []).length) {
    lines.push('## 🎯 下周练习', '');
    analysis.next_steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push('');
  }
  lines.push('---', '', '*由 Psychics · CBT 工作表自动生成*');
  return lines.join('\n');
}

function continueCbt() {
  const btn = document.getElementById('cbt-continue-btn');
  if (!btn || !btn.dataset.draft) return;
  try {
    const draft = JSON.parse(btn.dataset.draft);
    const q = draft.q || '';
    // 找到最后一个已填的步
    let lastDone = -1;
    for (let i = 0; i < ABCDE_FIELDS.length; i++) {
      if (draft.answers?.[ABCDE_FIELDS[i].id]) lastDone = i;
    }
    localStorage.setItem(K_CBT_SESSION, JSON.stringify(draft));

    // 直接走 startCbt 但先设值
    document.getElementById('cbt-question').value = q;
    // 复用 startCbt，但它会重置 state —— 用另一种方式
    startCbtWithDraft(draft, q, lastDone);
  } catch (err) {
    alert('草稿恢复失败：' + err.message);
  }
}

async function startCbtWithDraft(draft, q, lastDoneIdx) {
  if (!isLlmConfigured(cfgHolder().cfg)) {
    alert('请先在右上角"设置"里配置 LLM。');
    return;
  }
  const dlg = document.getElementById('dlg-cbt');
  document.getElementById('cbt-question').parentElement.style.display = 'none';
  document.getElementById('cbt-run-btn').style.display = 'none';
  document.getElementById('cbt-draft-hint')?.setAttribute('hidden', '');
  document.getElementById('cbt-continue-btn')?.setAttribute('hidden', '');

  const progressEl = document.getElementById('cbt-progress');
  const stepsEl = document.getElementById('cbt-steps');
  progressEl.classList.remove('hidden');
  stepsEl.classList.remove('hidden');

  progressEl.innerHTML = ABCDE_FIELDS.map(f => `
    <div class="cbt-pip" data-id="${f.id}"><span>${f.id}</span></div>
  `).join('');

  const state = { answers: draft.answers || {}, q };
  const startIdx = Math.min(lastDoneIdx + 1, ABCDE_FIELDS.length - 1);
  showCbtStep(startIdx, state, q);
}

/* ============================================================
   3. 心理测评（PHQ-9 / GAD-7）
   ============================================================ */

const SCALES = {
  'phq9': {
    id: 'phq9', name: 'PHQ-9 抑郁症筛查', en: 'Patient Health Questionnaire',
    desc: '2 周内的情绪筛查，1 条问题 0-3 分，总分 0-27。',
    items: [
      '做事时提不起劲或没有兴趣',
      '感到心情低落、沮丧或绝望',
      '入睡困难、易醒，或睡得太多',
      '感到疲倦或没有精力',
      '食欲不振，或吃得太多',
      '觉得自己很糟糕，或者让自己/家人失望',
      '觉得活着没意思，或死了也好（想法，非计划）',
      '很难集中注意力（比如看报或看电视时）',
      '动作或说话慢到别人明显觉察，或相反，变得坐立不安',
    ],
    bands: [
      { min: 0,  max: 4,  label: '无抑郁',      color: '#10b981', advice: '目前情绪健康。可继续日常心理健康维护。' },
      { min: 5,  max: 9,  label: '轻度抑郁',    color: '#eab308', advice: '可尝试规律运动、正念、社交，若持续 2 周以上请寻求专业评估。' },
      { min: 10, max: 14, label: '中度抑郁',    color: '#f97316', advice: '建议尽快寻求专业心理咨询或精神科评估。' },
      { min: 15, max: 19, label: '中重度抑郁',  color: '#ef4444', advice: '建议尽快联系精神科医生或危机热线。' },
      { min: 20, max: 27, label: '重度抑郁',    color: '#dc2626', advice: '请**立即**联系专业机构：北京 010-82951332 / 全国 12355。' },
    ],
  },
  'gad7': {
    id: 'gad7', name: 'GAD-7 焦虑症筛查', en: 'Generalized Anxiety Disorder',
    desc: '2 周内的焦虑情绪筛查，1 条问题 0-3 分，总分 0-21。',
    items: [
      '感到紧张、焦虑或心急',
      '无法停止或控制担忧',
      '对各种事情担忧过多',
      '很难放松下来',
      '坐立不安，很难安静地待着',
      '变得很容易烦躁或易怒',
      '感到害怕，好像有什么可怕的事要发生',
    ],
    bands: [
      { min: 0,  max: 4,  label: '无焦虑',      color: '#10b981', advice: '目前焦虑水平健康。' },
      { min: 5,  max: 9,  label: '轻度焦虑',    color: '#eab308', advice: '可尝试呼吸放松、正念、减少咖啡因。若持续请寻求评估。' },
      { min: 10, max: 14, label: '中度焦虑',    color: '#f97316', advice: '建议寻求心理咨询或精神科评估。' },
      { min: 15, max: 21, label: '重度焦虑',    color: '#ef4444', advice: '建议**尽快**联系专业机构：北京 010-82951332 / 全国 12355。' },
    ],
  },
};

const SCALE_OPTIONS = [
  { v: 0, label: '完全没有' },
  { v: 1, label: '几天' },
  { v: 2, label: '一半以上时间' },
  { v: 3, label: '几乎每天' },
];

const K_SCALE_HISTORY = 'psychics.assessments.v1';

export async function openAssessment(scaleId) {
  const scale = SCALES[scaleId] || SCALES.phq9;
  const dlg = openDialog('dlg-assessment');
  if (!dlg) return;

  document.getElementById('as-scale-name').textContent = scale.name;
  document.getElementById('as-scale-desc').textContent = scale.desc;
  document.getElementById('as-scale-toggle').dataset.current = scale.id;
  document.getElementById('as-scale-toggle').classList.toggle('data-phq9', scale.id === 'phq9');

  // 渲染题目
  const listEl = document.getElementById('as-items');
  listEl.innerHTML = scale.items.map((text, i) => `
    <div class="as-item" data-idx="${i}">
      <div class="as-item-head">
        <span class="as-item-num">${i + 1}</span>
        <span class="as-item-text">近 2 周内，你有多少天被「${text}」所困扰？</span>
      </div>
      <div class="as-item-opts">
        ${SCALE_OPTIONS.map(o => `
          <label class="as-opt">
            <input type="radio" name="as-item-${i}" value="${o.v}">
            <span>${o.label} <em>${o.v} 分</em></span>
          </label>
        `).join('')}
      </div>
    </div>
  `).join('');

  document.getElementById('as-progress').textContent = '0 / ' + scale.items.length;
  document.getElementById('as-result').classList.add('hidden');
  document.getElementById('as-submit-btn').style.display = '';
  document.getElementById('as-progress').parentElement.style.display = '';

  // 进度追踪
  listEl.querySelectorAll('input[type=radio]').forEach(inp => {
    inp.addEventListener('change', () => {
      const answered = listEl.querySelectorAll('input:checked').length;
      document.getElementById('as-progress').textContent = answered + ' / ' + scale.items.length;
    });
  });
}

async function submitAssessment() {
  const toggle = document.getElementById('as-scale-toggle');
  const scaleId = toggle?.dataset.current || 'phq9';
  const scale = SCALES[scaleId];

  const listEl = document.getElementById('as-items');
  const answers = [];
  let missing = 0;
  for (let i = 0; i < scale.items.length; i++) {
    const checked = listEl.querySelector(`input[name="as-item-${i}"]:checked`);
    if (checked) answers.push(parseInt(checked.value));
    else { missing++; answers.push(null); }
  }
  if (missing) {
    alert(`还有 ${missing} 题未作答`);
    return;
  }

  const total = answers.reduce((a, b) => a + b, 0);
  const band = scale.bands.find(b => total >= b.min && total <= b.max) || scale.bands[scale.bands.length - 1];

  const resultEl = document.getElementById('as-result');
  listEl.style.display = 'none';
  document.getElementById('as-submit-btn').style.display = 'none';
  document.getElementById('as-progress').parentElement.style.display = 'none';

  resultEl.classList.remove('hidden');
  resultEl.innerHTML = `
    <div class="as-result-head" style="border-left-color: ${band.color}">
      <div class="as-result-num">${total}<em>/${scale.id === 'phq9' ? 27 : 21}</em></div>
      <div class="as-result-info">
        <div class="as-result-label" style="color:${band.color}">${band.label}</div>
        <div class="as-result-band">${band.min}–${band.max} 分区间</div>
      </div>
    </div>
    <div class="as-result-advice">${renderMdLite(band.advice)}</div>
    <div class="as-disclaimer">
      ⚠ <b>免责</b>：本量表是筛查工具，不是诊断。得分不代表你有此病，也不代表你没有。请以此为线索寻求专业评估。
    </div>
    <div class="as-result-actions">
      <button id="as-download" class="btn-primary">💾 导出报告</button>
      <button id="as-retry" class="btn-ghost">↺ 重测</button>
      <button id="as-close" class="btn-ghost">✕ 关闭</button>
    </div>
  `;

  // 保存到 case
  try {
    const caseId = localStorage.getItem('psychics.current_case.v1');
    if (caseId) {
      const cases = JSON.parse(localStorage.getItem('psychics.cases.v1') || '[]');
      const c = cases.find(x => x.id === caseId);
      if (c) {
        c.assessments = c.assessments || [];
        c.assessments.push({
          id: `${scale.id}_${Date.now().toString(36)}`,
          scale: scale.id,
          scaleName: scale.name,
          createdAt: new Date().toISOString(),
          answers,
          total,
          band: { label: band.label, range: `${band.min}-${band.max}`, color: band.color },
        });
        c.updatedAt = new Date().toISOString();
        localStorage.setItem('psychics.cases.v1', JSON.stringify(cases));
      }
    }
    // 全局历史（不看 case）
    const hist = JSON.parse(localStorage.getItem(K_SCALE_HISTORY) || '[]');
    hist.unshift({ scale: scale.id, scaleName: scale.name, at: new Date().toISOString(), total, band: band.label });
    localStorage.setItem(K_SCALE_HISTORY, JSON.stringify(hist.slice(0, 50)));
  } catch { /* ignore */ }

  document.getElementById('as-download').onclick = () => {
    const md = `# ${scale.name}（${scale.en}）· 测评报告

**日期**：${new Date().toLocaleString('zh-CN')}
**总分**：${total} / ${scale.id === 'phq9' ? 27 : 21}
**区间**：${band.label}（${band.min}–${band.max} 分）

## 逐项回答

${scale.items.map((text, i) => `- Q${i + 1}. ${text} — ${SCALE_OPTIONS[answers[i]].label}（${answers[i]} 分）`).join('\n')}

## 说明

${band.advice}

---

⚠ **免责声明**：本量表是筛查工具，不能替代专业诊断。任何结果都需要与专业心理咨询或精神科医生讨论。

*由 Psychics · 心理测评自动生成*
`;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${scale.id}_报告_${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  document.getElementById('as-retry').onclick = () => openAssessment(scaleId);
  document.getElementById('as-close').onclick = () => closeDialog('dlg-assessment');
}

function switchScale() {
  const toggle = document.getElementById('as-scale-toggle');
  const current = toggle?.dataset.current;
  const next = current === 'phq9' ? 'gad7' : 'phq9';
  openAssessment(next);
}

/* ============================================================
   4. 主入口绑定
   ============================================================ */

export function bindCqItems() {
  document.querySelectorAll('.cq-item').forEach(el => {
    if (el.dataset._bound) return;
    el.dataset._bound = '1';
    el.onclick = async () => {
      const mode = el.dataset.mode;
      const text = (el.querySelector('.cq-title')?.textContent
        || el.querySelector('.cq-name')?.textContent || '').trim();
      switch (mode) {
        case 'panel':
          openPanelConsult();
          break;
        case 'cbt':
          openCbtWorksheet();
          break;
        case 'assessment':
          openAssessment('phq9');
          break;
        case 'supervision':
          openSupervision();
          break;
        default:
          if (el.querySelector('.cq-sub')) {
            // 未实现的团队模式 → 明确提示
            alert(`「${text}」场景正在设计中，请先用已上线的三个工具：多专家会诊 / CBT 工作表 / 心理测评。`);
          } else {
            alert('这个入口还没有实现功能。');
          }
      }
    };
  });
}

/* ============================================================
   5. 全球危机热线（无 LLM，纯本地）
   ============================================================ */
export function openCrisisList() {
  const dlg = openDialog('dlg-crisis');
  if (!dlg) return;
  const list = document.getElementById('cr-list');
  const filter = document.getElementById('cr-filter');
  renderCrisisList('');
  if (filter && !filter.dataset._bound) {
    filter.dataset._bound = '1';
    let timer = null;
    filter.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => renderCrisisList(filter.value.trim()), 120);
    });
  }
}

function renderCrisisList(q) {
  const list = document.getElementById('cr-list');
  if (!list) return;
  const all = getCrisisHelplines();
  const k = normKey(q);
  const items = k
    ? all.filter(r =>
        normKey([r.region, r.name_zh, r.name_en, r.phone, r.note].filter(Boolean).join(' ')).includes(k)
      )
    : all;

  // 按地区分组
  const groups = new Map();
  for (const r of items) {
    if (!groups.has(r.region || '其他')) groups.set(r.region || '其他', []);
    groups.get(r.region || '其他').push(r);
  }

  if (!items.length) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-3);font-size:13px;">未找到匹配的热线，试试其他关键词（如"中国"、"美国"）。</div>';
    return;
  }

  list.innerHTML = [...groups.entries()].map(([region, rows]) => `
    <div style="margin-bottom:14px;">
      <div style="font-size:11px; color:var(--text-3); font-weight:600; margin:0 0 6px; letter-spacing:.3px;">${escapeHtml(region)}</div>
      <div style="display:flex; flex-direction:column; gap:6px;">
        ${rows.map(r => `
          <div class="cr-item">
            <div class="cr-body">
              <div class="cr-name">${escapeHtml(r.name_zh || r.name_en || '')}</div>
              <div class="cr-phone">${escapeHtml(r.phone || '—')}</div>
              ${r.note ? `<div class="cr-note">${escapeHtml(r.note)}</div>` : ''}
            </div>
            ${r.url ? `<a class="cr-link" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer" title="官网">↗</a>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

function normKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[\s·.．・\-—_()（）]/g, '');
}

/* ============================================================
   6. 信息 & 免责声明
   ============================================================ */
export function openInfoDialog() {
  openDialog('dlg-info');
}

/** 弹窗内所有按钮/输入的初始化绑定（只绑一次） */
export function bindDialogs() {
  const bind = (id, handler) => {
    const el = document.getElementById(id);
    if (el && !el.dataset._bound) {
      el.onclick = handler;
      el.dataset._bound = '1';
    }
  };
  bind('btn-pc-close',   () => closeDialog('dlg-panel-consult'));
  bind('btn-cbt-close',  () => closeDialog('dlg-cbt'));
  bind('btn-as-close',   () => closeDialog('dlg-assessment'));
  bind('btn-sv-close',   () => closeDialog('dlg-supervision'));
  bind('btn-crisis-close', () => closeDialog('dlg-crisis'));
  bind('btn-info-close',   () => closeDialog('dlg-info'));
  bind('btn-info-ok',      () => closeDialog('dlg-info'));
  bind('pc-run-btn',     runPanelConsult);
  bind('cbt-run-btn',    startCbt);
  bind('cbt-continue-btn', continueCbt);
  bind('as-scale-toggle', switchScale);
  bind('as-submit-btn',  submitAssessment);
  bind('sv-run-btn',     runSupervision);
  bind('btn-info',       openInfoDialog);
  bind('btn-crisis-more', openCrisisList);
  ['dlg-panel-consult', 'dlg-cbt', 'dlg-assessment', 'dlg-supervision', 'dlg-crisis', 'dlg-info']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el && !el.dataset._bound) {
        el.dataset._bound = '1';
        el.addEventListener('click', (e) => {
          // 点击遮罩关闭
          if (e.target === el) closeDialog(id);
        });
      }
    });
}

function openSupervision() {
  // 简易督导室：引导专业学生做 3 步反思
  const dlg = openDialog('dlg-supervision');
  if (!dlg) { alert('督导室组件初始化中，请重试'); return; }
  document.getElementById('sv-case').value = '';
  document.getElementById('sv-content').innerHTML = '';
  document.getElementById('sv-run-btn').style.display = '';
}

async function runSupervision() {
  if (!isLlmConfigured(cfgHolder().cfg)) { alert('请先在右上角"设置"里配置 LLM。'); return; }
  const c = document.getElementById('sv-case').value.trim();
  if (c.length < 30) { alert('请把案例描述得更具体一点（至少 30 字）'); return; }

  document.getElementById('sv-run-btn').style.display = 'none';
  const contentEl = document.getElementById('sv-content');
  contentEl.innerHTML = '<div class="sv-loading">🧠 督导室正在分 3 步思考…</div>';

  const { cfg } = cfgHolder();
  const sysPrompt = `你是资深心理学督导。请对来访者案例做三步督导：

1. **提问**（2-3 个）：不评判，用反射式追问帮助咨询师看清反移情、来访者的表达与沉默、动力层面的东西。
2. **反思**：可能的投射、阻抗、防御机制、家庭/依恋层面的假设。
3. **建议**：具体 1-2 个下一步技术动作（人本、精神分析、CBT、系统家庭观都可），说明依据。

回复 300-500 字，简洁、有洞察、避免说教。不要说"作为AI"。`;

  try {
    const r = await chat({
      cfg,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: `案例描述：${c}` },
      ],
      temperature: 0.5,
      maxTokens: 1200,
    });
    contentEl.innerHTML = `
      <div class="sv-section">
        <div class="sv-section-title">1️⃣ 提问</div>
        <div class="sv-section-body">${renderMdLite(r.content || '')}</div>
      </div>
      <div class="sv-actions">
        <button id="sv-new" class="btn-primary">🔁 再来一次</button>
        <button id="sv-close" class="btn-ghost">✕ 关闭</button>
      </div>
    `;
    document.getElementById('sv-new').onclick = () => runSupervision();
    document.getElementById('sv-close').onclick = () => closeDialog('dlg-supervision');
  } catch (err) {
    contentEl.innerHTML = `<div class="sv-error">⚠ 生成失败：${escapeHtml(err.message || '')}</div>
      <button id="sv-retry" class="btn-primary">重试</button>`;
    document.getElementById('sv-retry').onclick = () => runSupervision();
  }
}

/* ============================================================
   cfg 桥接（供 cfgHolder 使用）
   ============================================================ */
let _cfgRef = null;
export function setCfgRef(ref) { _cfgRef = ref; }
function cfgHolder() { return { cfg: _cfgRef }; }
