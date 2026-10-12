/* ============================================================
   counselor.js —— 心理咨询师完整流程引擎
   ------------------------------------------------------------
   把单次 LLM 问答升级为一个多阶段、有记忆、有转场的咨询流程。
   参考标准心理咨询 8 阶段模型：

     1. Intake        建立关系 / 知情同意
     2. Assessment    评估与理解
     3. GoalSetting   目标制定
     4. Intervention  干预工作
     5. Review        阶段回顾
     6. Homework      布置作业
     7. Termination   结束咨询
     8. FollowUp      跟进
   ------------------------------------------------------------
   会话状态存 localStorage，跨刷新/新标签页保留；每次消息驱动一次
   state machine 步进。用户随时可以说 "重新开始咨询" 强制回到 Intake。
   ============================================================ */

import { chat } from './llm.js';

const K_CASES = 'psychics.cases.v1';
const K_CURRENT_CASE = 'psychics.current_case.v1';

export const STAGES = [
  { id: 'intake',       label: '建立关系',    icon: '🤝', color: '#7c5cff' },
  { id: 'assessment',   label: '评估理解',    icon: '🔍', color: '#4dd4ff' },
  { id: 'goal_setting', label: '目标制定',    icon: '🎯', color: '#ffb454' },
  { id: 'intervention', label: '干预工作',    icon: '💡', color: '#66e39d' },
  { id: 'review',       label: '阶段回顾',    icon: '📋', color: '#c084fc' },
  { id: 'homework',     label: '作业跟进',    icon: '📝', color: '#ff7c9c' },
  { id: 'termination',  label: '结束咨询',    icon: '🎓', color: '#f5b94c' },
];

export function getStage(id) { return STAGES.find(s => s.id === id); }

/* ------------------------------------------------------------ */
/* 会话持久化 */
/* ------------------------------------------------------------ */

export function listCases() {
  try {
    const raw = localStorage.getItem(K_CASES);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function currentCaseId() { return localStorage.getItem(K_CURRENT_CASE) || ''; }

export function getCurrentCase() {
  const id = currentCaseId();
  return listCases().find(c => c.id === id) || null;
}

export function newCase(clientId) {
  const id = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
  const nowIso = new Date().toISOString();
  const c = {
    id,
    clientId: clientId || '',
    createdAt: nowIso,
    updatedAt: nowIso,
    stage: 'intake',
    sessionCount: 1,
    messages: [],      // 与当前 case 绑定的对话（不是全局 messages）
    clientInfo: {
      name: '',
      age: null,
      context: '',       // 背景
      concerns: [],      // 主诉
    },
    goals: [],           // 咨询目标
    interventions: [],   // 已使用的干预
    assessments: [],     // 阶段评估记录
    summaries: [],       // 每次结束时的总结
    homework: [],
    safety: {
      riskFlag: null,    // null | 'low' | 'medium' | 'high'
      hotlineNotified: false,
    },
  };
  const arr = listCases();
  arr.unshift(c);
  localStorage.setItem(K_CASES, JSON.stringify(arr));
  localStorage.setItem(K_CURRENT_CASE, id);
  return c;
}

export function getCurrentCaseOrNew() {
  const cur = getCurrentCase();
  if (cur) return cur;
  return newCase();
}

export function advanceStage(caseObj, next, meta = {}) {
  const curIdx = STAGES.findIndex(s => s.id === caseObj.stage);
  const nextIdx = STAGES.findIndex(s => s.id === next);
  if (nextIdx < 0) return false;
  caseObj.updatedAt = new Date().toISOString();
  caseObj.stage = next;
  caseObj.advancedAt = new Date().toISOString();
  caseObj.advancedMeta = meta;
  persist(caseObj);
  return true;
}

export function resetToIntake() {
  const cur = getCurrentCase();
  if (!cur) return null;
  cur.stage = 'intake';
  cur.sessionCount += 1;
  cur.updatedAt = new Date().toISOString();
  persist(cur);
  return cur;
}

function persist(caseObj) {
  const arr = listCases();
  const i = arr.findIndex(c => c.id === caseObj.id);
  if (i >= 0) arr[i] = caseObj;
  localStorage.setItem(K_CASES, JSON.stringify(arr));
}

export function appendCaseMessage(caseObj, msg) {
  caseObj.messages.push({ role: msg.role, content: msg.content, at: new Date().toISOString() });
  persist(caseObj);
}

/* ------------------------------------------------------------ */
/* 危机/风险检测 */
/* ------------------------------------------------------------ */

const RISK_KW = [
  '不想活', '想死', '自杀', '结束生命', '自伤', '割腕', '跳楼',
  '割开', '服药自杀', '活着没意思', '没有意义了',
  '撑不下去', '撑不住了', '完全崩溃', '彻底放弃',
];

export function detectRisk(text) {
  const t = String(text || '');
  if (/不想活|想死|自杀|结束生命|跳楼|服药自杀|割腕|割开|活着没意思|没有意义了/.test(t)) return 'high';
  if (/自伤|撑不下去|撑不住|完全崩溃|彻底放弃/.test(t)) return 'medium';
  if (RISK_KW.some(k => t.includes(k))) return 'medium';
  return null;
}

/* ------------------------------------------------------------ */
/* 阶段转场检测（基于用户输入的模式识别） */
/* ------------------------------------------------------------ */

function detectStageTransition(caseObj, userText) {
  const t = String(userText || '');
  const stage = caseObj.stage;

  // Intake → Assessment
  if (stage === 'intake') {
    if (/继续|往下|好吧|嗯|可以|好的|开始/.test(t) && t.length < 30) {
      return 'assessment';
    }
    if (/我想咨询|我最近|我最近遇到|最近压力|我很焦虑|我最近感觉/.test(t)) {
      return 'assessment';
    }
  }

  // Assessment → GoalSetting
  if (stage === 'assessment') {
    if (caseObj.messages.filter(m => m.role === 'user').length >= 3
        && /想改善|想变|希望|我的目标|我想达到|我想变得/.test(t)) return 'goal_setting';
    if (/可以了|差不多了|够了|就这样|进入目标|我们谈目标/.test(t)) return 'goal_setting';
  }

  // GoalSetting → Intervention
  if (stage === 'goal_setting') {
    if (/开始干预|我们试试|我们开始|试试这个方法|我们做吧|好，我们/.test(t)) return 'intervention';
    if (/就这样|好的|可以|行|嗯/.test(t) && t.length < 20) return 'intervention';
  }

  // Intervention → Review
  if (stage === 'intervention') {
    if (/回顾|总结|进展|我们做到了什么|现在感觉/.test(t)) return 'review';
    if (caseObj.messages.filter(m => m.role === 'user').length >= 8) return 'review';
    if (/差不多了|可以收工|今天就到这里|下次/.test(t)) return 'review';
  }

  // Review → Homework
  if (stage === 'review') {
    if (/作业|下次|回家|行动|去做|练习/.test(t)) return 'homework';
    if (/好|嗯|可以|知道/.test(t) && t.length < 15) return 'homework';
  }

  // Homework → Termination
  if (stage === 'homework') {
    if (/结束|告别|下次再见|下次继续|下次聊/.test(t)) return 'termination';
    if (/谢谢|感谢/.test(t) && /下次|再见|结束/.test(t)) return 'termination';
  }

  return null;
}

/* ------------------------------------------------------------ */
/* 咨询师提示词 */
/* ------------------------------------------------------------ */

function buildCounselorSystemPrompt(caseObj) {
  const stage = getStage(caseObj.stage);
  const stageIdx = STAGES.findIndex(s => s.id === caseObj.stage);
  const nextStage = STAGES[stageIdx + 1] || null;
  const prevMessages = caseObj.messages.slice(-10).map(m =>
    `【${m.role === 'user' ? '来访者' : '咨询师'}】${m.content}`
  ).join('\n');

  const infoLines = [];
  if (caseObj.clientInfo.name) infoLines.push(`- 名字：${caseObj.clientInfo.name}`);
  if (caseObj.clientInfo.age) infoLines.push(`- 年龄：${caseObj.clientInfo.age}`);
  if (caseObj.clientInfo.context) infoLines.push(`- 背景：${caseObj.clientInfo.context}`);
  if (caseObj.clientInfo.concerns.length) infoLines.push(`- 主诉：${caseObj.clientInfo.concerns.join('；')}`);
  if (caseObj.goals.length) infoLines.push(`- 咨询目标：${caseObj.goals.map((g, i) => `${i + 1}. ${g}`).join(' · ')}`);
  if (caseObj.interventions.length) infoLines.push(`- 已用干预：${caseObj.interventions.join('、')}`);
  if (caseObj.homework.length) infoLines.push(`- 当前作业：${caseObj.homework[caseObj.homework.length - 1]}`);

  const caseInfo = infoLines.length ? infoLines.join('\n') : '- （首次来访，尚无档案）';

  // 每阶段的核心咨询行为
  const stageGuide = {
    intake: [
      '1. 用温暖、非评判的语气自我介绍，说明"这里是一个安全的空间"',
      '2. 明确告知：我是一个 AI 心理咨询助手，不是医学诊断，遇到危机请寻求专业帮助（北京 010-82951332 / 全国 12355）',
      '3. 询问来访者的基本信息与来意："可以告诉我你希望怎样称呼自己吗？最近是什么让你决定来聊聊？"',
      '4. 全程使用开放式提问、共情回应，不超过 200 字',
      '5. 结束时给一个明确的下一步建议：进入评估',
    ],
    assessment: [
      '1. 使用"5W1H 框架"温和地了解问题：What（发生了什么）· When（什么时候开始）· Where（在哪方面）· Who（涉及谁）· Why（你觉得原因）· How（对你的影响）',
      '2. 每轮只聚焦 1-2 个问题，避免审问式提问',
      '3. 使用反射式共情："听起来你在经历…"',
      '4. 收集到足够信息后（通常 2-3 轮），进入目标制定',
    ],
    goal_setting: [
      '1. 把来访者的模糊困扰转化为具体、可衡量、可实现的目标（SMART）',
      '2. 使用人本主义"以人为中心"技术：把目标描述成来访者想成为的样子',
      '3. 让来访者自己复述目标，确保双方理解一致',
      '4. 目标不超过 3 个，避免贪多',
    ],
    intervention: [
      '1. 根据来访者的具体问题，从主流方法中选择最合适的一种或几种：',
      '   - ABC 理论（艾利斯 REBT）：识别并辩驳不合理信念',
      '   - CBT（贝克）：识别扭曲思维，做行为实验',
      '   - 认知重构、正念（MBSR）、暴露疗法、接纳承诺（ACT）',
      '   - 家庭系统观、依恋视角',
      '2. 使用"两步共情"技术：先承认情绪，再提供工具',
      '3. 每次提供 1-2 个可执行练习，让来访者能立刻做',
      '4. 保持对话感，避免一次输出过多结构化内容',
    ],
    review: [
      '1. 与来访者一起回顾本次咨询的进展',
      '2. 询问主观感受："你现在感觉怎么样？有没有比刚开始好一点点？"',
      '3. 强化来访者已经做的努力，指出具体变化',
      '4. 检查目标完成度',
    ],
    homework: [
      '1. 布置 1-2 个具体的家庭作业，让来访者能在下一次咨询前完成',
      '2. 作业要小到可以当天开始（如"记一次自动思维"、"每天 10 分钟正念"）',
      '3. 说明作业的目的和预期感受',
    ],
    termination: [
      '1. 温和地祝贺来访者这段时间的进展',
      '2. 总结这次咨询的核心收获',
      '3. 提供"当情绪回来时怎么办"的应急预案',
      '4. 感谢来访者的信任与投入',
      '5. 明确说明：AI 咨询不是永久替代，需要时可以再来',
    ],
  }[caseObj.stage] || [];

  const safetySection = caseObj.safety.riskFlag
    ? `\n【安全状态】检测到${caseObj.safety.riskFlag === 'high' ? '高风险' : '中等风险'}信号。请：1) 立即表达关心与不评判；2) 明确提供危机热线（北京 010-82951332 / 全国 12355）；3) 不做诊断、不给具体方法；4) 优先建立联系与陪伴感。`
    : '';

  return `你是"Psychics"的心理咨询师，正在进行一场**第 ${caseObj.sessionCount} 次**、**${stage.label}（${stage.id}）**阶段的咨询对话。${nextStage ? `\n下一目标阶段：${nextStage.label}。` : ''}

【你的角色】
- 专业、温暖、不评判、耐心
- 你不是医学诊断者，不做精神疾病诊断
- 你不是治疗者，你提供支持、洞察、可执行工具
- 你严格基于主流心理学流派（人本主义、CBT、REBT、ACT、正念、依恋、家庭系统）

【来访者档案】
${caseInfo}

【当前对话片段】
${prevMessages || '（首次见面，尚无对话）'}

【当前阶段的核心任务】
${stageGuide.map(g => '\n' + g).join('')}

【核心原则】
- 使用简洁的中文，每次回复 150-350 字为宜
- 至少包含 1 个开放式提问以推进对话
- 先共情后指导（Empathy before Advice）
- 不要输出 markdown 标题超过二级（###）
- 不要输出超过 3 个选项的菜单
- 每次回复末尾给一个明确的下一步
${safetySection}

【输出】
直接给出咨询师的回复，不要输出分析过程、不要输出"作为咨询师"这类元话术。你就是咨询师。`;
}

/* ------------------------------------------------------------ */
/* 处理用户输入 → 咨询师回复 */
/* ------------------------------------------------------------ */

export async function counselorReply({ cfg, userText, caseObj: caseArg, onDelta, onReasoning, ui, signal }) {
  let caseObj = caseArg || getCurrentCaseOrNew();
  const messagesBefore = [...caseObj.messages];

  appendCaseMessage(caseObj, { role: 'user', content: userText });

  const risk = detectRisk(userText);
  if (risk) {
    caseObj.safety.riskFlag = risk;
    if (risk === 'high' && !caseObj.safety.hotlineNotified) {
      caseObj.safety.hotlineNotified = true;
    }
    persist(caseObj);
  }

  const stageBefore = caseObj.stage;
  const nextStage = detectStageTransition(caseObj, userText);
  if (nextStage && nextStage !== caseObj.stage) {
    advanceStage(caseObj, nextStage);
  }

  const sysPrompt = buildCounselorSystemPrompt(caseObj);

  const msgs = [
    { role: 'system', content: sysPrompt },
    ...messagesBefore.slice(-8).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText },
  ];

  const t0 = performance.now();
  // 咨询回复需要更长空间（150-350 字 + SenseNova reasoning 消耗）
  let accumulated = '';
  const r = await chat({ cfg, messages: msgs, onDelta: (d, f) => { accumulated = f; onDelta?.(d, f); }, onReasoning, temperature: 0.5, maxTokens: 4000, signal });
  const elapsedMs = performance.now() - t0;

  appendCaseMessage(caseObj, { role: 'assistant', content: r.content || accumulated });

  return {
    reply: r.content,
    reasoning: r.reasoning || '',
    meta: {
      routedTo: 'counselor',
      stage: caseObj.stage,
      stageBefore,
      stageAdvanced: nextStage ? { from: stageBefore, to: nextStage } : null,
      risk: risk || null,
      elapsedMs,
      model: cfg?.llm?.model,
    },
    case: caseObj,
  };
}
