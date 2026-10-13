/* ============================================================
   scenes.js —— 场景剧本集
   ------------------------------------------------------------
   把"有创意的新交互"集中放这里，避免 tools.js 越滚越胖。
   每个场景独立可复用：
     · openXxx()      打开弹窗 / 初始化状态
     · runXxx()       执行主流程
   依赖：
     · chat           来自 llm.js
     · isLlmConfigured 来自 config.js
     · setCfgRef 注入的 cfg 桥接
   ============================================================ */

import { chat } from './llm.js';
import { isLlmConfigured } from './config.js';

/* -------- 工具：dialog / 转义 / 极简 markdown / cfg 桥接 -------- */
function openDialog(id) {
  const dlg = document.getElementById(id);
  if (!dlg) { console.warn('[scenes] dialog not found:', id); return null; }
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
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}
let _cfgRef = null;
export function setCfgRef(ref) { _cfgRef = ref; }
function cfgHolder() { return { cfg: _cfgRef }; }

/* ============================================================
   场景 ①：关系动力学沙盘
   ------------------------------------------------------------
   让 LLM 扮演两个角色（如"你和伴侣"），模拟一段真实互动。
   每 2 轮之间弹一个"暂停点"，让你插入一句话，看走向如何改变。
   ============================================================ */

const DRAMA_MAX_TURNS = 6;   // 默认 6 轮，即 3 次暂停点
const TURN_PER_SEGMENT = 2;  // 每 2 轮一个暂停点

export function openDramaSandbox() {
  const dlg = openDialog('dlg-drama');
  if (!dlg) return;
  document.getElementById('ds-role-a').value = '';
  document.getElementById('ds-role-b').value = '';
  document.getElementById('ds-scene').value = '';
  document.getElementById('ds-turns').value = '6';
  document.getElementById('ds-status').textContent = '';
  document.getElementById('ds-stages').innerHTML = '';
  document.getElementById('ds-review').style.display = 'none';
  document.getElementById('ds-review').innerHTML = '';
  document.getElementById('ds-run-btn').style.display = '';
  document.getElementById('ds-restart-btn').style.display = 'none';
}

async function runDramaSandbox() {
  const roleA = document.getElementById('ds-role-a').value.trim();
  const roleB = document.getElementById('ds-role-b').value.trim();
  const scene = document.getElementById('ds-scene').value.trim();
  const turnsRaw = parseInt(document.getElementById('ds-turns').value, 10);
  const turns = Math.max(4, Math.min(DRAMA_MAX_TURNS, Number.isFinite(turnsRaw) ? turnsRaw : DRAMA_MAX_TURNS));

  if (!roleA || !roleB || !scene) { alert('三个输入都不能为空'); return; }
  if (roleA.length < 10) { alert('角色 A 描述太短，请补充性格/语气/诉求等'); return; }

  const runBtn = document.getElementById('ds-run-btn');
  const status = document.getElementById('ds-status');
  const stages = document.getElementById('ds-stages');
  const reviewEl = document.getElementById('ds-review');
  const restartBtn = document.getElementById('ds-restart-btn');

  runBtn.style.display = 'none';
  restartBtn.style.display = '';
  stages.innerHTML = '';

  // 保存脚本上下文：每次 runDrama 独立闭包
  const script = {
    roleA, roleB, scene,
    turns,
    segments: [],       // 已生成的 (roleA/roleB) 话语对
    interventions: [], // 用户在每个暂停点插入的话
  };

  try {
    const first = await runOneSegment(script, 0);
    if (!first) return;

    let seg = 1;
    while (seg * TURN_PER_SEGMENT < script.turns) {
      status.textContent = `⏸ 第 ${seg} 幕结束，可插入你要说的话（留空则跳过，直接进入下一幕）`;
      const intervene = await showInterventionInput(stages, seg, script);
      if (intervene != null) script.interventions.push({ segment: seg, text: intervene });
      const next = await runOneSegment(script, seg + 1);
      if (!next) return;
      seg += 1;
    }

    // 复盘：咨询师视角
    status.textContent = '🎓 咨询师正在复盘这场对话…';
    const review = await runDramaReview(script);
    reviewEl.style.display = '';
    reviewEl.innerHTML = `<div class="ds-review-title">🎓 咨询师复盘</div>${renderMdLite(review)}`;

    status.textContent = '';
  } catch (err) {
    status.textContent = `⚠ 出错：${err.message || err}`;
  } finally {
    runBtn.style.display = '';
  }
}

/**
 * 跑一段对话（一段 = TURN_PER_SEGMENT 轮）。
 * 段号 seg=1 表示第一轮，seg=2 表示在暂停点插入后接下一轮。
 */
async function runOneSegment(script, seg) {
  const status = document.getElementById('ds-status');
  const stages = document.getElementById('ds-stages');
  const cfg = cfgHolder()?.cfg;
  if (!cfg || !isLlmConfigured(cfg)) {
    status.textContent = '⚠ 请先在右上角"设置"里配置 LLM。';
    return false;
  }
  status.textContent = `🎬 第 ${seg} 幕 · ${TURN_PER_SEGMENT} 轮对话中…`;

  const history = script.segments.map(s => {
    return [
      { role: 'assistant', content: `[${script.roleA}] ${s.a}` },
      { role: 'assistant', content: `[${script.roleB}] ${s.b}` },
    ].flat();
  });
  // 如果上一段结尾有介入，把它加进 history，让下一段"知道"用户说过什么
  if (seg > 1) {
    const lastIntv = script.interventions[script.interventions.length - 1];
    if (lastIntv && lastIntv.text) {
      history.push({ role: 'user', content: `[你（作为观察者）刚才说："${lastIntv.text}"]` });
    }
  }

  const system = `你是心理学沙盘剧场的导演。请**分两个角色**演一段真实对话。

【角色 A】${script.roleA}
【角色 B】${script.roleB}
【当前场景】${script.scene}

【输出格式（严格遵守）】
只输出下面这段结构，不加任何前后缀：
[A] ...
[B] ...
[A] ...
[B] ...

共 ${TURN_PER_SEGMENT * 2} 行，每行 40-100 字。不要输出"旁白""舞台指示""场景描述"，只输出对话。
两个角色必须明显区分：A 的语言风格、词汇、反应节奏要与 B 相反或形成张力。
情绪要有起伏（可以冲突、可以冷处理、可以沉默、可以突然软化），不要一路和气。`;

  const userMsg = seg === 1
    ? `开始 ${script.scene}。请直接以第一幕开场，双方各自抛出核心冲突。`
    : `接上一段。刚才作为观察者我插入了：「${script.interventions.at(-1)?.text || '（无介入）'}」。\n请让 ${script.roleA} 与 ${script.roleB} 自然接上你的话，然后继续推进冲突。`;

  try {
    const r = await chat({
      cfg,
      messages: [
        { role: 'system', content: system },
        ...history,
        { role: 'user', content: userMsg },
      ],
      temperature: 0.85,
      maxTokens: 900,
    });
    const parsed = parseDramaLines(r.content || '', script);
    if (!parsed) {
      status.textContent = '⚠ LLM 输出格式异常，请重试';
      return false;
    }
    script.segments.push(parsed);

    // 渲染本段
    const segDiv = document.createElement('div');
    segDiv.className = 'ds-seg';
    segDiv.innerHTML = `
      <div class="ds-seg-label">第 ${seg} 幕</div>
      <div class="ds-line a"><span class="ds-avatar">${escapeHtml((script.roleA[0] || 'A').toUpperCase())}</span><div class="ds-bubble"><b>${escapeHtml(script.roleA.slice(0, 12))}${script.roleA.length > 12 ? '…' : ''}</b>${escapeHtml(parsed.a)}</div></div>
      <div class="ds-line b"><span class="ds-avatar b">${escapeHtml((script.roleB[0] || 'B').toUpperCase())}</span><div class="ds-bubble b"><b>${escapeHtml(script.roleB.slice(0, 12))}${script.roleB.length > 12 ? '…' : ''}</b>${escapeHtml(parsed.b)}</div></div>
    `;
    stages.appendChild(segDiv);
    stages.scrollTop = stages.scrollHeight;
    return true;
  } catch (err) {
    status.textContent = `⚠ 第 ${seg} 幕生成失败：${err.message || err}`;
    return false;
  }
}

/** 从 LLM 输出中提取 [A]/[B] 各一句 */
function parseDramaLines(text, script) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let a = '', b = '';
  for (const line of lines) {
    const m = line.match(/^\[([AB])\]\s*(.+)$/i);
    if (!m) continue;
    const who = m[1].toUpperCase();
    if (who === 'A' && !a) a = m[2];
    else if (who === 'B' && !b) b = m[2];
  }
  if (!a && !b) return null;
  return { a: a || '……', b: b || '……' };
}

/** 渲染"暂停点"输入框，返回用户输入（或 null = 跳过） */
function showInterventionInput(stages, seg, script) {
  return new Promise((resolve) => {
    const div = document.createElement('div');
    div.className = 'ds-intervene';
    div.innerHTML = `
      <div class="ds-intervene-head">⏸ 第 ${seg} 幕结束 · 你要插入一句话吗？</div>
      <div class="ds-intervene-hint">例："等一下，你们先深呼吸" / "换个说法试试" / "我觉得你刚才那句话其实不是那个意思" / 也可以留空跳过</div>
      <div class="ds-intervene-row">
        <input type="text" id="ds-intv-input" maxlength="120" placeholder="想说的话（留空跳过）" />
        <button class="ds-intv-go">继续 ▶</button>
      </div>
    `;
    stages.appendChild(div);
    stages.scrollTop = stages.scrollHeight;
    const input = document.getElementById('ds-intv-input');
    const btn = div.querySelector('.ds-intv-go');
    const done = () => {
      const v = input.value.trim();
      div.remove();
      resolve(v || null);
    };
    btn.onclick = done;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
    input.focus();
  });
}

/** 咨询师视角的复盘 */
async function runDramaReview(script) {
  const cfg = cfgHolder()?.cfg;
  if (!cfg) return '（未配置 LLM，无法生成复盘）';
  const convo = script.segments.map((s, i) => {
    return `【第 ${i + 1} 幕】\n${script.roleA}：${s.a}\n${script.roleB}：${s.b}`;
  }).join('\n\n');
  const intvs = script.interventions
    .filter(v => v.text)
    .map(v => `第 ${v.segment} 幕插入：「${v.text}」`)
    .join('\n') || '（用户没有插入任何话）';

  const system = `你是资深关系动力学咨询师，请对下面这场角色扮演做**结构化复盘**。

【你的任务】
按下面五栏输出，中文，总长 400-700 字：

1. **关系模式识别**：这场对话里浮现了什么样的循环？（如：追-逃、指责-防御、控制-回避、共谋-沉默）
2. **升级路径**：从哪一句话/哪一个停顿开始，情绪从 A 级跳到了 B 级？
3. **介入的实际效果**：用户的介入如果没被"接住"，是为什么？如果接住了，改变了什么走向？（若无介入，评估"缺失的介入点"）
4. **未说出口的话**：每个角色此刻最想但没说出的那一句是什么？
5. **下一步实验**：给出 1-2 条在真实关系里可以试的具体行动。

【约束】
- 不做医学诊断、不下道德判断
- 用"这段对话里我看到的…"这种观察式语言，不用"你应该…"这种建议式语言
- 不输出"作为AI""作为咨询师"这类元话术`;

  const user = `场景：${script.scene}\n角色 A：${script.roleA}\n角色 B：${script.roleB}\n\n=== 完整对话 ===\n${convo}\n\n=== 用户介入 ===\n${intvs}`;

  try {
    const r = await chat({
      cfg,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.5,
      maxTokens: 1400,
    });
    return r.content || '（生成失败）';
  } catch (err) {
    return `⚠ 复盘生成失败：${err.message || err}`;
  }
}

/* ============================================================
   场景 ②：伦理困境辩论
   ------------------------------------------------------------
   从伦理守则库（10 个国际/国内准则）随机抽 1 个真实两难，
   让 4 位不同伦理学家辩论：谁主张 A、谁主张 B、谁"必须违反一条"。
   ============================================================ */

const ETHICS_CASES = [
  {
    title: '双重关系：咨询师的病人是好友的同事',
    desc: '你的一位多年好友上周告诉你，她的新同事最近精神状态很差，"每天哭、不吃不睡"。你查了公司名单发现，她同事就是 X。你既不是 X 的来访者也不是 X 的同事，但你认识他，你也认识介绍人（好友）。X 主动来找你："你能帮我看看吗？我觉得我不正常了。"',
    focus: '双重关系 · 转介义务 · 保密',
  },
  {
    title: '保密例外：来访者透露"想报复某人"',
    desc: '来访者第 3 次会谈时说："其实我已经想好了，我要在某天去见 Y（一个具体的人），做点什么让她后悔。"他描述了细节但没有明确说"我要杀她"，而是"想给她一个教训"。他情绪平静、逻辑清晰、看起来像已计划好。',
    focus: 'Tarekasan 原则 · 预警义务 · 记录与转介',
  },
  {
    title: '在线咨询：来访者透露是未成年人',
    desc: '线上第 2 次咨询，来访者一直自称 20 岁大学生。中途你说"你能不能告诉我你多大了，我想了解发育史"，他突然沉默。你说"这不是秘密，只是常规问题"，他回复："其实我 16 岁。"',
    focus: '知情同意有效性 · 未成年人保护 · 家长告知',
  },
  {
    title: '知情同意：来访者要求"保密全部"包括不告诉配偶',
    desc: '来访者是已婚男性，婚姻中已出现明显裂痕，他要求你"什么都不告诉我的妻子，包括我们做过咨询"。他透露："我知道妻子在外面有人，我在收集证据，等她犯错就离婚"。你评估他有轻度抑郁，无自伤自杀风险，但对她的态度已出现明显敌意。',
    focus: '保密 · 第三方利益 · 治疗目标与个人目标的冲突',
  },
  {
    title: '能力边界：心理咨询师被要求开抗抑郁药',
    desc: '来访者第 10 次咨询，PHQ-9 从 18 降到 12 但仍在中度抑郁区间。他说："我知道 CBT 对我没用，我需要吃药，你能给我开点舍曲林吗？我听说你就够格。"你说："我不开药，但可以帮你转介精神科医生。"他沉默后说："转介要排队三个月，我等不了。"',
    focus: '胜任力 · 转介伦理 · 治疗关系边界',
  },
];

const ETHICS_DEBATERS = [
  { id: 'kantian',   name: '康德义务论视角',   stance: '强调原则、绝对义务、不可违背' },
  { id: 'utilitarian', name: '功利主义视角',  stance: '看后果、最大化整体福祉' },
  { id: 'care',      name: '关怀伦理视角',   stance: '看具体关系、看人、看处境' },
  { id: 'regulator', name: '行业准则视角',   stance: '看现行伦理守则怎么说' },
];

export async function openEthicsDilemma() {
  if (!isLlmConfigured(cfgHolder()?.cfg)) { alert('请先在右上角"设置"里配置 LLM。'); return; }
  const dlg = openDialog('dlg-ethics');
  if (!dlg) return;
  // 随机抽一个
  const idx = Math.floor(Math.random() * ETHICS_CASES.length);
  const c = ETHICS_CASES[idx];
  document.getElementById('ed-title').textContent = c.title;
  document.getElementById('ed-desc').textContent = c.desc;
  document.getElementById('ed-focus').textContent = c.focus;
  document.getElementById('ed-results').innerHTML = '';
  document.getElementById('ed-summary').style.display = 'none';
  document.getElementById('ed-status').textContent = '';
  document.getElementById('ed-run-btn').style.display = '';
  document.getElementById('ed-redraw-btn').style.display = '';
}

async function runEthicsDilemma() {
  const title = document.getElementById('ed-title').textContent;
  const desc = document.getElementById('ed-desc').textContent;
  const status = document.getElementById('ed-status');
  const results = document.getElementById('ed-results');
  const summary = document.getElementById('ed-summary');
  const runBtn = document.getElementById('ed-run-btn');
  runBtn.style.display = 'none';
  results.innerHTML = '';

  try {
    // 4 位辩论者开题
    status.textContent = '① 4 位伦理学家独立开题…';
    const openers = await Promise.all(ETHICS_DEBATERS.map(async d => {
      const r = await chat({
        cfg: cfgHolder().cfg,
        messages: [
          { role: 'system', content: buildEthicsOpenerPrompt(d) },
          { role: 'user', content: `伦理困境：${title}\n\n情境描述：${desc}\n\n请以你的立场直接给出核心主张。` },
        ],
        temperature: 0.6,
        maxTokens: 700,
      });
      return { ...d, content: r.content || '', ok: !!r.content };
    }));
    openers.forEach(r => appendEthicsCard(results, r, 'opener'));

    // 第二轮：交锋（每人回应前一位）
    status.textContent = '② 辩论交锋：每人回应前一位…';
    const rebuts = [];
    for (let i = 1; i < openers.length; i++) {
      const prev = openers[i - 1];
      const r = await chat({
        cfg: cfgHolder().cfg,
        messages: [
          { role: 'system', content: buildEthicsRebuttalPrompt(ETHICS_DEBATERS[i], prev) },
          { role: 'user', content: `议题：${title}\n\n${desc}\n\n上一位（${prev.name}）的完整发言：\n"""${prev.content}"""\n\n请以 ${ETHICS_DEBATERS[i].name} 的身份，正面回应 TA 的其中一句观点，并给出你方立场的最终版本。300-450 字。` },
        ],
        temperature: 0.6,
        maxTokens: 900,
      });
      const item = { ...ETHICS_DEBATERS[i], content: r.content || '', ok: !!r.content, quoteFrom: prev.name };
      rebuts.push(item);
      appendEthicsCard(results, item, 'rebuttal');
    }

    // 独立反思者
    status.textContent = '③ 独立反思：审视辩论本身…';
    const transcript = openers.concat(rebuts).map(r =>
      `【${r.name}${r.quoteFrom ? ` · 回应 ${r.quoteFrom}` : ''}】\n${r.content}`
    ).join('\n\n---\n\n');

    const refl = await chat({
      cfg: cfgHolder().cfg,
      messages: [
        { role: 'system', content: `你是伦理审查委员会的独立审查员，不属任何学派。
对本次辩论做结构化反思：
1. **原则-后果张力**：哪些主张在原则正确但后果差？哪些相反？
2. **准则盲区**：现行伦理守则（如 APA 2017、CPsR 2018）面对此困境有没有明确条文？如果有引用哪一条，如果没有指出空白
3. **文化差异**：这个困境在中国/美国/欧洲语境下，答案会不会不一样？
4. **实操检查清单**：给出 3-5 条咨询师面对此困境可以立刻做的检查项
500-800 字。不要代替专家下最终决定，只指出盲区。` },
        { role: 'user', content: `议题：${title}\n${desc}\n\n=== 完整辩论 ===\n${transcript}` },
      ],
      temperature: 0.4,
      maxTokens: 1400,
    });
    appendEthicsCard(results, { name: '独立审查员', stance: '不代替专家下决定', content: refl.content || '', ok: !!refl.content }, 'reflex');

    // 综合点评
    status.textContent = '④ 主持人综合…';
    const summaryR = await chat({
      cfg: cfgHolder().cfg,
      messages: [
        { role: 'system', content: `你是伦理委员会主席，请基于开题、交锋、独立反思三部分，输出：
1. **共识**：所有视角都认同的行动
2. **真正的分歧**：谁在什么层面上反对谁
3. **推荐路径**：给出一个**具体、可执行、有备份**的行动方案（例：先做 X，若 X 不可行则做 Y）
4. **不可越的红线**：明确列出"什么情况下绝对不能做 Z"
5. **不确定性**：这个问题还有哪一层没被讨论到
每条后面标注来源。500-900 字。` },
        { role: 'user', content: `议题：${title}\n${desc}\n\n=== 完整辩论 + 反思 ===\n${transcript}\n\n=== 独立审查 ===\n${refl.content || '（无）'}` },
      ],
      temperature: 0.4,
      maxTokens: 1800,
    });
    summary.style.display = '';
    summary.innerHTML = `<div class="ed-summary-title">🎯 伦理委员会主席综合点评</div>${renderMdLite(summaryR.content || '')}`;
    status.textContent = '';
  } catch (err) {
    status.textContent = `⚠ 出错：${err.message || err}`;
  } finally {
    runBtn.style.display = '';
  }
}

function buildEthicsOpenerPrompt(debater) {
  return `你是伦理学家**${debater.name}**，立场是：${debater.stance}。

【本轮任务】
面对一个具体的伦理困境，独立给出你的核心主张。

【输出格式（严格遵守）】
1. **一句话结论**：你会怎么判断/处置
2. **依据**：从你的学派/立场解释为什么（引概念、不引具体年份）
3. **风险承认**：你的立场可能带来的副作用是什么
4. **一句话反问**：留一个给下一位辩论者的钩子

【约束】
- 200-300 字
- 不做人身攻击
- 不输出"作为AI"或"作为 ${debater.name}"这类元话术
- 保持你的立场鲜明，不要模糊化`;
}

function buildEthicsRebuttalPrompt(debater, prev) {
  return `你是伦理学家**${debater.name}**，立场是：${debater.stance}。

上一位发言者是 **${prev.name}**。你必须：
1. 点名引用 TA 的**至少一句原话**（用引号）
2. 从你的立场正面回应——可以补充、可以质疑、也可以指出其盲区
3. 补一条 TA 没提到的新论据

300-450 字。第一人称"我"。保持立场鲜明，不做人身攻击。`;
}

function appendEthicsCard(container, r, kind) {
  const div = document.createElement('div');
  div.className = `ed-card ed-card-${kind}`;
  const tagText = kind === 'opener' ? '开题' : kind === 'rebuttal' ? '交锋' : '反思';
  const quoteLine = r.quoteFrom ? `<div class="ed-quote-from">↳ 回应 <b>${escapeHtml(r.quoteFrom)}</b></div>` : '';
  div.innerHTML = `
    <div class="ed-card-head">
      <span class="ed-card-name">${escapeHtml(r.name || '—')}</span>
      <span class="ed-card-stance">${escapeHtml(r.stance || '')}</span>
      <span class="ed-round-tag">${tagText}</span>
    </div>
    ${quoteLine}
    <div class="ed-card-body">${r.content ? renderMdLite(r.content) : '<span style="color:#b91c1c">⚠ 生成失败</span>'}</div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

/* ============================================================
   场景 ③：梦境解析三视角工作坊
   ============================================================ */

export function openDreamWorkshop() {
  openDialog('dlg-dream');
  document.getElementById('dw-dream').value = '';
  document.getElementById('dw-recent').value = '';
  document.getElementById('dw-results').innerHTML = '';
  document.getElementById('dw-summary').style.display = 'none';
  document.getElementById('dw-status').textContent = '';
  document.getElementById('dw-run-btn').style.display = '';
}

async function runDreamWorkshop() {
  const dream = document.getElementById('dw-dream').value.trim();
  const recent = document.getElementById('dw-recent').value.trim();
  if (!dream || dream.length < 20) { alert('请把梦描述得更具体一点（至少 20 字）'); return; }
  if (!isLlmConfigured(cfgHolder()?.cfg)) { alert('请先在右上角"设置"里配置 LLM。'); return; }

  const status = document.getElementById('dw-status');
  const results = document.getElementById('dw-results');
  const summary = document.getElementById('dw-summary');
  const runBtn = document.getElementById('dw-run-btn');
  runBtn.style.display = 'none';
  results.innerHTML = '';

  const dreamers = [
    { name: '弗洛伊德视角', stance: '潜意识冲突 · 未满足的愿望 · 象征解码' },
    { name: '荣格视角',     stance: '集体无意识 · 原型 · 阴影与自性' },
    { name: '认知-神经科学视角', stance: '睡眠生理 · 记忆巩固 · 情绪调节' },
  ];

  try {
    status.textContent = '🌙 三视角平行解析中…';
    const resultsArr = await Promise.all(dreamers.map(async d => {
      const r = await chat({
        cfg: cfgHolder().cfg,
        messages: [
          { role: 'system', content: `你是从**${d.name}**看梦境的专家。立场：${d.stance}。

【输出】
1. **象征清单**：梦里的 3-5 个关键意象，从你的视角解码
2. **动力假设**：这个梦可能在处理什么？
3. **一句反问**：留给做梦者思考的问题

200-320 字。不做医学诊断，不下结论，用假设式语言（"可能是…"、"也许在…"）。` },
          { role: 'user', content: `梦境：\n${dream}${recent ? `\n\n近期现实事件（作为参考）：\n${recent}` : ''}` },
        ],
        temperature: 0.65,
        maxTokens: 700,
      });
      return { ...d, content: r.content || '' };
    }));
    resultsArr.forEach(r => appendDreamCard(results, r));

    // 对比分析
    status.textContent = '🔬 三视角对比中…';
    const three = resultsArr.map(r => `【${r.name}】\n${r.content}`).join('\n\n---\n\n');
    const summaryR = await chat({
      cfg: cfgHolder().cfg,
      messages: [
        { role: 'system', content: `你是梦境研究主持人。请对比三种视角的解读，输出：
1. **一致之处**：三种视角都指认的意象或线索
2. **真正的分歧**：同一意象被三视角赋予的不同含义
3. **对做梦者的价值**：哪一层解读最能预测/解释你近期的现实事件？为什么
4. **保留意见**：哪种解读需要更多证据才能采信

300-500 字。不代替做梦者下判断，只呈现差异。` },
        { role: 'user', content: `梦境：\n${dream}${recent ? `\n\n近期事件：\n${recent}` : ''}\n\n=== 三视角解读 ===\n${three}` },
      ],
      temperature: 0.5,
      maxTokens: 1200,
    });
    summary.style.display = '';
    summary.innerHTML = `<div class="dw-summary-title">🌙 三视角对比与做梦者价值</div>${renderMdLite(summaryR.content || '')}`;
    status.textContent = '';
  } catch (err) {
    status.textContent = `⚠ 出错：${err.message || err}`;
  } finally {
    runBtn.style.display = '';
  }
}

function appendDreamCard(container, r) {
  const div = document.createElement('div');
  div.className = 'dw-card';
  div.innerHTML = `
    <div class="dw-card-head">
      <span class="dw-card-name">${escapeHtml(r.name)}</span>
      <span class="dw-card-stance">${escapeHtml(r.stance)}</span>
    </div>
    <div class="dw-card-body">${renderMdLite(r.content)}</div>
  `;
  container.appendChild(div);
}

/* ============================================================
   场景 ④：对话教练
   ============================================================ */

export function openDialogCoach() {
  openDialog('dlg-coach');
  document.getElementById('dc-scene').value = '';
  document.getElementById('dc-target').value = '';
  document.getElementById('dc-line').value = '';
  document.getElementById('dc-feedback').style.display = 'none';
  document.getElementById('dc-feedback').innerHTML = '';
  document.getElementById('dc-run-btn').style.display = '';
}

async function runDialogCoach() {
  const scene = document.getElementById('dc-scene').value.trim();
  const target = document.getElementById('dc-target').value.trim();
  const line = document.getElementById('dc-line').value.trim();
  if (!scene || !target || !line) { alert('三个输入都不能为空'); return; }
  if (!isLlmConfigured(cfgHolder()?.cfg)) { alert('请先在右上角"设置"里配置 LLM。'); return; }

  const status = document.getElementById('dc-status');
  const fb = document.getElementById('dc-feedback');
  const runBtn = document.getElementById('dc-run-btn');
  runBtn.style.display = 'none';
  status.textContent = '🎯 对话教练从 4 个视角分析中…';

  try {
    const r = await chat({
      cfg: cfgHolder().cfg,
      messages: [
        { role: 'system', content: `你是高级沟通教练。请对下面这段对话从 **4 个独立视角**分析：

用户设定：
- 场景：${scene}
- 对象画像：${target}
- 用户想说的话：「${line}」

请按下面 4 栏结构化输出（中文，总长 500-800 字）：

## 🎭 对方心理活动（他听到这句话时的内心独白）
- 他可能在想什么
- 他可能感受到什么
- 他可能立刻产生的防御反应

## ⚡ 你的语言触发点
- 你这句话里哪几个词最容易引爆冲突（用引号标出）
- 你的隐藏诉求是什么（表面在说 A，其实在要 B）
- 你此刻的情绪等级（1-10），为什么会这样

## 📈 情绪升级风险
- 如果按现在这句说，冲突从 0 秒到 5 分钟的可能走向（3 段式：开局/中段/结局）
- 出现升级的第一个信号是什么（他可能的身体语言/微表情/用词）

## 🌿 更柔和的替代说法（3 条备选）
- 备选 1（保留诉求，改变措辞）：…
- 备选 2（先示弱，再提要求）：…
- 备选 3（先共情，再边界）：…
每条一句话，可直接使用，20-40 字。

【约束】
- 不做心理学诊断、不判断用户对错
- 用"你""他"具体指代，避免抽象术语
- 不输出"作为AI"这类话术` },
        { role: 'user', content: `场景：${scene}\n对象：${target}\n想说：「${line}」` },
      ],
      temperature: 0.55,
      maxTokens: 1800,
    });
    fb.style.display = '';
    fb.innerHTML = `<div class="dc-fb-title">🎯 对话教练 · 四维反馈</div>${renderMdLite(r.content || '')}`;
    status.textContent = '';
  } catch (err) {
    status.textContent = `⚠ 出错：${err.message || err}`;
  } finally {
    runBtn.style.display = '';
  }
}

/* ============================================================
   场景 ⑤：心理沙盘（Jungian Sandplay · 单人版）
   ------------------------------------------------------------
   来访者摆沙盘：
     · 从 30 件象征物里选 + 摆放位置
     · 治疗师引导（Jung 经典 5 问） 或 多视角解读（4 视角并行）
     · 产出"心理地图"：一句话 + 关键词标签
   ============================================================ */

const PS_OBJECTS = [
  // 人
  { cat: '人',     items: ['男人', '女人', '小孩', '老人', '孕妇', '军人', '僧侣', '医生'] },
  // 动物
  { cat: '动物',   items: ['狼', '狮子', '熊', '鹿', '兔子', '鸟', '蛇', '鱼'] },
  // 植物
  { cat: '植物',   items: ['大树', '小树', '花', '树桩', '草', '仙人掌'] },
  // 建筑
  { cat: '建筑',   items: ['房子', '城堡', '教堂', '学校', '桥', '门', '墙'] },
  // 自然
  { cat: '自然',   items: ['太阳', '月亮', '星星', '山', '河', '海', '云', '石头'] },
  // 抽象
  { cat: '抽象',   items: ['眼睛', '镜子', '钥匙', '书', '十字架', '心', '铃铛'] },
  // 危险
  { cat: '危险',   items: ['刀', '火', '子弹', '监狱', '血'] },
];
const PS_LOCATIONS = ['左上角', '左中', '左下角', '正上方', '中心', '正下方', '右上角', '右中', '右下角', '深埋在沙中'];

const PS_THERAPIST_QUESTIONS = [
  { key: 'feel', q: '你摆完这个沙盘的第一感受是什么？身体哪里先动起来？（胸口/喉咙/肚子/手…）' },
  { key: 'story', q: '如果这个沙盘有一个故事，故事开头的第一句是什么？不用管逻辑。' },
  { key: 'conflict', q: '沙盘里哪两样东西看起来最"紧张"或最"想靠近"？说说是哪两个。' },
  { key: 'absent', q: '看着整个沙盘，你希望里面再多一样什么？或哪一样本该在但其实不在？' },
  { key: 'close', q: '如果这个沙盘是你内心的今天，你想给它取什么名字？' },
];

export function openSandplay() {
  openDialog('dlg-sandplay');
  psTray = [];
  psTherapistState = null;
  document.getElementById('ps-scene-hint').value = '';
  document.getElementById('ps-object-grid').innerHTML = '';
  document.getElementById('ps-tray').innerHTML = '';
  document.getElementById('ps-result').style.display = 'none';
  document.getElementById('ps-result').innerHTML = '';
  document.getElementById('ps-therapist-log').innerHTML = '';
  document.getElementById('ps-therapist-current').innerHTML = '';
  document.getElementById('ps-therapist-answer').value = '';
  document.getElementById('ps-therapist-answer').style.display = 'none';
  document.getElementById('ps-therapist-answer').disabled = false;
  document.getElementById('ps-therapist-q').textContent = '';
  document.getElementById('ps-therapist-status').textContent = '';
  document.getElementById('ps-run-therapist').style.display = '';
  document.getElementById('ps-run-multi').style.display = '';
  document.getElementById('ps-undo-btn').style.display = 'none';
  document.getElementById('ps-status').textContent = '';
  renderPsObjectGrid();
  renderPsTray();
}

function renderPsObjectGrid() {
  const grid = document.getElementById('ps-object-grid');
  grid.innerHTML = '';
  PS_OBJECTS.forEach(group => {
    const div = document.createElement('div');
    div.className = 'ps-cat';
    div.innerHTML = `<div class="ps-cat-name">${group.cat}</div><div class="ps-cat-items"></div>`;
    const items = div.querySelector('.ps-cat-items');
    group.items.forEach(name => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ps-obj';
      btn.textContent = name;
      btn.dataset.name = name;
      btn.onclick = () => openPsPositionPicker(name).then(sel => {
        if (sel) { psTray.push(sel); renderPsTray(); }
      });
      items.appendChild(btn);
    });
    grid.appendChild(div);
  });
}

/** 弹出位置选择器，选定后写入沙盘 */
function openPsPositionPicker(objName) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'ps-pos-overlay';
    modal.innerHTML = `
      <div class="ps-pos-modal">
        <div class="ps-pos-title">你要把「${escapeHtml(objName)}」放在沙盘的哪里？</div>
        <div class="ps-pos-grid">
          ${PS_LOCATIONS.map((loc, i) => `<button type="button" class="ps-pos" data-loc="${escapeHtml(loc)}" data-i="${i}">${escapeHtml(loc)}</button>`).join('')}
        </div>
        <div class="ps-pos-hint">沙盘位置本身就是象征：中心=自我；深处=被压抑；边角=回避；成对出现=关系；孤立=孤独。</div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) { modal.remove(); resolve(null); return; }
      const btn = e.target.closest('.ps-pos');
      if (!btn) return;
      modal.remove();
      resolve({ objName, loc: btn.dataset.loc });
    });
  });
}

/** 当前沙盘状态（闭包内 module-level 变量：方便 undo） */
let psTray = [];

function renderPsTray() {
  const tray = document.getElementById('ps-tray');
  tray.innerHTML = '';
  if (!psTray.length) {
    tray.innerHTML = '<div class="ps-tray-empty">（沙盘是空的，从上方点物件放入）</div>';
    return;
  }
  psTray.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'ps-tray-row';
    row.innerHTML = `
      <span class="ps-tray-idx">${i + 1}</span>
      <span class="ps-tray-loc">${escapeHtml(item.loc)}</span>
      <span class="ps-tray-obj">${escapeHtml(item.objName)}</span>
      <button type="button" class="ps-tray-del" data-i="${i}" title="移除">✕</button>
    `;
    tray.appendChild(row);
  });
  tray.querySelectorAll('.ps-tray-del').forEach(btn => {
    btn.onclick = () => {
      const i = parseInt(btn.dataset.i, 10);
      psTray.splice(i, 1);
      renderPsTray();
    };
  });
}

/** 治疗师引导 —— 逐题推进 */
let psTherapistState = null;
async function runPsTherapist() {
  if (psTray.length < 3) { alert('请先至少摆 3 件物件'); return; }
  if (!isLlmConfigured(cfgHolder()?.cfg)) { alert('请先在右上角"设置"里配置 LLM。'); return; }

  const status = document.getElementById('ps-status');
  const log = document.getElementById('ps-therapist-log');
  const cur = document.getElementById('ps-therapist-current');
  const qEl = document.getElementById('ps-therapist-q');
  const ansInput = document.getElementById('ps-therapist-answer');
  const runBtn = document.getElementById('ps-run-therapist');
  runBtn.style.display = 'none';
  document.getElementById('ps-therapist-area').style.display = '';
  log.innerHTML = '';

  const sceneHint = document.getElementById('ps-scene-hint').value.trim();
  psTherapistState = {
    tray: [...psTray],
    sceneHint,
    qa: [],       // [{key, q, a}]
    step: 0,
  };

  try {
    while (psTherapistState.step < PS_THERAPIST_QUESTIONS.length) {
      const item = PS_THERAPIST_QUESTIONS[psTherapistState.step];
      cur.style.display = '';

      // 清理上一轮遗留：只保留 qEl + ansInput（保留引用）
      [...cur.querySelectorAll(':scope > .ps-therapist-preface')].forEach(n => n.remove());
      [...cur.querySelectorAll(':scope > .ps-therapist-ok')].forEach(n => n.remove());

      qEl.textContent = `${psTherapistState.step + 1}/${PS_THERAPIST_QUESTIONS.length} · 治疗师问：${item.q}`;
      ansInput.value = '';
      ansInput.style.display = '';
      ansInput.disabled = false;

      // 生成一段基于当前沙盘 + 已有对话的"治疗师旁白"
      const convo = psTherapistState.qa.map(x => `Q: ${x.q}\nA: ${x.a}`).join('\n\n');
      const preface = await chat({
        cfg: cfgHolder().cfg,
        messages: [
          { role: 'system', content: `你是 Jungian 沙盘游戏治疗师，正在引导来访者探索 TA 摆的沙盘。
沙盘内容：${psTray.map(x => `${x.objName} @ ${x.loc}`).join('；')}${sceneHint ? `\n来访者的场景提示：${sceneHint}` : ''}

请以简短、温和、不评判、不带结论的方式，用 2-3 句话向来访者"描述你看到的沙盘整体氛围"（不是提问，是叙述你感受到的东西）。用第一人称"我"。避免心理学术语，避免"作为AI"这类话术。120-180 字。` },
          { role: 'user', content: `之前的对话：\n${convo || '（还没开始）'}\n\n请描述你当下看到的沙盘整体氛围。` },
        ],
        temperature: 0.6,
        maxTokens: 400,
      });

      const prefaceText = preface.content || '（无）';
      // 插到 cur 最前面（preface → qEl → ansInput → okBtn）
      const prefaceDiv = document.createElement('div');
      prefaceDiv.className = 'ps-therapist-preface';
      prefaceDiv.innerHTML = renderMdLite(prefaceText);
      cur.insertBefore(prefaceDiv, qEl);

      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'ps-therapist-ok';
      okBtn.textContent = '继续 →';
      cur.appendChild(okBtn);

      // 等用户输入
      const ans = await new Promise((resolve) => {
        const done = () => {
          const v = ansInput.value.trim();
          if (!v) { alert('至少说几个字，或者写"跳过"'); return; }
          ansInput.disabled = true;
          ansInput.style.display = 'none';
          okBtn.disabled = true;
          okBtn.style.opacity = '0.5';
          resolve(v === '跳过' || v === 'skip' ? '（来访者沉默/跳过）' : v);
        };
        ansInput.onkeydown = (e) => { if (e.key === 'Enter') done(); };
        okBtn.onclick = done;
        ansInput.focus();
      });

      psTherapistState.qa.push({ key: item.key, q: item.q, a: ans });

      // 追加到 log
      const logItem = document.createElement('div');
      logItem.className = 'ps-therapist-turn';
      logItem.innerHTML = `
        <div class="ps-turn-q">🩺 治疗师：${escapeHtml(item.q)}</div>
        <div class="ps-turn-a">🧑 来访者：${escapeHtml(ans)}</div>
      `;
      log.appendChild(logItem);

      psTherapistState.step += 1;
    }
    // 5 问完成
    cur.style.display = '';
    cur.innerHTML = '<div class="ps-therapist-done">✅ 5 问完成，正在生成你的心理地图…</div>';

    // 生成最终"心理地图"
    status.textContent = '🗺 正在绘制你的心理地图…';
    const qaText = psTherapistState.qa.map(x => `Q: ${x.q}\nA: ${x.a}`).join('\n\n---\n\n');
    const trayText = psTray.map(x => `${x.objName}（${x.loc}）`).join('；');
    const r = await chat({
      cfg: cfgHolder().cfg,
      messages: [
        { role: 'system', content: `你是 Jungian 沙盘治疗师，请基于沙盘物件摆放 + 5 问问答，输出来访者的"心理地图"。

结构（严格按此输出，中文，400-650 字）：

**一句话意象**：用一句话描述这个沙盘整体的内在状态（不超过 20 字，如"一个带着旧钥匙的人站在没有门的墙前"）

**关键词标签**：5-8 个 tag（每个 2-4 字），涵盖：核心意象 / 情绪基调 / 内在冲突 / 潜在资源 / 隐藏诉求

**关系动力学**（100-150 字）：沙盘里的物件之间暗含什么关系？哪些在对峙、哪些在靠近、哪些孤立？

**未说出口的话**（80-120 字）：来访者通过这次摆放"表达"了什么但没直接说？

**下一步实验**：给来访者 1 条可以在真实生活里做的小行动（不是心理建议，是身体层面的具体行动，如"今晚睡前把这个物件从左手换到右手"）。

【约束】
- 不下诊断（不说"你有创伤""你焦虑"）
- 用"我看到/我注意到/我想到"这种观察式语言
- 不输出"作为AI"这类话术` },
        { role: 'user', content: `沙盘（按位置）：${trayText}${sceneHint ? `\n场景提示：${sceneHint}` : ''}\n\n=== 5 问对话 ===\n${qaText}` },
      ],
      temperature: 0.5,
      maxTokens: 1400,
    });

    const resultEl = document.getElementById('ps-result');
    resultEl.style.display = '';
    resultEl.innerHTML = `<div class="ps-map-title">🗺 你的心理地图</div>${renderMdLite(r.content || '（生成失败）')}`;
    document.getElementById('ps-iterate-inline').style.display = '';
    status.textContent = '';
  } catch (err) {
    status.textContent = `⚠ 出错：${err.message || err}`;
  } finally {
    runBtn.style.display = '';
  }
}

/** 多视角解读（4 视角并行） */
async function runPsMultiPerspective() {
  if (psTray.length < 3) { alert('请先至少摆 3 件物件'); return; }
  if (!isLlmConfigured(cfgHolder()?.cfg)) { alert('请先在右上角"设置"里配置 LLM。'); return; }

  const status = document.getElementById('ps-status');
  const runBtn = document.getElementById('ps-run-multi');
  runBtn.style.display = 'none';
  status.textContent = '🔮 4 个学派正在并行解读你的沙盘…';

  const sceneHint = document.getElementById('ps-scene-hint').value.trim();
  const trayText = psTray.map(x => `${x.objName}（${x.loc}）`).join('；');
  const perspectives = [
    { name: '荣格 · 集体无意识',   stance: '原型、阴影、自性、集体象征' },
    { name: '客体关系',           stance: '内部客体、依恋、内化关系' },
    { name: '家庭系统',           stance: '代际模式、三角化、循环' },
    { name: '认知图式',           stance: '早期适应不良图式、信念' },
  ];

  try {
    const results = await Promise.all(perspectives.map(async p => {
      const r = await chat({
        cfg: cfgHolder().cfg,
        messages: [
          { role: 'system', content: `你是从**${p.name}**看沙盘的治疗师。立场：${p.stance}。

【输出（严格按此，200-320 字）】
1. **核心象征**：从这个学派看，沙盘里最有诊断价值的 1-2 个物件是哪些？为什么？
2. **动力假设**：这个沙盘在"讲述"什么样的内在过程？
3. **一句反问**：给来访者留一个可以从这个学派出发的思考题。

约束：假设式语言（"可能""也许"），不做诊断，不用"作为AI"。` },
          { role: 'user', content: `沙盘（按位置）：${trayText}${sceneHint ? `\n场景提示：${sceneHint}` : ''}` },
        ],
        temperature: 0.65,
        maxTokens: 700,
      });
      return { ...p, content: r.content || '' };
    }));

    // 生成"多视角对比"
    status.textContent = '🌈 正在整合四视角…';
    const four = results.map(r => `【${r.name}】\n${r.content}`).join('\n\n---\n\n');
    const summaryR = await chat({
      cfg: cfgHolder().cfg,
      messages: [
        { role: 'system', content: `你是沙盘治疗工作坊主持人。请对比 4 个学派的解读，输出：

**共识**：四派都同意看到的物件或动力（1-2 条）
**分歧**：同一物件被不同学派赋予的不同含义（举 1-2 例）
**给来访者的 3 个选择**：三个方向不同的追问，来访者可以自选一个深聊
**保留意见**：哪个学派的解读证据最少、仅供参考

300-500 字。不代替来访者下结论。` },
        { role: 'user', content: `沙盘：${trayText}\n\n=== 四视角解读 ===\n${four}` },
      ],
      temperature: 0.5,
      maxTokens: 1200,
    });

    const resultEl = document.getElementById('ps-result');
    resultEl.style.display = '';
    let html = `<div class="ps-map-title">🌈 四视角解读</div>`;
    results.forEach(r => {
      html += `<div class="ps-view-card"><div class="ps-view-name">${escapeHtml(r.name)}</div><div class="ps-view-stance">${escapeHtml(r.stance)}</div><div class="ps-view-body">${renderMdLite(r.content)}</div></div>`;
    });
    html += `<div class="ps-view-summary">${renderMdLite(summaryR.content || '')}</div>`;
    resultEl.innerHTML = html;
    status.textContent = '';
  } catch (err) {
    status.textContent = `⚠ 出错：${err.message || err}`;
  } finally {
    runBtn.style.display = '';
  }
}

/** 沙盘迭代修改：告诉 AI 你改了什么，让它对比解读 */
async function runPsIterate() {
  if (!psTherapistState || !psTherapistState.qa.length) {
    alert('请先跑完一次"治疗师引导"，才能对比改动。');
    return;
  }
  const newHint = document.getElementById('ps-iterate-hint').value.trim();
  if (!newHint) { alert('请描述你这次改了什么（比如"我把城堡挪到中心，把狼换成了鹿"）'); return; }
  if (!isLlmConfigured(cfgHolder()?.cfg)) { alert('请先在右上角"设置"里配置 LLM。'); return; }

  const status = document.getElementById('ps-status');
  const resultEl = document.getElementById('ps-result');
  status.textContent = '🔁 正在对比改动前后的意义变化…';

  const trayText = psTray.map(x => `${x.objName}（${x.loc}）`).join('；');
  const qaText = psTherapistState.qa.map(x => `Q: ${x.q}\nA: ${x.a}`).join('\n');
  try {
    const r = await chat({
      cfg: cfgHolder().cfg,
      messages: [
        { role: 'system', content: `你是沙盘治疗师，来访者刚刚改动了沙盘。请对比：

1. **改动点识别**：TA 具体改了什么？（挪位置 / 换物件 / 加 / 删）
2. **改动的"心理含义"**：从 TA 的改动里，你能看出 TA 想让什么浮现、想让什么消失？
3. **一个反问**：给 TA 留一个能从这次改动继续深挖的问题
4. **注意**：如果改动很小或没有清晰动机，也如实说"我看不到明显动机，请 TA 告诉我为什么改"

150-250 字。不用术语，不下诊断。` },
        { role: 'user', content: `改动前的沙盘问答（作为参考）：\n${qaText}\n\n改动后的沙盘：${trayText}\n\n来访者自述的改动：「${newHint}」` },
      ],
      temperature: 0.55,
      maxTokens: 700,
    });
    resultEl.style.display = '';
    resultEl.innerHTML = `<div class="ps-map-title">🔁 改动前后对比</div>${renderMdLite(r.content || '')}`;
    status.textContent = '';
  } catch (err) {
    status.textContent = `⚠ 出错：${err.message || err}`;
  }
}

/* ============================================================
   场景 ⑤ 结束
   ============================================================ */

/* ============================================================
   场景路由
   ------------------------------------------------------------
   供 tools.js 主路由调用：scenes.openByMode(mode)
   ============================================================ */
export function openByMode(mode) {
  switch (mode) {
    case 'drama':   return openDramaSandbox();
    case 'ethics':  return openEthicsDilemma();
    case 'dream':   return openDreamWorkshop();
    case 'coach':   return openDialogCoach();
    case 'sandplay':return openSandplay();
    default:        return false;
  }
}

/* 导出供外部事件绑定 */
export const SCENE_RUNNERS = {
  drama:   runDramaSandbox,
  ethics:  runEthicsDilemma,
  dream:   runDreamWorkshop,
  coach:   runDialogCoach,
};
export function bindSceneEvents() {
  // 关闭按钮：统一处理所有场景 dialog
  const closeMap = {
    'btn-ds-close': 'dlg-drama',
    'btn-ed-close': 'dlg-ethics',
    'btn-dw-close': 'dlg-dream',
    'btn-dc-close': 'dlg-coach',
    'btn-ps-close': 'dlg-sandplay',
  };
  Object.entries(closeMap).forEach(([btnId, dlgId]) => {
    document.getElementById(btnId)?.addEventListener('click', () => closeDialog(dlgId));
  });
  // 执行按钮：直接绑定到各自 runner
  const runMap = {
    'ds-run-btn':   runDramaSandbox,
    'ed-run-btn':   runEthicsDilemma,
    'dw-run-btn':   runDreamWorkshop,
    'dc-run-btn':   runDialogCoach,
    'ps-run-therapist': runPsTherapist,
    'ps-run-multi':     runPsMultiPerspective,
    'ps-run-iterate':   runPsIterate,
    'ps-reset-btn':     () => { psTray = []; psTherapistState = null; renderPsTray(); document.getElementById('ps-result').style.display = 'none'; document.getElementById('ps-result').innerHTML = ''; document.getElementById('ps-therapist-area').style.display = 'none'; document.getElementById('ps-therapist-log').innerHTML = ''; document.getElementById('ps-therapist-current').innerHTML = ''; document.getElementById('ps-therapist-current').style.display = 'none'; document.getElementById('ps-therapist-q').textContent = ''; document.getElementById('ps-therapist-answer').value = ''; document.getElementById('ps-therapist-answer').style.display = 'none'; document.getElementById('ps-therapist-answer').disabled = false; document.getElementById('ps-iterate-inline').style.display = 'none'; document.getElementById('ps-status').textContent = ''; },
  };
  Object.entries(runMap).forEach(([btnId, runner]) => {
    document.getElementById(btnId)?.addEventListener('click', runner);
  });
  // 沙盘物件的 onclick 已直接绑定在 renderPsObjectGrid 里，不再需要 grid 事件委托
  // 重新抽签 / 再来一次
  document.getElementById('ed-redraw-btn')?.addEventListener('click', openEthicsDilemma);
  document.getElementById('ds-restart-btn')?.addEventListener('click', openDramaSandbox);
  // 遮罩点击关闭
  ['dlg-drama', 'dlg-ethics', 'dlg-dream', 'dlg-coach', 'dlg-sandplay'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', (e) => {
      if (e.target === el) closeDialog(id);
    });
  });
}
