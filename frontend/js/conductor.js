/* ============================================================
   conductor.js —— 编排者「知微」
   ------------------------------------------------------------
   类似豆包的交互：每次用户发言先到编排者，
   编排者做轻量分类：
     - self       : 编排者自己答（闲聊/入门/综合视角）
     - psych.PSY  : 转给具体心理学家 agent
     - school.SCH : 转给学派 agent
     - counselor  : 转给 counselor.js 的 7 阶段咨询流程
     - crisis     : 立即展示危机提示，同时咨询流程兜底

   分类方式：LLM 一次调用（temp=0，JSON 输出）；失败或空 apiKey
   时回落规则路由（ruleRoute）。
   ============================================================ */

import { Agent } from './agent.js';
import { chat } from './llm.js';
import * as counselor from './counselor.js';
import { psychologistById, schoolById } from './ontology.js';

export const CONDUCTOR_ID = 'conductor';
export const CONDUCTOR_NAME = '知微';
export const CONDUCTOR_EN = 'Conductor';

export const CONDUCTOR_SYSTEM_PROMPT =
  '你是 Psychology Agent 的编排者，中文名"知微"（Conductor）。\n' +
  '你是一位资深的心理学综合研究者，融汇各学派主要观点，同时能协调 32 个学派专家、78 位心理学家专家。\n\n' +
  '【身份与语气】\n' +
  '· 温和、清醒、有边界感，不套近乎，也不冷冰冰\n' +
  '· 用"你"称呼用户，自称"我"；简短直接，不灌水\n' +
  '· 中文为主，专业术语首次出现给英文\n\n' +
  '【回答原则】\n' +
  '1) 综合多个流派观点时使用对比式表达："精神分析视角看…而人本主义视角看…"\n' +
  '2) 不越界给医学诊断、不做心理咨询式深度共情、不扮演特定历史人物的完整人格\n' +
  '3) 涉及自伤/自杀等急性危机：先做安全提示、给出危机热线（北京 010-82951332 / 全国 12355），再考虑回答\n' +
  '4) 结尾常用一句温和、开放式的追问，把话头递回用户\n\n' +
  '【边界】\n' +
  '· 用户明确问"某位心理学家/某学派怎么看"时，编排者不做主答，交给对应专家；\n' +
  '· 用户情绪波动较大、明显在寻求安慰/倾诉时，交给咨询流程；\n' +
  '· 闲聊、入门科普、综合对比、术语解释、方法推荐 → 你直接答。';

/**
 * 编排者入口：接收用户消息 → 分类 → 路由 → 返回结构化结果
 * @param {{
 *   cfg: object,
 *   userText: string,
 *   history: Array<{role:string, content:string}>,
 *   ui: object,
 *   ontology: object,
 *   registry: Map<string, Agent>,
 *   llm: object,
 * }} ctx
 * @returns {{
 *   route: 'self'|'counselor'|'psych.<id>'|'school.<id>'|'crisis',
 *   reply: string,
 *   handoff?: string,
 *   targetName?: string,
 *   meta?: object,
 *   decision: object,
 * }}
 */
export async function runConductor(ctx) {
  const { cfg, userText, history = [], ui, llm, signal } = ctx;

  // 阶段 1：分类
  const decision = await classifyIntent({ cfg, userText, history, llm, signal });

  // 分类里出现 crisis：先出危机提示，同时让咨询流程兜底
  if (decision.route === 'crisis') {
    ui?.onRoute?.({ ...decision, intent: 'crisis' });
    return await runCounselorBranch(ctx, decision, { crisisFlagged: true });
  }

  // 阶段 2：按分类结果路由
  switch (decision.route) {
    case 'self':
      ui?.onRoute?.(decision);
      return await runSelfReply(ctx, decision);
    case 'counselor':
      ui?.onRoute?.({ ...decision, intent: 'counseling' });
      return await runCounselorBranch(ctx, decision, {});
    case 'psych': {
      if (!decision.psychologist_id) {
        return await runSelfReply(ctx, { ...decision, route: 'self', reason: decision.reason + '（未给出心理学家编号，回退自答）' });
      }
      ui?.onRoute?.({ ...decision, intent: 'learning' });
      return await runExpertBranch(ctx, 'psych', decision.psychologist_id, decision);
    }
    case 'school': {
      if (!decision.school_id) {
        return await runSelfReply(ctx, { ...decision, route: 'self', reason: decision.reason + '（未给出学派编号，回退自答）' });
      }
      ui?.onRoute?.({ ...decision, intent: 'learning' });
      return await runExpertBranch(ctx, 'school', decision.school_id, decision);
    }
    default:
      ui?.onRoute?.(decision);
      return await runSelfReply(ctx, decision);
  }
}

/* ------------------------------------------------------------ */
/* 分类：LLM 优先，规则兜底 */
/* ------------------------------------------------------------ */

async function classifyIntent({ cfg, userText, history, llm, signal }) {
  if (cfg?.llm?.apiKey && llm?.chat) {
    try {
      const msgs = [
        {
          role: 'system',
          content:
            '你是心理 Agent 的意图分类器。输出严格 JSON（不含 ``` 包裹）：\n' +
            '{"route":"self|crisis|counselor|psych|school",' +
            '"psychologist_id":"PSYxxx" 或 null,' +
            '"school_id":"SCHxx" 或 null,' +
            '"reason":"≤30 字"}\n\n' +
            '判定规则：\n' +
            '1. 出现自杀/自伤/想死/活着没意思等危机信号 → crisis\n' +
            '2. 明显在倾诉情绪、请求安慰/被听见（难过/焦虑/失眠/想哭/关系困扰/工作压力等）→ counselor\n' +
            '3. 明确点名某位心理学家或学派（"荣格怎么看"、"CBT 核心"、"精神分析视角"）→ psych 或 school，给出对应编号\n' +
            '4. 其他（闲聊、入门科普、术语解释、综合对比）→ self\n' +
            '编号规范：psychologist_id=PSY001..PSY078；school_id=SCH01..SCH32。不确定就 null。',
        },
        ...history.slice(-4).map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: userText },
      ];
      const { content } = await llm.chat({ cfg, messages: msgs, temperature: 0, maxTokens: 400, stream: false, signal });
      const parsed = tryParseJson(content);
      if (parsed && typeof parsed === 'object' && parsed.route) {
        return normalizeDecision(parsed);
      }
    } catch (e) {
      // 主动打断 → 让中断冒泡，不回落规则路由
      if (e?.name === 'AbortError') throw e;
      console.warn('[conductor] LLM 分类失败，回落规则：', e?.message);
    }
  }
  return ruleRoute(userText);
}

function normalizeDecision(d) {
  const route = String(d.route || '').toLowerCase();
  const out = { route: 'self', reason: d.reason || '', school_id: null, psychologist_id: null };
  if (['self', 'crisis', 'counselor', 'psych', 'school'].includes(route)) out.route = route;
  if (d.psychologist_id) out.psychologist_id = String(d.psychologist_id).toUpperCase();
  if (d.school_id) out.school_id = String(d.school_id).toUpperCase();
  return out;
}

function ruleRoute(text) {
  const t = String(text || '');
  // 危机优先
  if (/(想死|想自杀|自杀|自伤|割腕|跳楼|结束生命|活不下去|活着没意思|没有意义活下去|不想到明天|不想再撑|自残|自我伤害)/.test(t)) {
    return { route: 'crisis', reason: '检测到危机信号' };
  }
  // 咨询类（情绪倾诉）
  if (/(焦虑|抑郁|失眠|崩溃|想哭|难过|痛苦|愤怒|嫉妒|失落|压力太大|睡不着|撑不下去|被欺负|失恋|离婚|裁员|被批评|想家|孤单|孤独|没意思|空虚)/.test(t)) {
    return { route: 'counselor', reason: '疑似情绪倾诉' };
  }
  // 心理学家
  const psychoMap = [
    [/荣格|analytical psychology|集体无意识/, 'PSY002'],
    [/弗洛伊德|精神分析|潜意识|梦的解析/, 'PSY001'],
    [/拉康/, 'PSY003'],
    [/维特克/, 'PSY004'],
    [/华生/, 'PSY005'],
    [/斯金纳/, 'PSY006'],
    [/罗杰斯|人本主义|自我实现|无条件积极/, 'PSY007'],
    [/马斯洛/, 'PSY008'],
    [/艾利斯|REBT|ABC/, 'PSY009'],
    [/贝克|认知行为|CBT|贝克抑郁/, 'PSY010'],
    [/亚隆/, 'PSY011'],
    [/皮亚杰|认知发展/, 'PSY012'],
    [/埃里克森|identity crisis/, 'PSY013'],
    [/鲍尔比|依恋/, 'PSY014'],
  ];
  for (const [re, id] of psychoMap) {
    if (re.test(t)) return { route: 'psych', psychologist_id: id, reason: `匹配心理学家 ${id}` };
  }
  // 学派
  const schoolMap = [
    [/精神分析/, 'SCH01'],
    [/行为主义|行为疗法/, 'SCH02'],
    [/人本主义/, 'SCH03'],
    [/认知行为|CBT|REBT|ACT|接纳承诺/, 'SCH04'],
    [/存在主义/, 'SCH05'],
    [/家庭治疗|系统治疗/, 'SCH07'],
    [/发展心理/, 'SCH10'],
    [/人格/, 'SCH11'],
  ];
  for (const [re, id] of schoolMap) {
    if (re.test(t)) return { route: 'school', school_id: id, reason: `匹配学派 ${id}` };
  }
  return { route: 'self', reason: '未匹配到专业路由，编排者自答' };
}

function tryParseJson(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  const stripped = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(stripped); } catch { return null; }
}

/* ------------------------------------------------------------ */
/* 各路由分支 */
/* ------------------------------------------------------------ */

/** 编排者自己回答（闲聊/入门/综合对比） */
async function runSelfReply(ctx, decision) {
  const { cfg, userText, history, ui, llm, signal } = ctx;
  const messages = [
    { role: 'system', content: CONDUCTOR_SYSTEM_PROMPT },
    ...history.slice(-8).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText },
  ];
  const r = await llm.chat({
    cfg, messages,
    onDelta: (d, f) => ui?.onToken?.(d, f),
    onReasoning: (d, f) => ui?.onReasoning?.(d, f),
    temperature: 0.55,
    maxTokens: 4000,
    signal,
  });
  return { route: 'self', reply: r.content, decision };
}

/** 转给具体心理学家 / 学派 agent */
async function runExpertBranch(ctx, kind, id, decision) {
  const { registry, ui } = ctx;
  const agentKey = `${kind}.${id}`;
  const agent = registry?.get(agentKey);

  // 解析目标名字
  let targetName = '';
  let targetSubtitle = '';
  if (kind === 'psych') {
    const p = psychologistById(id);
    targetName = p?.name_zh || p?.name_en || id;
    targetSubtitle = p?.name_en ? `· ${p.name_en}` : '';
  } else {
    const s = schoolById(id);
    targetName = s?.name_zh || s?.name_en || id;
    targetSubtitle = s?.name_en ? `· ${s.name_en}` : '';
  }

  // 生成一句短手递短语
  const handoff = buildHandoff(kind, targetName, decision.reason);

  if (!agent) {
    return {
      route: `unknown:${agentKey}`,
      handoff,
      targetName,
      reply: `未能找到对应的专家（${agentKey}），我先直接回答你。若需要更深入的讨论，请尝试用更具体的名字或学派。`,
      decision,
    };
  }

  // 先推送 handoff 作为"编排者的一句话"，让对话读起来连贯
  if (handoff) ui?.onHandoff?.(handoff);

  const result = await agent.run(ctx);
  return {
    route: agentKey,
    handoff,
    targetName,
    targetSubtitle,
    reply: result.reply || result.content || '',
    decision,
    meta: result.meta,
  };
}

/** 转给咨询流程（counselor.js） */
async function runCounselorBranch(ctx, decision, extra = {}) {
  const { cfg, userText, ui, signal } = ctx;
  const caseObj = counselor.getCurrentCaseOrNew();
  const historyForModel = caseObj.messages.map(m => ({ role: m.role, content: m.content }));

  if (decision.reason) ui?.onHandoff?.('这个问题偏情绪倾诉，我先按咨询流程陪你走一段。');

  const result = await counselor.counselorReply({
    cfg,
    userText,
    caseObj,
    history: historyForModel.slice(0, -1),
    onDelta: (d, f) => ui?.onToken?.(d, f),
    onReasoning: (d, f) => ui?.onReasoning?.(d, f),
    signal,
  });

  return {
    route: 'counselor',
    reply: result.reply,
    targetName: '咨询流程',
    decision,
    counselorResult: result,
    ...extra,
  };
}

/** 生成一句编排者口吻的短"手递"（不超过 30 字） */
function buildHandoff(kind, targetName, reason) {
  if (kind === 'psych') {
    return `这个问题涉及 ${targetName} 的核心思想，我请 TA 直接回应你。`;
  }
  if (kind === 'school') {
    return `这是 ${targetName} 学派的核心议题，我请这个学派的专家来答。`;
  }
  if (kind === 'crisis') return '我先陪你稳定下来。';
  return '';
}
